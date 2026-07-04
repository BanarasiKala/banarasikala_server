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
  SHIPMENT_TYPE, RETURN_TYPE, RETURN_STATUS, ACTOR,
} = require('../utils/orderModelV2');

// Return-pickup (reverse) shipping cost, sourced from the latest forward
// shipment's rate card. This is the only delivery money deducted from a
// return refund — the original (forward) delivery is never adjusted.
const reverseChargeFromShipment = (shipment) => {
  const d = shipment?.selected_courier_data || {};
  const candidate = [d.freight_charge, d.rate, d.shipping_charge, d.charge].find((v) => Number(v) > 0);
  return roundMoney(Number(candidate) || Number(shipment?.forward_charge) || 0);
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
      return { item, quantity };
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

  // One return-pickup charge per request (not per item), from the forward
  // shipment's rate card, capped so the refund can never go negative.
  const forwardShipment = await Shipment.findOne({
    where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD },
    order: [['created_at', 'DESC']],
    transaction,
  });
  const rawPickupCharge = reverseChargeFromShipment(forwardShipment);

  if (currentDiscount <= 0 || returnedValue <= 0) {
    const returnShippingCharge = roundMoney(Math.min(rawPickupCharge, returnedValue));
    return {
      returnedValue, remainingSubtotal, currentDiscount,
      newDiscount: currentDiscount, couponAdjustment: 0, returnShippingCharge,
      refundAmount: roundMoney(Math.max(0, returnedValue - returnShippingCharge)),
      originalCouponCode: code, originalCouponEligible: true, appliedCouponCode: code,
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
    returnShippingCharge, refundAmount,
    originalCouponCode: code, originalCouponEligible, appliedCouponCode,
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
    const { item, quantity } = targets[index];
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

  if (actionType === ACTION_TYPES.RETURN) {
    const totalRefund = roundMoney(
      entries.reduce((sum, entry) => sum + Number(entry.calculation.estimated_refund_amount || 0), 0),
    );
    // Structured breakage, persisted so it can always be replayed to the
    // customer (order page) and admin, even if coupons/rates change later.
    await ensureRefundBreakdownColumn();
    const breakdown = {
      returned_value: refundInfo.returnedValue,
      remaining_subtotal: refundInfo.remainingSubtotal,
      coupon: refundInfo.originalCouponCode && refundInfo.currentDiscount > 0 ? {
        original_code: refundInfo.originalCouponCode,
        original_discount: refundInfo.currentDiscount,
        original_eligible: refundInfo.originalCouponEligible,
        applied_code: refundInfo.appliedCouponCode,
        new_discount: refundInfo.newDiscount,
        adjustment: refundInfo.couponAdjustment,
      } : null,
      return_shipping_charge: refundInfo.returnShippingCharge,
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
        refundInfo && refundInfo.couponAdjustment > 0
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
const finalizeReverseActions = async ({ order, entries, actionType, reason }) => {
  const result = { shiprocketReturnId: null, shipmentId: null, detail: null };

  const items = entries.map(({ item, quantity }) => ({
    product_id: item.product_id,
    quantity,
    price: item.price,
    name: item.product_name || `Product #${item.product_id}`,
    sku: item.sku,
  }));

  // Enrich the order with the current address + total (no longer on the order row).
  const address = await OrderAddress.findOne({ where: { order_id: order.id, is_current: true } });
  const totals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: order.id } }));
  const srOrder = {
    ...order.toJSON(),
    address: address?.line, city: address?.city, pincode: address?.pincode,
    phone: address?.phone, state: address?.state, total_amount: totals.total_amount,
  };

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
    if (srId && entries[0]?.action) {
      await entries[0].action.update({ shiprocket_return_order_id: srId });
    }
  } catch (error) {
    console.error('[OrderReturnService] reverse pickup booking failed:', error?.response?.data || error.message);
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
};
