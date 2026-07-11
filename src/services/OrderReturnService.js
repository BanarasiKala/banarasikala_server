/**
 * OrderReturnService
 *
 * Single source of truth for customer return & exchange requests.
 *
 * Both customer entry points funnel through here so behaviour is identical
 * regardless of which screen the request came from:
 *   - OrderItemActionController.create        (per-item, MyOrders detail / OrderConfirmation)
 *   - ShipRocketController.createReturn/Exchange (whole-order, MyOrders list)
 *
 * Responsibilities:
 *   - Eligibility: delivered + within the return window, one reverse flow per order.
 *   - Per-item action rows in `order_item_actions` with quantity accounting
 *     (pending_action_quantity) so the admin queue and quantity columns stay correct.
 *   - A single refund row using one refund formula (net of forward + reverse shipping).
 *   - Post-commit, best-effort ShipRocket reverse-pickup booking.
 *
 * DB mutations happen inside the caller's transaction. The ShipRocket HTTP call is
 * deliberately performed AFTER commit (finalizeReverseActions) so a slow/failing
 * courier API never holds a DB transaction open or rolls back a valid request.
 */
const { Op } = require('sequelize');
const OrderItemAction = require('../models/OrderItemAction');
const OrderRefund = require('../models/OrderRefund');
const Shipment = require('../models/Shipment');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const ReturnRequest = require('../models/ReturnRequest');
const ReturnItem = require('../models/ReturnItem');
const OrderAddress = require('../models/OrderAddress');
const OrderLedger = require('../models/OrderLedger');
const Coupon = require('../models/Coupon');
const { deriveOrderTotals } = require('./orderLedgerService');
const ShipRocketService = require('./ShipRocketService');
const WalletService = require('./WalletService');
const {
  ACTION_TYPES,
  ACTION_STATUS,
  getActionableQuantity,
  calculateItemAction,
  statusForRequestedAction,
  isDeliveredEnoughForPostDeliveryAction,
  roundMoney,
} = require('../utils/orderItemActions');
const { REFUND_TYPE, REFUND_STATUS, REFUND_PAYMENT_METHOD } = require('../utils/orderTransactions');
const {
  SHIPMENT_TYPE, SHIPMENT_STATUS, RETURN_TYPE, RETURN_STATUS, ACTOR,
} = require('../utils/orderModelV2');
const { config } = require('../config/env');

// Fallback pickup cost when the live courier lookup fails: the latest forward
// shipment's rate card. The original (forward) delivery is never adjusted.
const reverseChargeFromShipment = (shipment) => {
  const d = shipment?.selected_courier_data || {};
  const candidate = [d.freight_charge, d.rate, d.shipping_charge, d.charge].find((v) => Number(v) > 0);
  return roundMoney(Number(candidate) || Number(shipment?.forward_charge) || 0);
};

// Per-unit weight for a return: product weight (snapshotted per item in
// shipping_meta at checkout — see allocateItemShipping in OrderController)
// plus box weight. This is the SAME basis the forward delivery charge was
// quoted on, so both the return pickup rate quote AND the real ShipRocket
// return-order weight declaration match what the customer was shown, instead
// of understating the parcel with a box-weight-only figure.
// Defensive: orders placed before the grams→kg fix snapshotted product_weight_kg in
// GRAMS (a 450g saree stored as "450"), which made the pickup-rate lookup quote against
// a 450 KG parcel and swallow the entire refund. Anything above this threshold cannot be
// a real per-unit product weight, so treat it as grams — same heuristic the storefront
// and getProductWeightKg use.
const GRAMS_THRESHOLD_KG = 5;
const normalizeWeightKg = (value) => {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > GRAMS_THRESHOLD_KG ? raw / 1000 : raw;
};

const itemWeightKg = (item) => {
  const productWeightKg = normalizeWeightKg(item?.shipping_meta?.product_weight_kg);
  return (productWeightKg > 0 ? productWeightKg : 0.5)
    + Math.max(0, Number(config.packageWeightKg) || 0);
};

// Live weight-based pickup rate: cheapest serviceable courier between the
// customer's pincode and the store, at the returned parcel's billable weight
// (the same env box-weight × units that the ShipRocket return order will
// declare). Cached per pincode+weight so the submit call — which runs inside
// a DB transaction — reuses the estimate's lookup instead of a fresh HTTP
// round-trip.
const PICKUP_RATE_TTL_MS = 6 * 60 * 60 * 1000;
const PICKUP_RATE_CACHE_MAX = 500;
const pickupRateCache = new Map();
const getWeightBasedPickupRate = async (pincode, weightKg) => {
  const key = `${pincode}|${weightKg}`;
  const hit = pickupRateCache.get(key);
  if (hit && Date.now() - hit.at < PICKUP_RATE_TTL_MS) return hit.rate;

  // REVERSE rate: customer -> warehouse, priced off ShipRocket's return rate card.
  // This used to call getServiceableCouries(), which hardcodes the warehouse as the
  // pickup postcode — i.e. it quoted an OUTBOUND delivery rate, the wrong direction and
  // the wrong rate card, and charged it to the customer as a "return pickup charge".
  const data = await ShipRocketService.getReverseServiceableCouriers(pincode, weightKg);
  const rate = pickCheapestCourierRate(data);

  pickupRateCache.set(key, { rate, at: Date.now() });
  if (pickupRateCache.size > PICKUP_RATE_CACHE_MAX) {
    pickupRateCache.delete(pickupRateCache.keys().next().value);
  }
  return rate;
};

/** Cheapest quoted rate across serviceable couriers (0 when none are serviceable). */
const pickCheapestCourierRate = (data) => {
  const rates = (data?.data?.available_courier_companies || [])
    .map((courier) => Number(courier.rate || courier.freight_charge || 0))
    .filter((rate) => rate > 0);
  return rates.length ? roundMoney(Math.min(...rates)) : 0;
};

/**
 * The rate ShipRocket will actually bill for the reverse leg, once a courier has been
 * assigned ("Ship Now" in the dashboard). Re-prices the reverse leg and picks out the
 * courier that was actually assigned — which is very often NOT the cheapest one quoted
 * to the customer at request time.
 *
 * Used for RECONCILIATION ONLY (recordActualReversePickupCharge). The customer's refund
 * keeps the quoted rate; it is never re-priced against this.
 *
 * Falls back to the cheapest quote when the assigned courier can't be matched, and to 0
 * when the lookup fails — never throws, so it can't break a webhook.
 *
 * @returns {Promise<{rate: number, courierName: string|null, matched: boolean}>}
 */
const getActualReversePickupRate = async ({ pincode, weightKg, courierCompanyId, courierName }) => {
  try {
    if (!/^\d{6}$/.test(String(pincode || '').trim())) return { rate: 0, courierName: null, matched: false };
    const data = await ShipRocketService.getReverseServiceableCouriers(pincode, weightKg);
    const couriers = data?.data?.available_courier_companies || [];

    const wantedId = courierCompanyId !== undefined && courierCompanyId !== null
      ? String(courierCompanyId)
      : null;
    const wantedName = String(courierName || '').trim().toLowerCase();

    const assigned = couriers.find((c) => {
      if (wantedId && String(c.courier_company_id) === wantedId) return true;
      if (wantedName && String(c.courier_name || '').trim().toLowerCase() === wantedName) return true;
      return false;
    });

    if (assigned) {
      const rate = roundMoney(Number(assigned.rate || assigned.freight_charge || 0));
      if (rate > 0) {
        return { rate, courierName: assigned.courier_name || courierName || null, matched: true };
      }
    }
    // Couldn't identify the assigned courier — fall back to the cheapest serviceable quote.
    return { rate: pickCheapestCourierRate(data), courierName: courierName || null, matched: false };
  } catch (error) {
    console.error('[OrderReturnService] actual reverse rate lookup failed:', error?.response?.data || error.message);
    return { rate: 0, courierName: null, matched: false };
  }
};

const RETURN_WINDOW_DAYS = 7;

// Additive auto-migration: order_refunds.breakdown (JSONB) — global sync is
// disabled, so the column is added here once per process, create-if-missing.
let refundBreakdownColumnReady = false;
const ensureRefundBreakdownColumn = async () => {
  if (refundBreakdownColumnReady) return;
  const { sequelize } = require('../config/db');
  const { config } = require('../config/env');
  const table = { tableName: 'order_refunds', schema: config.dbSchema };
  const queryInterface = sequelize.getQueryInterface();
  const columns = await queryInterface.describeTable(table);
  if (!columns.breakdown) {
    await queryInterface.addColumn(table, 'breakdown', { type: require('sequelize').DataTypes.JSONB, allowNull: true });
  }
  refundBreakdownColumnReady = true;
};

class ReverseActionError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ReverseActionError';
    this.status = status;
  }
}

const err = (status, message) => new ReverseActionError(status, message);

const REVERSE_CLOSED_STATUSES = ['rejected', 'cancelled'];

const isUsableAction = (action) => !REVERSE_CLOSED_STATUSES.includes(String(action?.status || '').toLowerCase());

const usableActionsOfType = (actions, type) => (actions || []).filter(
  (action) => String(action.action_type || '').toLowerCase() === type && isUsableAction(action),
);

const isWithinReturnWindow = (order) => {
  if (!order?.delivered_at) return false;
  const lastDate = new Date(order.delivered_at);
  lastDate.setDate(lastDate.getDate() + RETURN_WINDOW_DAYS);
  return new Date() <= lastDate;
};

/**
 * Validate that the order may accept a new reverse action of `actionType`.
 * Throws ReverseActionError on any rule violation.
 */
const assertReverseEligibility = ({ order, itemActions, actionType }) => {
  const label = actionType === ACTION_TYPES.EXCHANGE ? 'Exchange' : 'Return';

  if (!isDeliveredEnoughForPostDeliveryAction(order)) {
    throw err(400, `${label} is available only after delivery.`);
  }
  if (!isWithinReturnWindow(order)) {
    throw err(400, `The ${label.toLowerCase()} window has expired.`);
  }

  // Each reverse type is usable once per order — one return AND one exchange,
  // independently. A prior exchange never blocks a return, and vice-versa.
  const usableReturns = usableActionsOfType(itemActions, ACTION_TYPES.RETURN);
  const usableExchanges = usableActionsOfType(itemActions, ACTION_TYPES.EXCHANGE);

  if (actionType === ACTION_TYPES.EXCHANGE && usableExchanges.length) {
    throw err(400, 'Exchange can be requested only once for an order.');
  }
  if (actionType === ACTION_TYPES.RETURN && usableReturns.length) {
    throw err(400, 'Return can be requested only once for an order.');
  }
};

/**
 * Resolve the concrete { item, quantity } targets for this request.
 * `selections` may be:
 *   - a non-empty array of { orderItemId, quantity } (per-item screens), or
 *   - null/empty meaning "every still-eligible item" (whole-order screens).
 */
const resolveTargets = ({ orderItems, itemActions, selections }) => {
  const usableItemIds = new Set(
    (itemActions || []).filter(isUsableAction).map((action) => Number(action.order_item_id)),
  );
  const itemMap = new Map(orderItems.map((item) => [Number(item.id), item]));

  if (Array.isArray(selections) && selections.length) {
    return selections.map((selection) => {
      const item = itemMap.get(Number(selection.orderItemId));
      if (!item) throw err(404, 'One selected product was not found in this order.');
      if (usableItemIds.has(Number(item.id))) {
        throw err(400, `${item.product_name || 'This product'} already has an active request. Please choose another product.`);
      }
      const maxQty = getActionableQuantity(item, itemActions);
      const requested = Number(selection.quantity);
      const quantity = requested > 0 ? Math.min(requested, maxQty) : maxQty;
      if (quantity < 1) {
        throw err(400, `${item.product_name || 'This product'} is not available for this request.`);
      }
      return {
        item,
        quantity,
        exchangeColorId: selection.exchangeColorId ?? null,
        exchangeColorName: selection.exchangeColorName ?? null,
      };
    });
  }

  return orderItems
    .filter((item) => !usableItemIds.has(Number(item.id)) && getActionableQuantity(item, itemActions) > 0)
    .map((item) => ({ item, quantity: getActionableQuantity(item, itemActions) }));
};

// What `coupon` is worth on a bag of `subtotal` under its own rules
// (min-purchase bracket, fixed vs. percentage, max-discount cap).
const couponDiscountFor = (coupon, subtotal) => {
  if (!coupon || subtotal <= 0) return 0;
  if (subtotal < Number(coupon.min_purchase_amount || 0)) return 0;
  if (String(coupon.discount_type) === 'fixed_amount' && Number(coupon.discount_amount) > 0) {
    return Math.min(Number(coupon.discount_amount), subtotal);
  }
  if (Number(coupon.discount_percent) > 0) {
    const pct = (Number(coupon.discount_percent) / 100) * subtotal;
    const cap = Number(coupon.max_discount_amount || 0);
    return cap > 0 ? Math.min(pct, cap) : pct;
  }
  return 0;
};

/**
 * Coupon-aware refund maths for a return request.
 *
 * Policy: the customer gets back exactly what they paid for the returned
 * items — no shipping deductions. Wallet money counts as paid (its share is
 * credited back to the wallet on completion). The only reduction is the
 * coupon, re-rated against the subtotal of the items the customer KEEPS:
 *   - the original coupon still qualifies → its own rules apply (a fixed
 *     coupon keeps full value so the return refunds in full; a percentage
 *     coupon shrinks with the smaller subtotal, honouring its cap);
 *   - the original coupon no longer qualifies → the remaining items are
 *     re-rated with the BEST active coupon they are eligible for, and only
 *     the difference between the old and new benefit is deducted;
 *   - nothing qualifies → the whole remaining coupon benefit is deducted.
 * Earlier return requests' adjustments are excluded so sequential partial
 * returns never claw back the same rupee twice, and the re-rated discount is
 * never allowed to exceed what the customer originally received.
 *
 * @returns {{ returnedValue, remainingSubtotal, currentDiscount, newDiscount,
 *             couponAdjustment, refundAmount, originalCouponCode,
 *             originalCouponEligible, appliedCouponCode }}
 */
const computeReturnRefund = async ({ order, orderItems, itemActions, targets, transaction = null }) => {
  const returnedValue = roundMoney(
    targets.reduce((sum, { item, quantity }) => sum + Number(item.price || 0) * Number(quantity || 0), 0),
  );

  // Subtotal of the items still active BEFORE this request (cancelled and
  // previously returned/exchanged quantities excluded).
  const activeSubtotal = roundMoney(orderItems.reduce(
    (sum, item) => sum + Number(item.price || 0) * getActionableQuantity(item, itemActions),
    0,
  ));
  const remainingSubtotal = roundMoney(Math.max(0, activeSubtotal - returnedValue));

  // Discount actually granted on the order (from the ledger), minus the
  // adjustments earlier return requests already reserved.
  const totals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: order.id }, transaction }));
  const grantedDiscount = roundMoney(Number(totals.discount_amount || 0));
  const alreadyAdjusted = roundMoney((itemActions || [])
    .filter((a) => String(a.action_type || '').toLowerCase() === ACTION_TYPES.RETURN && isUsableAction(a))
    .reduce((sum, a) => sum + Number(a.meta?.coupon_adjustment || 0), 0));
  const currentDiscount = roundMoney(Math.max(0, grantedDiscount - alreadyAdjusted));

  const code = String(order.coupon_code || '').trim() || null;

  // One return-pickup charge per request (not per item), rated live for the
  // billable weight of the returned units against the customer's pincode.
  // Must use the SAME (product weight + box weight) basis the forward
  // delivery charge was quoted on at checkout (see allocateItemShipping in
  // OrderController — product_weight_kg is snapshotted per item in
  // shipping_meta precisely so this stays in sync), not just the box weight.
  // Box-weight-only understates the parcel and quotes a cheaper pickup rate
  // than the delivery charge the customer was actually shown for it.
  const pickupWeightKg = Math.max(0.1, roundMoney(
    targets.reduce((sum, { item, quantity }) => sum + itemWeightKg(item) * Number(quantity || 0), 0),
  ));
  const address = await OrderAddress.findOne({ where: { order_id: order.id, is_current: true }, transaction });
  const pincode = String(address?.pincode || order.pincode || '').trim();
  // The BEST (cheapest) serviceable reverse rate. This is what the customer is quoted in
  // the UI and what is actually deducted from their refund — it is locked in at request
  // time and never revised. What the courier ultimately bills us is recorded separately
  // on the REVERSE shipment (see recordActualReversePickupCharge) for reconciliation only.
  let rawPickupCharge = 0;
  try {
    if (/^\d{6}$/.test(pincode)) {
      rawPickupCharge = await getWeightBasedPickupRate(pincode, pickupWeightKg);
    }
  } catch (error) {
    console.error('[OrderReturnService] pickup rate lookup failed:', error?.response?.data || error.message);
  }
  if (rawPickupCharge <= 0) {
    const forwardShipment = await Shipment.findOne({
      where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD },
      order: [['created_at', 'DESC']],
      transaction,
    });
    rawPickupCharge = reverseChargeFromShipment(forwardShipment);
  }

  // Full-order return — nothing is kept, so there's no "remaining subtotal"
  // to re-rate a coupon against. Skip that machinery entirely.
  //
  // Money moves back to TWO separate places:
  //   • wallet credit spent at checkout → returned to the wallet IN FULL
  //     (it's store credit; the service fees and pickup charge never erode it);
  //   • what the customer actually paid us (amount_paid = gateway/COD) →
  //     refunded minus the non-refundable fees (platform/COD/gift) and the
  //     return pickup charge.
  // Only if the paid amount can't absorb the fees + pickup does the shortfall
  // fall back onto the wallet return (so we never refund more than was paid).
  if (remainingSubtotal <= 0) {
    const amountPaid = roundMoney(Number(totals.amount_paid || 0));
    const walletAmount = roundMoney(Number(totals.wallet_amount || 0));
    const platformFee = roundMoney(Number(totals.platform_fee || 0));
    const codFee = roundMoney(Number(totals.cod_fee || 0));
    const giftCharge = roundMoney(Number(totals.gift_charge || 0));
    const grossRefundable = roundMoney(Math.max(0, amountPaid + walletAmount - platformFee - codFee - giftCharge));
    const returnShippingCharge = roundMoney(Math.min(rawPickupCharge, grossRefundable));

    // Payment-gateway cost on a full return. The gateway keeps its fee on the ORIGINAL
    // transaction even when we refund it, so that cost is retained rather than refunded:
    //   fee = refund × feePercent, gst = fee × gstPercent
    // Charged on the refund actually going back to the card (i.e. AFTER the other
    // deductions), never on the wallet credit — that is the customer's own money and is
    // returned in full. Both rates default to 0, so this stays inert until configured.
    const feeBase = roundMoney(Math.max(
      0,
      amountPaid - platformFee - codFee - giftCharge - returnShippingCharge,
    ));
    const gatewayFeePercent = Math.max(0, Number(config.returnGatewayFeePercent) || 0);
    const gatewayGstPercent = Math.max(0, Number(config.returnGatewayFeeGstPercent) || 0);
    const paymentGatewayFee = roundMoney((feeBase * gatewayFeePercent) / 100);
    const paymentGatewayFeeGst = roundMoney((paymentGatewayFee * gatewayGstPercent) / 100);
    const paymentGatewayCharge = roundMoney(paymentGatewayFee + paymentGatewayFeeGst);

    // Fees + pickup + gateway charge come out of the paid (gateway/COD) money first;
    // wallet is returned in full unless the paid money can't cover the charges.
    const totalDeductions = roundMoney(
      platformFee + codFee + giftCharge + returnShippingCharge + paymentGatewayCharge,
    );
    const gatewayRefund = roundMoney(Math.max(0, amountPaid - totalDeductions));
    const deductionShortfall = roundMoney(Math.max(0, totalDeductions - amountPaid));
    const walletReturn = roundMoney(Math.max(0, walletAmount - deductionShortfall));
    const refundAmount = roundMoney(gatewayRefund + walletReturn);
    const couponAdjustment = roundMoney(Math.max(0, roundMoney(returnedValue - grossRefundable)));
    return {
      returnedValue, remainingSubtotal, currentDiscount, newDiscount: 0, couponAdjustment,
      returnShippingCharge, pickupWeightKg, refundAmount,
      originalCouponCode: code, originalCouponEligible: false, appliedCouponCode: null,
      isFullReturn: true, amountPaid, walletAmount, platformFee, codFee, giftCharge,
      paymentGatewayFee, paymentGatewayFeeGst, paymentGatewayCharge,
      gatewayFeePercent, gatewayGstPercent,
      gatewayRefund, walletReturn,
    };
  }

  if (currentDiscount <= 0 || returnedValue <= 0) {
    const returnShippingCharge = roundMoney(Math.min(rawPickupCharge, returnedValue));
    return {
      returnedValue, remainingSubtotal, currentDiscount,
      newDiscount: currentDiscount, couponAdjustment: 0, returnShippingCharge, pickupWeightKg,
      refundAmount: roundMoney(Math.max(0, returnedValue - returnShippingCharge)),
      originalCouponCode: code, originalCouponEligible: true, appliedCouponCode: code,
      isFullReturn: false,
    };
  }

  const originalCoupon = code
    ? await Coupon.findOne({ where: { code: { [Op.iLike]: code } }, transaction })
    : null;
  const originalCouponEligible = Boolean(
    originalCoupon && remainingSubtotal > 0
    && remainingSubtotal >= Number(originalCoupon.min_purchase_amount || 0),
  );

  let newDiscount;
  let appliedCouponCode = code;
  if (originalCouponEligible) {
    // Same coupon, re-rated on the kept subtotal under its own rules.
    newDiscount = couponDiscountFor(originalCoupon, remainingSubtotal);
    if (newDiscount <= 0) newDiscount = currentDiscount; // unknown shape — keep as granted
  } else {
    // Original coupon no longer applies — give the remaining items the best
    // active coupon they qualify for and deduct only the difference.
    newDiscount = 0;
    appliedCouponCode = null;
    if (remainingSubtotal > 0) {
      const now = new Date();
      const candidates = await Coupon.findAll({ where: { is_active: true }, transaction });
      for (const candidate of candidates) {
        if (candidate.valid_from && new Date(candidate.valid_from) > now) continue;
        if (candidate.valid_until && new Date(candidate.valid_until) < now) continue;
        const worth = couponDiscountFor(candidate, remainingSubtotal);
        if (worth > newDiscount) {
          newDiscount = worth;
          appliedCouponCode = candidate.code;
        }
      }
    }
  }
  // Never grant more than the customer actually received.
  newDiscount = roundMoney(Math.min(Math.max(0, newDiscount), currentDiscount));

  const couponAdjustment = roundMoney(Math.min(returnedValue, roundMoney(currentDiscount - newDiscount)));
  const returnShippingCharge = roundMoney(Math.min(rawPickupCharge, Math.max(0, returnedValue - couponAdjustment)));
  const refundAmount = roundMoney(Math.max(0, returnedValue - couponAdjustment - returnShippingCharge));
  return {
    returnedValue, remainingSubtotal, currentDiscount, newDiscount, couponAdjustment,
    returnShippingCharge, pickupWeightKg, refundAmount,
    originalCouponCode: code, originalCouponEligible, appliedCouponCode,
    isFullReturn: false,
  };
};

/**
 * Create return/exchange action rows + a single refund row, and move the order
 * into the reverse-flow status. Runs entirely inside `transaction`.
 *
 * @returns {{ entries: Array<{action, item, quantity, calculation}>, actions: Array, refundRow: object }}
 */
const createReverseActions = async ({
  order,
  orderItems,
  itemActions,
  actionType,
  selections,
  reason,
  comments,
  requestedBy,
  actor = 'customer',
  transaction,
}) => {
  if (![ACTION_TYPES.RETURN, ACTION_TYPES.EXCHANGE].includes(actionType)) {
    throw err(400, 'Please choose return or exchange.');
  }

  assertReverseEligibility({ order, itemActions, actionType });

  const targets = resolveTargets({ orderItems, itemActions, selections });
  if (!targets.length) {
    throw err(400, 'No eligible products are available for this request.');
  }

  const cleanReason = String(reason || '').trim() || null;
  const entries = [];

  // Coupon + pickup-charge maths for the whole request, then allocated
  // pro-rata across the selected items (the last item absorbs the rounding
  // remainder) so the per-action rows always sum to the refund row.
  const refundInfo = actionType === ACTION_TYPES.RETURN
    ? await computeReturnRefund({ order, orderItems, itemActions, targets, transaction })
    : null;
  let adjustmentLeft = refundInfo ? refundInfo.couponAdjustment : 0;
  let pickupLeft = refundInfo ? refundInfo.returnShippingCharge : 0;

  for (let index = 0; index < targets.length; index += 1) {
    const { item, quantity, exchangeColorId, exchangeColorName } = targets[index];
    const calculation = calculateItemAction({ item, actionType, quantity });
    let couponShare = 0;
    let pickupShare = 0;
    if (refundInfo && refundInfo.returnedValue > 0) {
      const isLast = index === targets.length - 1;
      if (refundInfo.couponAdjustment > 0) {
        couponShare = isLast
          ? roundMoney(adjustmentLeft)
          : roundMoney(refundInfo.couponAdjustment * (calculation.item_amount / refundInfo.returnedValue));
        couponShare = roundMoney(Math.min(couponShare, calculation.item_amount, adjustmentLeft));
        adjustmentLeft = roundMoney(adjustmentLeft - couponShare);
      }
      if (refundInfo.returnShippingCharge > 0) {
        pickupShare = isLast
          ? roundMoney(pickupLeft)
          : roundMoney(refundInfo.returnShippingCharge * (calculation.item_amount / refundInfo.returnedValue));
        pickupShare = roundMoney(Math.min(pickupShare, roundMoney(calculation.item_amount - couponShare), pickupLeft));
        pickupLeft = roundMoney(pickupLeft - pickupShare);
        calculation.reverse_shipping_deduction = pickupShare;
      }
      calculation.estimated_refund_amount = roundMoney(Math.max(0, calculation.item_amount - couponShare - pickupShare));
    }
    const action = await OrderItemAction.create({
      order_id: order.id,
      order_item_id: item.id,
      product_id: item.product_id,
      action_type: actionType,
      quantity,
      status: ACTION_STATUS.INITIATED,
      reason: cleanReason,
      ...calculation,
      requested_by: requestedBy ?? null,
      meta: {
        customer_message: comments || null,
        sku: item.sku || null,
        color_id: item.colorId || item.color_id || null,
        // Exchange: the colour variant of the same product the customer wants.
        ...(actionType === ACTION_TYPES.EXCHANGE && exchangeColorId
          ? { exchange_color_id: exchangeColorId, exchange_color_name: exchangeColorName || null }
          : {}),
        ...(couponShare > 0 ? { coupon_adjustment: couponShare, coupon_code: order.coupon_code || null } : {}),
      },
    }, { transaction });

    // Quantity accounting is derived from action rows now — only the item
    // status pointer is updated.
    await item.update({ status: statusForRequestedAction(actionType) }, { transaction });

    entries.push({ action, item, quantity, calculation });
  }

  const paymentMethod = String(order.payment_method || '').toUpperCase();
  const isCod = paymentMethod === 'COD';
  const firstActionId = entries[0].action.id;
  let refundRow;

  // Stamp every row of this request with the first row's id. The admin queue,
  // the status update and the refund all key off this so a multi-item request is
  // reviewed and paid out ONCE, not once per item.
  await OrderItemAction.update(
    { request_group_id: firstActionId },
    { where: { id: entries.map(({ action }) => action.id) }, transaction },
  );
  entries.forEach(({ action }) => action.set('request_group_id', firstActionId));

  if (actionType === ACTION_TYPES.RETURN) {
    // The payable total is the figure computeReturnRefund quoted and the customer
    // confirmed — NOT the sum of the per-item slices. On a FULL return the two
    // differ by the payment-gateway charge: the per-item estimates only ever
    // subtract the coupon adjustment and pickup share, so summing them would pay
    // back the gateway charge we are meant to retain. (On a partial return the
    // two are equal by construction, since the slices are a pro-rata split of
    // exactly this number.)
    const totalRefund = roundMoney(refundInfo.refundAmount);
    // Structured breakage, persisted so it can always be replayed to the
    // customer (order page) and admin, even if coupons/rates change later.
    await ensureRefundBreakdownColumn();
    const breakdown = {
      returned_value: refundInfo.returnedValue,
      remaining_subtotal: refundInfo.remainingSubtotal,
      is_full_return: Boolean(refundInfo.isFullReturn),
      // Full return: the wallet credit is returned to the wallet IN FULL
      // (wallet_return), while the money paid to us (amount_paid) is refunded
      // to the gateway/COD minus the non-refundable fees and pickup charge
      // (gateway_refund) — see OrderItemActionController.initiateRefund.
      // Persisted line by line so the order page and admin can always replay
      // the exact formula instead of one lumped figure.
      ...(refundInfo.isFullReturn ? {
        amount_paid: refundInfo.amountPaid,
        wallet_amount: refundInfo.walletAmount,
        wallet_return: refundInfo.walletReturn,
        gateway_refund: refundInfo.gatewayRefund,
        platform_fee: refundInfo.platformFee,
        cod_fee: refundInfo.codFee,
        gift_charge: refundInfo.giftCharge,
        // Payment-gateway cost retained (fee + GST on the fee). Rates persisted too, so
        // an old refund still replays with the rates that were in force when it was made.
        payment_gateway_fee: refundInfo.paymentGatewayFee,
        payment_gateway_fee_gst: refundInfo.paymentGatewayFeeGst,
        payment_gateway_charge: refundInfo.paymentGatewayCharge,
        payment_gateway_fee_percent: refundInfo.gatewayFeePercent,
        payment_gateway_gst_percent: refundInfo.gatewayGstPercent,
      } : {}),
      coupon: (refundInfo.originalCouponCode && refundInfo.currentDiscount > 0) || refundInfo.couponAdjustment > 0 ? {
        original_code: refundInfo.originalCouponCode,
        original_discount: refundInfo.currentDiscount,
        original_eligible: refundInfo.originalCouponEligible,
        applied_code: refundInfo.appliedCouponCode,
        new_discount: refundInfo.newDiscount,
        adjustment: refundInfo.couponAdjustment,
      } : null,
      return_shipping_charge: refundInfo.returnShippingCharge,
      return_shipping_weight_kg: refundInfo.pickupWeightKg,
      refund_amount: totalRefund,
      items: entries.map(({ action, item, quantity, calculation }) => ({
        order_item_id: item.id,
        product_name: item.product_name,
        quantity,
        item_amount: calculation.item_amount,
        coupon_adjustment: roundMoney(Number(action.meta?.coupon_adjustment || 0)),
        return_shipping_share: roundMoney(Number(calculation.reverse_shipping_deduction || 0)),
        refund: calculation.estimated_refund_amount,
      })),
    };
    refundRow = await OrderRefund.create({
      order_id: order.id,
      order_item_action_id: firstActionId,
      refund_type: REFUND_TYPE.RETURN,
      amount: totalRefund,
      breakdown,
      status: REFUND_STATUS.PENDING,
      payment_method: isCod ? REFUND_PAYMENT_METHOD.BANK_TRANSFER : REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
      note: [
        isCod
          ? 'Customer bank details are required before manual refund.'
          : 'Refund will be processed back to the original prepaid payment method.',
        refundInfo && refundInfo.returnShippingCharge > 0
          ? `Return pickup charge of Rs. ${refundInfo.returnShippingCharge.toLocaleString('en-IN')} deducted.`
          : null,
        refundInfo && refundInfo.isFullReturn && refundInfo.paymentGatewayCharge > 0
          ? `Payment gateway charge of Rs. ${refundInfo.paymentGatewayCharge.toLocaleString('en-IN')} (${refundInfo.gatewayFeePercent}% fee + ${refundInfo.gatewayGstPercent}% GST on the fee) deducted — the gateway retains this on the original transaction.`
          : null,
        refundInfo && refundInfo.isFullReturn && (refundInfo.platformFee > 0 || refundInfo.codFee > 0 || refundInfo.giftCharge > 0)
          ? `Platform fee${refundInfo.codFee > 0 ? ', COD charge' : ''}${refundInfo.giftCharge > 0 ? ' and gift charge' : ''} already paid on this order are not refunded.`
          : null,
        refundInfo && refundInfo.isFullReturn && refundInfo.walletReturn > 0
          ? `Rs. ${refundInfo.walletReturn.toLocaleString('en-IN')} paid from your wallet will be credited back to your wallet in full; the remaining Rs. ${refundInfo.gatewayRefund.toLocaleString('en-IN')} goes to your original payment method.`
          : null,
        refundInfo && !refundInfo.isFullReturn && refundInfo.couponAdjustment > 0
          ? (refundInfo.originalCouponEligible
            ? `Coupon ${refundInfo.originalCouponCode || ''} re-rated on the remaining items (worth Rs. ${refundInfo.newDiscount.toLocaleString('en-IN')} instead of Rs. ${refundInfo.currentDiscount.toLocaleString('en-IN')}) — difference of Rs. ${refundInfo.couponAdjustment.toLocaleString('en-IN')} deducted from the refund.`
            : refundInfo.appliedCouponCode
              ? `Coupon ${refundInfo.originalCouponCode || ''} no longer qualifies for the remaining items; best available coupon ${refundInfo.appliedCouponCode} (worth Rs. ${refundInfo.newDiscount.toLocaleString('en-IN')}) applied instead — difference of Rs. ${refundInfo.couponAdjustment.toLocaleString('en-IN')} deducted from the refund.`
              : `Coupon ${refundInfo.originalCouponCode || ''} no longer qualifies for the remaining items and no other coupon applies — Rs. ${refundInfo.couponAdjustment.toLocaleString('en-IN')} deducted from the refund.`)
          : null,
      ].filter(Boolean).join(' '),
    }, { transaction });

    // Normalized V2 mirror: return_requests + return_items (gross values).
    const isFull = targets.length >= orderItems.length;
    const returnRequest = await ReturnRequest.create({
      order_id: order.id,
      type: isFull ? RETURN_TYPE.FULL : RETURN_TYPE.PARTIAL,
      status: RETURN_STATUS.REQUESTED,
      reason: cleanReason,
    }, { transaction });
    await ReturnItem.bulkCreate(entries.map(({ item, quantity }) => ({
      return_request_id: returnRequest.id,
      order_item_id: item.id,
      quantity,
      item_value: roundMoney(Number(item.price || 0) * quantity),
    })), { transaction });
  } else {
    refundRow = await OrderRefund.create({
      order_id: order.id,
      order_item_action_id: firstActionId,
      refund_type: REFUND_TYPE.EXCHANGE,
      amount: 0,
      status: REFUND_STATUS.NOT_REQUIRED,
      payment_method: REFUND_PAYMENT_METHOD.NOT_REQUIRED,
      note: 'Exchange initiated. No monetary refund applies for one approved exchange.',
    }, { transaction });
  }

  const nextStatus = actionType === ACTION_TYPES.RETURN ? 'Return Initiated' : 'Exchange Initiated';
  const prevStatus = order.status;
  await order.update({ status: nextStatus }, { transaction });
  await OrderStatusHistory.create({
    order_id: order.id,
    from_status: prevStatus,
    to_status: nextStatus,
    actor: actor === 'admin' ? ACTOR.ADMIN : ACTOR.CUSTOMER,
    reason: cleanReason,
  }, { transaction });

  return { entries, actions: entries.map((entry) => entry.action), refundRow };
};

/**
 * Post-commit side effects: book the ShipRocket reverse pickup and, for returns,
 * cancel any pending referral credits held against the order. Best-effort — never
 * throws, so a courier API failure cannot undo an already-committed request.
 *
 * @returns {{ shiprocketReturnId: string|null, shipmentId: string|null, detail: object|null }}
 */
/**
 * Record what the reverse pickup ACTUALLY costs us, once a courier has been assigned
 * ("Ship Now" in the SR dashboard).
 *
 * This is RECORD-ONLY. The charge deducted from the customer is the BEST (cheapest)
 * serviceable rate quoted at request time — that is what the UI showed them and what the
 * refund is settled on, and it is never revised. Re-pricing their refund after the fact
 * would mean charging them something they never agreed to. What the courier really bills
 * us is stored here purely so the reverse leg can be reconciled (quoted vs actual).
 *
 * Never throws: a pricing lookup must not break the webhook.
 *
 * @returns {Promise<{quoted: number, actual: number, courierName: string|null}|null>}
 */
const recordActualReversePickupCharge = async ({
  order, reverseAction, reverseShipment, courierCompanyId, courierName,
}) => {
  try {
    if (!order || !reverseAction || !reverseShipment) return null;

    const refund = await OrderRefund.findOne({
      where: { order_id: order.id, refund_type: REFUND_TYPE.RETURN },
      order: [['created_at', 'DESC']],
    });
    const quoted = roundMoney(Number(refund?.breakdown?.return_shipping_charge) || 0);

    const address = await OrderAddress.findOne({ where: { order_id: order.id, is_current: true } });
    const pincode = String(address?.pincode || order.pincode || '').trim();
    const weightKg = Math.max(0.1, Number(refund?.breakdown?.return_shipping_weight_kg) || 0.5);

    const actual = await getActualReversePickupRate({ pincode, weightKg, courierCompanyId, courierName });
    if (!actual.rate || actual.rate <= 0) return null;

    //  on the Shipment model is 'the courier cost of THIS shipment' — for a
    // REVERSE row that is the pickup cost. This is purely our record of what the leg really
    // cost; the customer's refund is left exactly as quoted.
    await reverseShipment.update({
      forward_charge: actual.rate,
      selected_courier_data: {
        ...(reverseShipment.selected_courier_data || {}),
        rate: actual.rate,
        rate_source: actual.matched ? 'assigned_courier' : 'cheapest_serviceable',
        quoted_to_customer: quoted,
      },
    });

    return { quoted, actual: actual.rate, courierName: actual.courierName };
  } catch (error) {
    console.error('[OrderReturnService] could not record actual reverse pickup charge:', error?.response?.data || error.message);
    return null;
  }
};
const finalizeReverseActions = async ({ order, entries, actionType, reason }) => {
  // `booked` tells the caller whether the courier actually accepted the reverse pickup.
  // It is false whenever the push threw OR came back without SR identifiers.
  const result = {
    shiprocketReturnId: null, shipmentId: null, reverseShipmentId: null,
    detail: null, booked: false, error: null,
  };
  const anchorAction = entries[0]?.action || null;

  // Declared value on the ShipRocket reverse order = the VALUE OF THE GOODS being
  // carried (item price × qty), for BOTH returns and exchanges — the same basis the
  // forward order was pushed with.
  //
  // ShipRocket returns are sent payment_method: 'Prepaid' with no COD amount, so
  // sub_total / selling_price are NOT a payment instruction — they are the declared
  // value used for insurance/liability if the courier loses or damages the parcel, and
  // for the invoice / e-way bill.
  //
  // This used to declare a RETURN at its per-unit refund value (net of the coupon
  // clawback, pickup charge and platform/gift fees) so the SR dashboard mirrored the
  // site. That under-declares the parcel — and because the value was floored with
  // Math.max(1, …), a refund that netted to zero shipped a ₹3,999 saree declared at ₹1,
  // capping any loss claim there. It also meant the same physical parcel was declared
  // differently depending on whether it came back as a return or an exchange.
  //
  // The refund is an accounting figure and lives in the order/refund ledger, which is
  // where the customer sees it; the shipment carries what the goods are worth.
  const items = entries.map(({ item, quantity }) => ({
    product_id: item.product_id,
    quantity,
    price: Number(item.price),
    name: item.product_name || `Product #${item.product_id}`,
    sku: item.sku,
    // Real per-unit weight (product + box) — same basis the pickup rate
    // quote used, so the actual ShipRocket return AWB isn't booked lighter
    // than what the customer was quoted for the pickup charge.
    weight: itemWeightKg(item),
  }));
  const declaredTotal = roundMoney(items.reduce(
    (sum, line) => sum + Number(line.price) * Math.max(1, Number(line.quantity || 1)),
    0,
  ));

  // Enrich the order with the current address (no longer on the order row).
  const address = await OrderAddress.findOne({ where: { order_id: order.id, is_current: true } });
  const srOrder = {
    ...order.toJSON(),
    address: address?.line, city: address?.city, pincode: address?.pincode,
    phone: address?.phone, state: address?.state, total_amount: declaredTotal,
  };

  // Give the reverse leg a real home, mirroring the forward flow: the order is pushed to
  // ShipRocket, an admin presses "Ship Now" in the SR dashboard, and the webhook fills in
  // the AWB + courier details. Forward writes those onto its Shipment row; without a
  // REVERSE row a return had nowhere to put them, so courier name, ETD, pickup/received
  // timestamps and the reverse rate card were all simply discarded.
  //
  // Created UNCONDITIONALLY and BEFORE the courier push — this row is OUR record of the
  // return leg, so it must not depend on ShipRocket answering. If the push fails the row
  // still exists (with a null shiprocket_order_id) alongside the reverse_pickup_failed
  // marker, which is exactly what a re-book needs. Status stays CREATED until the
  // dashboard assigns a courier, same as forward.
  let reverseShipment = null;
  try {
    reverseShipment = await Shipment.findOne({
      where: { order_id: order.id, type: SHIPMENT_TYPE.REVERSE },
      order: [['created_at', 'DESC']],
    });
    if (!reverseShipment) {
      reverseShipment = await Shipment.create({
        order_id: order.id,
        address_id: address?.id || null,
        type: SHIPMENT_TYPE.REVERSE,
        status: SHIPMENT_STATUS.CREATED,
        // forward_charge is the FORWARD leg's cost; a reverse pickup has none.
        forward_charge: 0,
      });
    }
    result.reverseShipmentId = reverseShipment.id;
  } catch (shipmentError) {
    // Non-fatal: never fail a customer's return over our own bookkeeping row.
    console.error('[OrderReturnService] could not create REVERSE shipment row:', shipmentError.message);
  }

  try {
    const data = await ShipRocketService.createReturnOrder({
      order: srOrder,
      items,
      reason: actionType === ACTION_TYPES.EXCHANGE
        ? `Exchange: ${String(reason || 'Exchange requested').slice(0, 200)}`
        : String(reason || 'Customer requested return').slice(0, 200),
    });
    result.detail = data;
    result.shipmentId = data?.shipment_id || null;
    const srId = data?.order_id ? String(data.order_id) : null;
    result.shiprocketReturnId = srId;

    // A 200 with no identifiers is still a failure. Reverse webhooks match ONLY by
    // shiprocket_return_order_id / shiprocket_return_awb, and the tracking endpoint only
    // surfaces actions that have one — so a request with neither can never progress past
    // "Return Initiated" and is invisible to the customer, ops and the courier. Treat it
    // exactly like a thrown error rather than letting it pass silently.
    if (!srId && !result.shipmentId) {
      throw new Error('ShipRocket accepted the reverse order but returned no order_id/shipment_id.');
    }

    // Persist both ShipRocket identifiers on the request's first action row:
    // the return ORDER id (webhooks match reverse scans by it) and the return
    // SHIPMENT id (needed for label/pickup/cancel calls on ShipRocket's side).
    if (anchorAction) {
      const meta = { ...(anchorAction.meta || {}) };
      if (result.shipmentId) meta.shiprocket_return_shipment_id = String(result.shipmentId);
      // Clear any marker left by a previous failed attempt (this is also the re-book path).
      delete meta.reverse_pickup_failed;
      delete meta.reverse_pickup_error;
      delete meta.reverse_pickup_failed_at;
      await anchorAction.update({
        ...(srId ? { shiprocket_return_order_id: srId } : {}),
        meta,
      });
    }

    // Stamp the ShipRocket id onto the REVERSE shipment row created above.
    if (reverseShipment && srId && !reverseShipment.shiprocket_order_id) {
      try {
        await reverseShipment.update({ shiprocket_order_id: String(srId) });
      } catch (shipmentError) {
        console.error('[OrderReturnService] could not stamp SR id on REVERSE shipment:', shipmentError.message);
      }
    }

    result.booked = true;
  } catch (error) {
    const message = String(
      error?.response?.data?.message
      || (error?.response?.data ? JSON.stringify(error.response.data) : null)
      || error.message
      || 'Unknown error',
    );
    console.error('[OrderReturnService] reverse pickup booking failed:', error?.response?.data || error.message);
    result.error = message;
    // The request is already COMMITTED (this runs post-commit by design, so a courier
    // outage can't undo the customer's return). But without SR identifiers it is orphaned:
    // no webhook can match it, no tracking shows it, and nothing tells anyone. Stamp the
    // failure onto the request so it is queryable and can be re-booked, instead of sitting
    // silently on "Return Initiated" forever. Mirrors how a failed gateway refund is
    // surfaced for manual retry (see OrderItemActionController).
    if (anchorAction) {
      try {
        await anchorAction.update({
          meta: {
            ...(anchorAction.meta || {}),
            reverse_pickup_failed: true,
            reverse_pickup_error: message.slice(0, 500),
            reverse_pickup_failed_at: new Date().toISOString(),
          },
        });
      } catch (metaError) {
        console.error('[OrderReturnService] could not persist reverse-pickup failure marker:', metaError.message);
      }
    }
  }

  if (actionType === ACTION_TYPES.RETURN) {
    try {
      await WalletService.cancelPendingReferralCreditsForOrder(
        order.id,
        'Customer requested return within the reward hold period.',
      );
    } catch (error) {
      console.error('[OrderReturnService] referral credit cancel failed:', error.message);
    }
  }

  return result;
};

module.exports = {
  ReverseActionError,
  RETURN_WINDOW_DAYS,
  isWithinReturnWindow,
  computeReturnRefund,
  createReverseActions,
  finalizeReverseActions,
  recordActualReversePickupCharge,
};
