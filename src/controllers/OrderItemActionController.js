const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const OrderItemAction = require('../models/OrderItemAction');
const OrderRefund = require('../models/OrderRefund');
const { REFUND_TYPE, REFUND_STATUS, REFUND_PAYMENT_METHOD } = require('../utils/orderTransactions');
const Product = require('../models/Product');
const Color = require('../models/Color');
const Customer = require('../models/Customer');
const WalletTransaction = require('../models/WalletTransaction');
const Payment = require('../models/Payment');
const { refundPayment: razorpayRefund } = require('../services/RazorpayService');
const OrderReturnService = require('../services/OrderReturnService');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const RefundTransaction = require('../models/RefundTransaction');
const OrderLedger = require('../models/OrderLedger');
const { Transaction, Op } = require('sequelize');
const { sequelize } = require('../config/db');
const {
  ACTION_TYPES,
  ACTION_STATUS,
  ensureOrderItemActionSchema,
  normalizeActionType,
  getActionableQuantity,
  calculateItemAction,
  statusForRequestedAction,
  statusAfterCompletedAction,
  isDeliveredEnoughForPostDeliveryAction,
  roundMoney,
} = require('../utils/orderItemActions');
const {
  ACTOR, LEDGER_ENTRY_TYPE, LEDGER_DIRECTION, LEDGER_REFERENCE_TYPE,
} = require('../utils/orderModelV2');
const { appendEntry, deriveOrderTotals, settleCancellation } = require('../services/orderLedgerService');

const customerOwnsOrder = (order, user) => {
  const isOwnedByCustomerId = Number(order.customer_id) === Number(user?.id);
  const isLegacyOwnedByEmail = !order.customer_id
    && user?.email
    && String(order.customer_email || '').toLowerCase() === String(user.email).toLowerCase();
  return isOwnedByCustomerId || isLegacyOwnedByEmail;
};

// Orders can only be modified (items cancelled / quantities reduced) while they
// are still pre-dispatch. Anything past "processing" — picked up, shipped, out
// for delivery, delivered, RTO, etc. — is locked. Allowlist rather than blocklist
// so unexpected statuses default to "not modifiable".
const MODIFIABLE_STATUSES = ['pending', 'processing', 'order placed', 'order_placed'];
const canCancelOrderItems = (order) => {
  const status = String(order?.status || '').toLowerCase();
  if (!MODIFIABLE_STATUSES.includes(status)) return false;
  if (order.is_modified) return false;
  const createdAt = new Date(order.createdAt).getTime();
  return Number.isFinite(createdAt) && Date.now() - createdAt <= 24 * 60 * 60 * 1000;
};

const normalizeItems = (items = []) => {
  if (!Array.isArray(items)) return [];
  const itemMap = new Map();
  items.forEach((item) => {
    const orderItemId = Number(item.orderItemId || item.order_item_id || item.id);
    if (Number.isInteger(orderItemId) && orderItemId > 0) {
      const qty = Number(item.quantity || item.qty || 0);
      itemMap.set(orderItemId, qty > 0 ? qty : null);
    }
  });
  return Array.from(itemMap.entries()).map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
};

const isActionClosedByRejection = (action) => {
  const status = String(action?.status || '').toLowerCase();
  return ['rejected'].includes(status);
};

const hasUsableAction = (item, actionType = null) => {
  const actions = item?.OrderItemActions || [];
  return actions.some((action) => {
    const type = String(action.action_type || '').toLowerCase();
    return (!actionType || type === actionType) && !isActionClosedByRejection(action);
  });
};

const hasOrderExchangeHistory = (order) => (
  (order?.OrderItems || []).some((item) => hasUsableAction(item, ACTION_TYPES.EXCHANGE))
);

const itemActionsOf = (item) => item.OrderItemActions || item.getDataValue?.('OrderItemActions') || [];
const getWholeProductActionQuantity = (item) => getActionableQuantity(item, itemActionsOf(item));

const actionOrderStatus = (actionType) => {
  if (actionType === ACTION_TYPES.CANCEL) return 'Cancel Requested';
  if (actionType === ACTION_TYPES.RETURN) return 'Return Initiated';
  return 'Exchange Initiated';
};

const restockCancelledItem = async (item, quantity, transaction) => {
  const product = await Product.findByPk(item.product_id, {
    attributes: ['id', 'stock_quantity', 'color_stocks'],
    transaction,
    lock: Transaction.LOCK.UPDATE,
  });
  if (!product) return;

  const colorId = item.colorId || item.color_id;
  const nextStock = Number(product.stock_quantity || 0) + quantity;
  const updatePayload = { stock_quantity: nextStock };

  if (colorId !== null && colorId !== undefined && colorId !== '') {
    const stocks = { ...(product.color_stocks || {}) };
    const key = String(colorId);
    stocks[key] = Number(stocks[key] || 0) + quantity;
    updatePayload.color_stocks = stocks;
  }

  await product.update(updatePayload, { transaction });
};

// Remaining live units = ordered quantity minus units already covered by action
// rows (existing + the selections being made now). Counters are gone, so this is
// derived from the action rows.
const getRemainingQuantityAfterCancellation = (items = [], cancelledSelections = new Map(), existingActions = []) => (
  items.reduce((sum, item) => {
    const alreadyActioned = Number(item.quantity || 0) - getActionableQuantity(item, existingActions);
    const selectedQty = Number(cancelledSelections.get(Number(item.id)) || 0);
    return sum + Math.max(0, Number(item.quantity || 0) - alreadyActioned - selectedQty);
  }, 0)
);

/**
 * V2: keep the ShipRocket forward shipment in step with a cancel. Courier data
 * lives on the shipment and delivery is free to the customer, so a partial
 * cancel doesn't change what they owe. We cancel the (pre-dispatch) ShipRocket
 * order and mark the shipment; a fresh push for the remaining items is left to
 * admin. Best-effort and post-commit — never blocks or rolls back the cancel.
 */
const syncShiprocketAfterCancel = async (order, isFullCancellation) => {
  const Shipment = require('../models/Shipment');
  const { SHIPMENT_TYPE } = require('../utils/orderModelV2');
  const ShipRocketService = require('../services/ShipRocketService');

  const fwd = await Shipment.findOne({
    where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD },
    order: [['created_at', 'DESC']],
  });
  if (!fwd?.shiprocket_order_id) return;

  try {
    await ShipRocketService.cancelOrders([fwd.shiprocket_order_id]);
    await fwd.update({ status: 'CANCELLED', awb_number: null });
  } catch (error) {
    console.error('[OrderItemAction] ShipRocket cancel failed:', error?.response?.data || error.message);
    return;
  }
  if (!isFullCancellation) {
    console.warn(`[OrderItemAction] Order #${order.id} partially cancelled — ShipRocket needs a fresh push for the remaining items.`);
  }
};

/**
 * Single source of truth for the money outcome of a cancellation — used by both
 * the pre-submit estimate and the actual create() flow so the number the
 * customer sees is exactly what they get refunded.
 *
 * Rules:
 *  - Full cancellation refunds the entire amount the customer paid
 *    (payable_amount), wallet included (the wallet portion is credited back
 *    separately by create()).
 *  - Partial cancellation keeps the order alive: the wallet balance the customer
 *    spent stays applied to the remaining items (never refunded mid-order), and
 *    the coupon is re-evaluated against the reduced subtotal. If the remaining
 *    subtotal no longer meets the original coupon's minimum purchase amount, the
 *    best alternative coupon the customer is still eligible for is auto-applied;
 *    if none qualifies the coupon is dropped. The refund is the difference
 *    between what was paid and the repriced remaining payable.
 */
const computeCancelRefund = async ({ order, orderItems, cancelledSelections, cancelledAmount, transaction = null, existingActions = [] }) => {
  const totals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: order.id }, transaction }));
  const remainingQty = getRemainingQuantityAfterCancellation(orderItems, cancelledSelections, existingActions);
  const isFullCancellation = remainingQty <= 0;
  const paidAmount = roundMoney(totals.amount_paid);
  const nextSubtotal = isFullCancellation
    ? 0
    : roundMoney(Math.max(0, totals.subtotal_amount - Number(cancelledAmount || 0)));

  const originalCouponCode = order.coupon_code || null;
  let newCouponDiscount = roundMoney(totals.discount_amount);
  let appliedCouponCode = originalCouponCode;
  let couponRemoved = false;
  let couponReplaced = false;

  const discountForCoupon = (coupon, amount) => {
    if (String(coupon.discount_type || '').toLowerCase() === 'percentage') {
      let d = (amount * Number(coupon.discount_percent || 0)) / 100;
      if (coupon.max_discount_amount) d = Math.min(d, Number(coupon.max_discount_amount));
      return roundMoney(d);
    }
    return roundMoney(Math.min(Number(coupon.discount_amount || 0), amount));
  };

  if (isFullCancellation) {
    newCouponDiscount = 0;
    appliedCouponCode = null;
  } else if (originalCouponCode) {
    const Coupon = require('../models/Coupon');
    const coupon = await Coupon.findOne({ where: { code: originalCouponCode, is_active: true }, transaction });
    const minPurchase = Number(coupon?.min_purchase_amount || 0);
    const stillEligible = coupon && (minPurchase <= 0 || nextSubtotal >= minPurchase);
    if (stillEligible) {
      newCouponDiscount = discountForCoupon(coupon, nextSubtotal);
      appliedCouponCode = coupon.code;
    } else {
      // Original coupon no longer applies to the reduced order — offer the best
      // alternative the customer is still eligible for, else drop the coupon.
      const CouponService = require('../services/CouponService');
      const best = await CouponService.findBestCoupon(
        nextSubtotal,
        { customerId: order.customer_id, email: order.customer_email },
        { transaction },
      );
      if (best && best.discount > 0) {
        newCouponDiscount = roundMoney(best.discount);
        appliedCouponCode = best.code;
        couponReplaced = best.code !== originalCouponCode;
        couponRemoved = false;
      } else {
        newCouponDiscount = 0;
        appliedCouponCode = null;
        couponRemoved = roundMoney(totals.discount_amount) > 0 || Boolean(originalCouponCode);
      }
    }
  }

  // Non-item charges that stay on the order after a partial cancel (from ledger).
  const deliveryGross = roundMoney(totals.shipping_charge);
  const deliveryNet = roundMoney(totals.shipping_charge);
  const paymentFee = roundMoney(totals.payment_fee);
  const codFee = roundMoney(totals.cod_fee);
  const platformFee = roundMoney(totals.platform_fee);
  const paymentDiscount = roundMoney(totals.payment_discount);
  const giftCharge = roundMoney(totals.gift_charge);
  const fixedCharges = roundMoney(deliveryNet + paymentFee + giftCharge - paymentDiscount);

  const walletUsed = roundMoney(totals.wallet_amount);
  const nextTotal = isFullCancellation
    ? 0
    : roundMoney(Math.max(0, nextSubtotal + fixedCharges - newCouponDiscount - walletUsed));
  const nextPayable = nextTotal;
  const refundAmount = isFullCancellation
    ? paidAmount
    : roundMoney(Math.max(0, paidAmount - nextPayable));

  const origSubtotal = roundMoney(totals.subtotal_amount);
  const origCouponDiscount = roundMoney(totals.discount_amount);
  const cancelledItemsValue = isFullCancellation
    ? origSubtotal
    : roundMoney(Number(cancelledAmount || 0));
  // The discount the customer loses by removing items (positive number).
  const couponLoss = roundMoney(Math.max(0, origCouponDiscount - newCouponDiscount));

  return {
    remainingQty,
    isFullCancellation,
    paidAmount,
    origSubtotal,
    origCouponDiscount,
    cancelledItemsValue,
    // Non-item charge components (for a checkout-style bill in the modal).
    deliveryGross,
    deliveryNet,
    platformFee,
    codFee,
    paymentDiscount,
    giftCharge,
    fixedCharges,
    nextSubtotal,
    newCouponDiscount,
    couponLoss,
    couponRemoved,
    couponReplaced,
    appliedCouponCode,
    originalCouponCode,
    walletUsed,
    walletPreserved: !isFullCancellation && walletUsed > 0,
    nextTotal,
    nextPayable,
    refundAmount,
  };
};

const serializeAction = (action) => {
  const json = typeof action?.toJSON === 'function' ? action.toJSON() : action;
  return {
    ...json,
    item_amount: roundMoney(json.item_amount),
    forward_shipping_deduction: roundMoney(json.forward_shipping_deduction),
    reverse_shipping_deduction: roundMoney(json.reverse_shipping_deduction),
    estimated_refund_amount: roundMoney(json.estimated_refund_amount),
  };
};

class OrderItemActionController {
  async estimate(req, res) {
    try {
      await ensureOrderItemActionSchema();
      const actionType = normalizeActionType(req.body.actionType || req.body.action_type);
      if (!actionType) return res.status(400).json({ message: 'Please choose cancel, return or exchange.' });

      const order = await Order.findByPk(req.params.orderId, {
        include: [{ model: OrderItem, include: [OrderItemAction] }],
      });
      if (!order) return res.status(404).json({ message: 'Order not found.' });
      if (req.userRole !== 'admin' && !customerOwnsOrder(order, req.user)) {
        return res.status(403).json({ message: 'This order does not belong to this account.' });
      }

      if (actionType === ACTION_TYPES.CANCEL && !canCancelOrderItems(order)) {
        const msg = order.is_modified
          ? 'This order has already been modified and cannot be changed again.'
          : 'Order changes are available only while it is still processing and within 24 hours.';
        return res.status(400).json({ message: msg });
      }
      if ([ACTION_TYPES.RETURN, ACTION_TYPES.EXCHANGE].includes(actionType) && !isDeliveredEnoughForPostDeliveryAction(order)) {
        return res.status(400).json({ message: 'Return or exchange is available after delivery.' });
      }

      const selections = normalizeItems(req.body.items);
      const itemMap = new Map((order.OrderItems || []).map((item) => [Number(item.id), item]));
      const estimates = selections.map((selection) => {
        const item = itemMap.get(selection.orderItemId);
        if (!item) return null;
        if (hasUsableAction(item)) {
          return null;
        }
        if (actionType === ACTION_TYPES.EXCHANGE && hasOrderExchangeHistory(order)) {
          return null;
        }
        const maxQty = getWholeProductActionQuantity(item);
        const quantity = (selection.quantity > 0) ? Math.min(selection.quantity, maxQty) : maxQty;
        if (quantity < 1) return null;
        return {
          order_item_id: item.id,
          product_name: item.product_name,
          quantity,
          ...calculateItemAction({ order, item, actionType, quantity }),
        };
      }).filter(Boolean);

      const totals = estimates.reduce((sum, item) => ({
        item_amount: roundMoney(sum.item_amount + item.item_amount),
        forward_shipping_deduction: roundMoney(sum.forward_shipping_deduction + item.forward_shipping_deduction),
        reverse_shipping_deduction: roundMoney(sum.reverse_shipping_deduction + item.reverse_shipping_deduction),
        estimated_refund_amount: roundMoney(sum.estimated_refund_amount + item.estimated_refund_amount),
      }), { item_amount: 0, forward_shipping_deduction: 0, reverse_shipping_deduction: 0, estimated_refund_amount: 0 });

      // For cancellations the true refund is order-level (it accounts for the
      // wallet staying applied, fees, and coupon re-eligibility), not just the
      // sum of item prices. Override the headline refund with that real figure
      // so the modal shows exactly what the customer will get back.
      if (actionType === ACTION_TYPES.CANCEL && estimates.length) {
        const cancelledSelections = new Map(estimates.map((e) => [Number(e.order_item_id), Number(e.quantity)]));
        const cancelledAmount = estimates.reduce((sum, e) => sum + Number(e.item_amount || 0), 0);
        const refund = await computeCancelRefund({
          order,
          orderItems: order.OrderItems || [],
          cancelledSelections,
          cancelledAmount,
        });
        totals.estimated_refund_amount = refund.refundAmount;
        const paymentMethod = String(order.payment_method || '').toUpperCase();
        return res.status(200).json({
          items: estimates,
          totals,
          is_full_cancellation: refund.isFullCancellation,
          payment_method: paymentMethod,
          // Coupon outcome on the repriced order.
          coupon_removed: refund.couponRemoved,
          coupon_replaced: refund.couponReplaced,
          original_coupon_code: refund.originalCouponCode,
          applied_coupon_code: refund.appliedCouponCode,
          wallet_preserved: refund.walletPreserved,
          // On a full cancel the wallet portion is credited back to the wallet
          // separately from the gateway refund shown above.
          wallet_refund: refund.isFullCancellation ? refund.walletUsed : 0,
          paid_amount: refund.paidAmount,
          remaining_payable: refund.nextPayable,
          refund_amount: refund.refundAmount,
          new_coupon_discount: refund.newCouponDiscount,
          // Itemised figures so the modal can show the full refund / new-total math.
          breakdown: {
            cancelled_items_value: refund.cancelledItemsValue,
            coupon_loss: refund.couponLoss,
            fixed_charges: refund.fixedCharges,
            wallet_used: refund.walletUsed,
            remaining_items_value: refund.nextSubtotal,
            new_coupon_discount: refund.newCouponDiscount,
            orig_coupon_discount: refund.origCouponDiscount,
          },
          // Checkout-style bill for the remaining order (partial cancel) so the
          // modal can render the same line items the customer saw at checkout,
          // with the refund shown below.
          new_order_summary: {
            subtotal: refund.nextSubtotal,
            platform_fee: refund.platformFee,
            cod_fee: refund.codFee,
            delivery: refund.deliveryNet,
            delivery_gross: refund.deliveryGross,
            prepaid_discount: refund.paymentDiscount,
            gift_charge: refund.giftCharge,
            coupon_code: refund.appliedCouponCode,
            coupon_discount: refund.newCouponDiscount,
            wallet_used: refund.walletUsed,
            total: refund.nextPayable,
          },
        });
      }

      return res.status(200).json({ items: estimates, totals });
    } catch (error) {
      console.error('[OrderItemAction] estimate error:', error.message);
      return res.status(500).json({ message: 'Unable to calculate this request right now.' });
    }
  }

  async create(req, res) {
    const transaction = await sequelize.transaction();
    try {
      await ensureOrderItemActionSchema();
      const actionType = normalizeActionType(req.body.actionType || req.body.action_type);
      if (!actionType) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Please choose cancel, return or exchange.' });
      }

      const order = await Order.findByPk(req.params.orderId, {
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      if (!order) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Order not found.' });
      }

      const orderItems = await OrderItem.findAll({
        where: { order_id: order.id },
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      const itemActions = await OrderItemAction.findAll({
        where: { order_id: order.id },
        transaction,
      });
      orderItems.forEach((item) => {
        item.setDataValue(
          'OrderItemActions',
          itemActions.filter((action) => Number(action.order_item_id) === Number(item.id)),
        );
      });
      order.setDataValue('OrderItems', orderItems);
      if (req.userRole !== 'admin' && !customerOwnsOrder(order, req.user)) {
        await transaction.rollback();
        return res.status(403).json({ message: 'This order does not belong to this account.' });
      }

      if (actionType === ACTION_TYPES.CANCEL && !canCancelOrderItems(order)) {
        await transaction.rollback();
        const msg = order.is_modified
          ? 'This order has already been modified and cannot be changed again.'
          : 'Order changes are available only while it is still processing and within 24 hours.';
        return res.status(400).json({ message: msg });
      }
      if ([ACTION_TYPES.RETURN, ACTION_TYPES.EXCHANGE].includes(actionType) && !isDeliveredEnoughForPostDeliveryAction(order)) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Return or exchange is available after delivery.' });
      }

      const selections = normalizeItems(req.body.items);
      if (!selections.length) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Please select at least one product.' });
      }

      // ── Return / Exchange → unified OrderReturnService (also books reverse pickup) ──
      if (actionType !== ACTION_TYPES.CANCEL) {
        let result;
        try {
          result = await OrderReturnService.createReverseActions({
            order,
            orderItems,
            itemActions,
            actionType,
            selections,
            reason: req.body.reason,
            comments: req.body.comments,
            requestedBy: req.userRole === 'admin' ? null : req.user?.id,
            actor: req.userRole === 'admin' ? 'admin' : 'customer',
            transaction,
          });
        } catch (error) {
          await transaction.rollback();
          if (error instanceof OrderReturnService.ReverseActionError) {
            return res.status(error.status).json({ message: error.message });
          }
          throw error;
        }

        await transaction.commit();

        const finalize = await OrderReturnService.finalizeReverseActions({
          order,
          entries: result.entries,
          actionType,
          reason: req.body.reason,
        });

        const EmailService = require('../services/EmailService');
        const emailStatus = actionType === ACTION_TYPES.RETURN ? 'Return Initiated' : 'Exchange Initiated';
        EmailService.sendOrderStatusUpdate(order, emailStatus).catch((emailError) => {
          console.error(`[Email] ${emailStatus} email failed:`, emailError.message);
        });

        return res.status(201).json({
          message: actionType === ACTION_TYPES.RETURN ? 'Return request submitted.' : 'Exchange request submitted.',
          actions: result.actions.map(serializeAction),
          shiprocket_return_order_id: finalize.shiprocketReturnId,
          shipment_id: finalize.shipmentId,
        });
      }

      // ── Cancel (item-level) — completes immediately, restocks, recomputes totals ──
      const itemMap = new Map(orderItems.map((item) => [Number(item.id), item]));
      const reason = String(req.body.reason || '').trim();
      const createdActions = [];
      const cancelledSelections = new Map();
      let cancelledAmount = 0;

      for (const selection of selections) {
        const item = itemMap.get(selection.orderItemId);
        if (!item) {
          await transaction.rollback();
          return res.status(404).json({ message: 'One selected product was not found in this order.' });
        }
        if (hasUsableAction(item)) {
          await transaction.rollback();
          return res.status(400).json({
            message: `${item.product_name || 'This product'} already has an action request. Please choose another product.`,
          });
        }
        const maxQty = getWholeProductActionQuantity(item);
        const quantity = (selection.quantity > 0) ? Math.min(Number(selection.quantity), maxQty) : maxQty;
        if (quantity < 1) {
          await transaction.rollback();
          return res.status(400).json({ message: `${item.product_name || 'This product'} is not available for this request.` });
        }

        const calculation = calculateItemAction({ order, item, actionType, quantity });
        const action = await OrderItemAction.create({
          order_id: order.id,
          order_item_id: item.id,
          product_id: item.product_id,
          action_type: actionType,
          quantity,
          status: actionType === ACTION_TYPES.CANCEL ? ACTION_STATUS.COMPLETED : ACTION_STATUS.INITIATED,
          completed_at: actionType === ACTION_TYPES.CANCEL ? new Date() : null,
          reason,
          ...calculation,
          requested_by: req.userRole === 'admin' ? null : req.user?.id,
          meta: {
            customer_message: req.body.comments || null,
            sku: item.sku || null,
            color_id: item.colorId || item.color_id || null,
          },
        }, { transaction });

        if (actionType === ACTION_TYPES.CANCEL) {
          const itemId = Number(item.id);
          cancelledSelections.set(itemId, Number(cancelledSelections.get(itemId) || 0) + quantity);
          cancelledAmount += Number(calculation.item_amount || 0);
          const fullyCancelled = quantity >= Number(item.quantity || 0);
          await item.update(
            { status: statusAfterCompletedAction(actionType, fullyCancelled) },
            { transaction },
          );
          await restockCancelledItem(item, quantity, transaction);
        } else {
          await item.update({
            status: statusForRequestedAction(actionType),
          }, { transaction });
        }

        createdActions.push(action);
      }

      // Remaining live units derived from action rows (counters are gone).
      const allActions = [...itemActions, ...createdActions];
      const cancelRemainingQty = orderItems.reduce((sum, it) => sum + getActionableQuantity(it, allActions), 0);

      const paymentMethod = String(order.payment_method || '').toUpperCase();
      const isCodOrder = paymentMethod === 'COD';
      const orderUpdate = { status: actionOrderStatus(actionType) };
      let refundToCreate = null;
      let walletRefundForCancel = 0;
      let cancelGatewayRefund = 0;

      if (actionType === ACTION_TYPES.CANCEL) {
        const isFullCancellation = cancelRemainingQty <= 0;

        // Coupon re-evaluation + bill components (money sourced from the ledger).
        const billing = await computeCancelRefund({
          order, orderItems, cancelledSelections, cancelledAmount, transaction, existingActions: itemActions,
        });

        // Settle the cancellation on the ledger.
        const settled = await settleCancellation({
          orderId: order.id,
          isFull: isFullCancellation,
          cancelledValue: roundMoney(cancelledAmount),
          couponLoss: billing.couponLoss,
          isCod: isCodOrder,
          transaction,
        });
        walletRefundForCancel = isFullCancellation ? settled.walletRefund : 0;
        cancelGatewayRefund = isCodOrder ? 0 : settled.refundAmount;

        orderUpdate.status = isFullCancellation ? 'Cancelled' : 'Partially Cancelled';
        if (isFullCancellation) {
          orderUpdate.cancelled_at = new Date();
          orderUpdate.coupon_code = null;
        } else if (billing.appliedCouponCode !== order.coupon_code) {
          orderUpdate.coupon_code = billing.appliedCouponCode;
        }
        orderUpdate.payment_status = isCodOrder
          ? (isFullCancellation ? 'Cancelled' : order.payment_status)
          : 'Refund Pending';

        refundToCreate = {
          refund_type: isFullCancellation ? REFUND_TYPE.FULL_CANCEL : REFUND_TYPE.PARTIAL_CANCEL,
          amount: isCodOrder ? 0 : settled.refundAmount,
          status: isCodOrder ? REFUND_STATUS.NOT_REQUIRED : REFUND_STATUS.PENDING,
          payment_method: isCodOrder ? REFUND_PAYMENT_METHOD.NOT_REQUIRED : REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
          note: isCodOrder
            ? `Cancellation completed. Remaining COD amount: Rs. ${billing.nextTotal.toLocaleString('en-IN')}.`
            : `Cancellation completed. Refund of Rs. ${settled.refundAmount.toLocaleString('en-IN')} will be processed.`,
        };

        // Keep coupon usage counts in step.
        const Coupon = require('../models/Coupon');
        const releaseOriginal = (isFullCancellation || billing.couponRemoved || billing.couponReplaced) && billing.originalCouponCode;
        if (releaseOriginal) {
          await Coupon.decrement('usage_count', { by: 1, where: { code: billing.originalCouponCode, usage_count: { [Op.gt]: 0 } }, transaction });
        }
        if (!isFullCancellation && billing.couponReplaced && billing.appliedCouponCode) {
          await Coupon.increment('usage_count', { by: 1, where: { code: billing.appliedCouponCode }, transaction });
        }
      }

      const prevOrderStatus = order.status;
      await order.update(orderUpdate, { transaction });
      if (orderUpdate.status && orderUpdate.status !== prevOrderStatus) {
        await OrderStatusHistory.create({
          order_id: order.id, from_status: prevOrderStatus, to_status: orderUpdate.status,
          actor: req.userRole === 'admin' ? ACTOR.ADMIN : ACTOR.CUSTOMER, reason: reason || null,
        }, { transaction });
      }

      if (refundToCreate) {
        await OrderRefund.create({
          order_id: order.id,
          order_item_action_id: createdActions[0]?.id || null,
          ...refundToCreate,
        }, { transaction });
      }

      // Refund wallet credit on full cancellation.
      if (walletRefundForCancel > 0 && order.customer_id) {
        await WalletTransaction.create({
          customer_id: order.customer_id,
          amount: walletRefundForCancel,
          type: 'ORDER_CANCELLATION_REFUND',
          status: 'completed',
          available_at: null,
          dedupe_key: `order_cancel_wallet:${order.id}`,
          meta: { order_id: order.id },
        }, { transaction });
        await Customer.increment(
          { wallet_balance: walletRefundForCancel },
          { where: { id: order.customer_id }, transaction },
        );
      }

      await transaction.commit();

      if (actionType === ACTION_TYPES.CANCEL) {
        const EmailService = require('../services/EmailService');
        const isFullCancel = cancelRemainingQty <= 0;
        const emailStatus = isFullCancel ? 'Cancelled' : 'Partially Cancelled';
        EmailService.sendOrderStatusUpdate(order, emailStatus).catch((error) => {
          console.error(`[Email] Item action cancel email failed for status ${emailStatus}:`, error.message);
        });

        // Fire-and-forget prepaid gateway refund.
        if (cancelGatewayRefund > 0) {
          Payment.findOne({ where: { order_id: order.id, status: 'Paid' } }).then((payment) => {
            if (payment?.gateway_payment_id) {
              return razorpayRefund(payment.gateway_payment_id, cancelGatewayRefund, { reason: 'Customer cancellation', orderId: String(order.id) });
            }
          }).catch((err) => console.error(`[Razorpay] Item cancel refund failed for #${order.id}:`, err?.message || err));
        }

        // Best-effort: keep the ShipRocket forward shipment in step.
        (async () => {
          try {
            await syncShiprocketAfterCancel(order, isFullCancel);
          } catch (error) {
            console.error('[OrderItemAction] post-cancel sync failed:', error.message);
          }
        })();
      }

      return res.status(201).json({
        message: actionType === ACTION_TYPES.CANCEL
          ? 'Cancellation completed.'
          : actionType === ACTION_TYPES.RETURN
            ? 'Return request submitted.'
            : 'Exchange request submitted.',
        actions: createdActions.map(serializeAction),
      });
    } catch (error) {
      await transaction.rollback();
      console.error('[OrderItemAction] create error:', error);
      return res.status(500).json({ message: 'Unable to submit this request right now.' });
    }
  }

  async listAdmin(req, res) {
    try {
      await ensureOrderItemActionSchema();
      const where = {};
      const actionType = normalizeActionType(req.query.type);
      if (actionType) where.action_type = actionType;
      if (req.query.status) where.status = String(req.query.status);

      const actions = await OrderItemAction.findAll({
        where,
        include: [
          { model: Order, attributes: ['id', 'order_number', 'customer_name', 'customer_email', 'payment_method', 'status', 'createdAt'] },
          {
            model: OrderItem,
            include: [
              { model: Product, attributes: ['id', 'name', 'slug', 'images'] },
              { model: Color, attributes: ['id', 'name', 'slug', 'hex_code'] },
            ],
          },
        ],
        order: [['createdAt', 'DESC']],
      });

      return res.status(200).json(actions.map(serializeAction));
    } catch (error) {
      console.error('[OrderItemAction] admin list error:', error.message);
      return res.status(500).json({ message: 'Unable to load requests right now.' });
    }
  }

  async updateAdminStatus(req, res) {
    const transaction = await sequelize.transaction();
    try {
      await ensureOrderItemActionSchema();
      const nextStatus = String(req.body.status || '').trim();
      if (!Object.values(ACTION_STATUS).includes(nextStatus)) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Please choose a valid request status.' });
      }

      const action = await OrderItemAction.findByPk(req.params.actionId, {
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      if (!action) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Request not found.' });
      }
      if ([ACTION_STATUS.COMPLETED, ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED].includes(action.status)) {
        await transaction.rollback();
        return res.status(400).json({ message: 'This request has already been closed.' });
      }

      const item = await OrderItem.findByPk(action.order_item_id, {
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      if (!item) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Order item not found.' });
      }

      const quantity = Number(action.quantity || 0);
      const isTerminal = [ACTION_STATUS.COMPLETED, ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED].includes(nextStatus);

      // Item status pointer — actioned quantity is derived from action rows now.
      let itemStatus;
      if (nextStatus === ACTION_STATUS.COMPLETED) {
        const completed = await OrderItemAction.findAll({
          where: { order_item_id: item.id, action_type: action.action_type, status: ACTION_STATUS.COMPLETED },
          transaction,
        });
        const completedQty = completed.reduce((s, a) => s + Number(a.quantity || 0), quantity);
        itemStatus = statusAfterCompletedAction(action.action_type, completedQty >= Number(item.quantity || 0));
      } else if (nextStatus === ACTION_STATUS.REJECTED || nextStatus === ACTION_STATUS.CANCELLED) {
        const otherOpen = await OrderItemAction.count({
          where: {
            order_item_id: item.id, id: { [Op.ne]: action.id },
            status: { [Op.notIn]: [ACTION_STATUS.COMPLETED, ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] },
          },
          transaction,
        });
        itemStatus = otherOpen > 0 ? statusForRequestedAction(action.action_type) : 'Active';
      } else {
        itemStatus = statusForRequestedAction(action.action_type);
      }
      await item.update({ status: itemStatus }, { transaction });

      await action.update({
        status: nextStatus,
        reviewed_by: req.user?.id || null,
        reviewed_at: new Date(),
        completed_at: isTerminal ? new Date() : null,
        meta: { ...(action.meta || {}), admin_note: req.body.note || null },
      }, { transaction });

      // On return completion, settle the refund on the ledger atomically:
      // reverse the product value, keep forward + reverse shipping, refund the rest.
      let returnRefundAmount = 0;
      if (nextStatus === ACTION_STATUS.COMPLETED && action.action_type === ACTION_TYPES.RETURN) {
        const orderForRefund = await Order.findByPk(action.order_id, { transaction });
        const isCodOrder = String(orderForRefund?.payment_method || '').toUpperCase() === 'COD';
        const itemValue = roundMoney(Number(action.item_amount || 0));
        const deductions = roundMoney(Number(action.forward_shipping_deduction || 0) + Number(action.reverse_shipping_deduction || 0));
        returnRefundAmount = roundMoney(Math.max(0, Number(action.estimated_refund_amount ?? (itemValue - deductions))));

        if (itemValue > 0) {
          await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.PRODUCT_CHARGE, amount: itemValue, direction: LEDGER_DIRECTION.CREDIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: action.id, note: 'Return — product value reversed' }, transaction);
        }
        if (deductions > 0) {
          await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.SHIPPING_CHARGE, amount: deductions, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: action.id, note: 'Return — forward + reverse shipping retained' }, transaction);
        }
        if (returnRefundAmount > 0) {
          const refLedger = await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.REFUND, amount: returnRefundAmount, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: action.id, note: 'Return refund' }, transaction);
          await RefundTransaction.create({
            order_id: action.order_id, ledger_entry_id: refLedger?.id || null,
            gateway: isCodOrder ? 'bank_transfer' : 'original_gateway', amount: returnRefundAmount, status: 'Pending',
          }, { transaction });
        }
      }

      // Status-history entry on any terminal outcome.
      if (isTerminal) {
        const prevOrder = await Order.findByPk(action.order_id, { transaction });
        const historyNote = `${action.action_type} ${nextStatus.toLowerCase()} — qty ${action.quantity}${req.body.note ? ': ' + req.body.note : ''}`;
        await OrderStatusHistory.create({
          order_id: action.order_id,
          from_status: prevOrder?.status || null,
          to_status: `${action.action_type} ${nextStatus}`,
          actor: ACTOR.ADMIN,
          reason: historyNote,
        }, { transaction });
      }

      await transaction.commit();

      // Fire-and-forget: post-completion side-effects
      if (nextStatus === ACTION_STATUS.COMPLETED) {
        const EmailService = require('../services/EmailService');
        setImmediate(async () => {
          try {
            const fullOrder = await Order.findByPk(action.order_id);
            if (!fullOrder) return;

            // Send customer status email
            const emailStatus = action.action_type === ACTION_TYPES.RETURN ? 'Return Completed' : 'Exchange Completed';
            EmailService.sendOrderStatusUpdate(fullOrder, emailStatus).catch((err) => {
              console.error('[Email] Completion email failed:', err.message);
            });

            if (action.action_type === ACTION_TYPES.RETURN) {
              const refund = await OrderRefund.findOne({ where: { order_item_action_id: action.id } });

              // Wallet proportional refund — wallet/subtotal sourced from the ledger.
              const orderTotals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: fullOrder.id } }));
              const walletTotal = Number(orderTotals.wallet_amount || 0);
              if (walletTotal > 0 && fullOrder.customer_id) {
                const subtotal = Number(orderTotals.subtotal_amount || 0);
                const refundAmt = Number(refund?.amount || 0);
                const walletShare = subtotal > 0 && refundAmt > 0
                  ? Math.round((refundAmt / subtotal) * walletTotal * 100) / 100
                  : 0;
                if (walletShare > 0) {
                  const dedupeKey = `return_wallet:${action.id}`;
                  const existing = await WalletTransaction.findOne({ where: { dedupe_key: dedupeKey } });
                  if (!existing) {
                    await WalletTransaction.create({
                      customer_id: fullOrder.customer_id,
                      amount: walletShare,
                      type: 'RETURN_REFUND',
                      status: 'completed',
                      dedupe_key: dedupeKey,
                      meta: { order_id: fullOrder.id, action_id: action.id },
                    });
                    await Customer.increment({ wallet_balance: walletShare }, { where: { id: fullOrder.customer_id } });
                  }
                }
              }

              // Bug #1: Razorpay gateway refund
              if (refund && Number(refund.amount) > 0 && refund.payment_method === REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY) {
                const payment = await Payment.findOne({ where: { order_id: fullOrder.id, status: 'Paid' } });
                if (payment?.gateway_payment_id) {
                  razorpayRefund(payment.gateway_payment_id, Number(refund.amount), {
                    reason: 'Customer return approved',
                  }).then(() => refund.update({ status: REFUND_STATUS.PROCESSING }))
                    .catch((err) => {
                      console.error('[Razorpay] Return refund failed:', err.message);
                      // Surface the failure so admin can retry instead of it sitting silently Pending.
                      refund.update({
                        status: REFUND_STATUS.FAILED,
                        note: `${refund.note || ''}${refund.note ? ' | ' : ''}Automatic gateway refund failed: ${err.message}. Manual retry required.`.slice(0, 1000),
                      }).catch((updateErr) => console.error('[Razorpay] Failed to mark refund Failed:', updateErr.message));
                    });
                }
              }
            }

            // Bug #5: Exchange replacement admin alert
            if (action.action_type === ACTION_TYPES.EXCHANGE) {
              const adminEmail = process.env.ADMIN_EMAIL;
              if (adminEmail && EmailService.sendOrderStatusUpdate) {
                const alertOrder = { ...fullOrder.toJSON(), exchange_alert: true };
                EmailService.sendOrderStatusUpdate(alertOrder, 'Exchange Completed - Replacement Required').catch(() => {});
              }
              console.warn(`[Exchange] Action #${action.id} for Order #${fullOrder.order_number || fullOrder.id} completed — replacement shipment must be created manually.`);
            }
          } catch (err) {
            console.error('[OrderItemAction] post-complete async error:', err.message);
          }
        });
      }

      const replacementRequired = nextStatus === ACTION_STATUS.COMPLETED && action.action_type === ACTION_TYPES.EXCHANGE;
      return res.status(200).json({
        message: 'Request updated.',
        action: serializeAction(action),
        ...(replacementRequired ? { replacement_required: true } : {}),
      });
    } catch (error) {
      await transaction.rollback();
      console.error('[OrderItemAction] admin update error:', error);
      return res.status(500).json({ message: 'Unable to update this request right now.' });
    }
  }
}

module.exports = new OrderItemActionController();
