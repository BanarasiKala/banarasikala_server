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
const OrderItemAction = require('../models/OrderItemAction');
const OrderRefund = require('../models/OrderRefund');
const ShipRocketService = require('./ShipRocketService');
const WalletService = require('./WalletService');
const {
  ACTION_TYPES,
  ACTION_STATUS,
  getActionableQuantity,
  calculateItemAction,
  statusForRequestedAction,
  isDeliveredEnoughForPostDeliveryAction,
  appendOrderStatusHistory,
  roundMoney,
} = require('../utils/orderItemActions');
const { REFUND_TYPE, REFUND_STATUS, REFUND_PAYMENT_METHOD } = require('../utils/orderTransactions');

const RETURN_WINDOW_DAYS = 7;

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

  const usableReturns = usableActionsOfType(itemActions, ACTION_TYPES.RETURN);
  const usableExchanges = usableActionsOfType(itemActions, ACTION_TYPES.EXCHANGE);

  if (actionType === ACTION_TYPES.EXCHANGE) {
    if (usableExchanges.length) {
      throw err(400, 'Exchange can be requested only once for an order. Remaining products can be returned.');
    }
    if (usableReturns.length) {
      throw err(400, 'Return already used. Exchange is not available after a return on this order.');
    }
  }
  if (actionType === ACTION_TYPES.RETURN && usableExchanges.length) {
    throw err(400, 'Exchange already used. Return is not available after an exchange on this order.');
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
      const maxQty = getActionableQuantity(item);
      const requested = Number(selection.quantity);
      const quantity = requested > 0 ? Math.min(requested, maxQty) : maxQty;
      if (quantity < 1) {
        throw err(400, `${item.product_name || 'This product'} is not available for this request.`);
      }
      return { item, quantity };
    });
  }

  return orderItems
    .filter((item) => !usableItemIds.has(Number(item.id)) && getActionableQuantity(item) > 0)
    .map((item) => ({ item, quantity: getActionableQuantity(item) }));
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

  for (const { item, quantity } of targets) {
    const calculation = calculateItemAction({ order, item, actionType, quantity });
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
      },
    }, { transaction });

    await item.update({
      status: statusForRequestedAction(actionType),
      pending_action_quantity: Number(item.pending_action_quantity || 0) + quantity,
    }, { transaction });

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
    refundRow = await OrderRefund.create({
      order_id: order.id,
      order_item_action_id: firstActionId,
      refund_type: REFUND_TYPE.RETURN,
      amount: totalRefund,
      status: REFUND_STATUS.PENDING,
      payment_method: isCod ? REFUND_PAYMENT_METHOD.BANK_TRANSFER : REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
      note: isCod
        ? 'Customer bank details are required before manual refund.'
        : 'Refund will be processed back to the original prepaid payment method.',
    }, { transaction });
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
  await order.update({
    status: nextStatus,
    status_history: appendOrderStatusHistory(order, nextStatus, actor, cleanReason),
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

  try {
    const data = await ShipRocketService.createReturnOrder({
      order,
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
  createReverseActions,
  finalizeReverseActions,
};
