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
  appendOrderStatusHistory,
  roundMoney,
} = require('../utils/orderItemActions');

const customerOwnsOrder = (order, user) => {
  const isOwnedByCustomerId = Number(order.customer_id) === Number(user?.id);
  const isLegacyOwnedByEmail = !order.customer_id
    && user?.email
    && String(order.customer_email || '').toLowerCase() === String(user.email).toLowerCase();
  return isOwnedByCustomerId || isLegacyOwnedByEmail;
};

const canCancelOrderItems = (order) => {
  const status = String(order?.status || '').toLowerCase();
  if (['cancelled', 'seller cancelled', 'delivered', 'shipped', 'out for delivery', 'picked up', 'picked_up', 'awb assigned', 'awb_assigned'].includes(status) || status.startsWith('rto ')) {
    return false;
  }
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

const getWholeProductActionQuantity = (item) => getActionableQuantity(item);

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

const getRemainingQuantityAfterCancellation = (items = [], cancelledSelections = new Map()) => (
  items.reduce((sum, item) => {
    const selectedQty = Number(cancelledSelections.get(Number(item.id)) || 0);
    const quantity = Number(item.quantity || 0);
    const cancelled = Number(item.cancelled_quantity || 0) + selectedQty;
    return sum + Math.max(0, quantity - cancelled);
  }, 0)
);

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
          : 'Cancellation is available only before dispatch and within 24 hours.';
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

      return res.status(200).json({
        items: estimates,
        totals: estimates.reduce((sum, item) => ({
          item_amount: roundMoney(sum.item_amount + item.item_amount),
          forward_shipping_deduction: roundMoney(sum.forward_shipping_deduction + item.forward_shipping_deduction),
          reverse_shipping_deduction: roundMoney(sum.reverse_shipping_deduction + item.reverse_shipping_deduction),
          estimated_refund_amount: roundMoney(sum.estimated_refund_amount + item.estimated_refund_amount),
        }), { item_amount: 0, forward_shipping_deduction: 0, reverse_shipping_deduction: 0, estimated_refund_amount: 0 }),
      });
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
          : 'Cancellation is available only before dispatch and within 24 hours.';
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

      const itemMap = new Map(orderItems.map((item) => [Number(item.id), item]));
      const reason = String(req.body.reason || '').trim();
      const createdActions = [];
      const cancelledSelections = new Map();
      let cancelledAmount = 0;

      if (actionType === ACTION_TYPES.EXCHANGE && hasOrderExchangeHistory(order)) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Exchange can be requested only once for an order. Remaining products can be returned.' });
      }

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
          const itemUpdate = {
            cancelled_quantity: Number(item.cancelled_quantity || 0) + quantity,
            pending_action_quantity: Number(item.pending_action_quantity || 0),
          };
          itemUpdate.status = statusAfterCompletedAction({ ...item.toJSON(), ...itemUpdate }, actionType);
          await item.update(itemUpdate, { transaction });
          await restockCancelledItem(item, quantity, transaction);
        } else {
          await item.update({
            status: statusForRequestedAction(actionType),
            pending_action_quantity: Number(item.pending_action_quantity || 0) + quantity,
          }, { transaction });
        }

        createdActions.push(action);
      }

      const paymentMethod = String(order.payment_method || '').toUpperCase();
      const orderUpdate = { status: actionOrderStatus(actionType) };
      let refundToCreate = null;
      if (actionType === ACTION_TYPES.RETURN) {
        const returnRefundAmount = roundMoney(createdActions.reduce((sum, action) => sum + Number(action.estimated_refund_amount || 0), 0));
        refundToCreate = {
          refund_type: REFUND_TYPE.RETURN,
          amount: returnRefundAmount,
          status: REFUND_STATUS.PENDING,
          payment_method: paymentMethod === 'COD' ? REFUND_PAYMENT_METHOD.BANK_TRANSFER : REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
          note: paymentMethod === 'COD'
            ? 'Customer bank details are required before manual refund.'
            : 'Refund will be processed back to the original prepaid payment method.',
        };
      } else if (actionType === ACTION_TYPES.CANCEL) {
        const remainingQty = getRemainingQuantityAfterCancellation(orderItems, cancelledSelections);
        const isFullCancellation = remainingQty <= 0;
        const paidAmount = roundMoney(Number(order.payable_amount ?? order.total_amount ?? 0));
        const nextSubtotal = isFullCancellation
          ? 0
          : roundMoney(Math.max(0, Number(order.subtotal_amount || 0) - cancelledAmount));

        // Coupon recalculation on partial cancel
        let newCouponDiscount = roundMoney(Number(order.discount_amount || 0));
        if (!isFullCancellation && order.coupon_code) {
          const Coupon = require('../models/Coupon');
          const coupon = await Coupon.findOne({ where: { code: order.coupon_code, is_active: true }, transaction });
          if (coupon) {
            if (String(coupon.discount_type || '').toLowerCase() === 'percentage') {
              newCouponDiscount = (nextSubtotal * Number(coupon.discount_percent || 0)) / 100;
              if (coupon.max_discount_amount) {
                newCouponDiscount = Math.min(newCouponDiscount, Number(coupon.max_discount_amount));
              }
            } else {
              newCouponDiscount = Math.min(Number(coupon.discount_amount || 0), nextSubtotal);
            }
            newCouponDiscount = roundMoney(newCouponDiscount);
          } else {
            newCouponDiscount = 0;
          }
        }

        // Recalculate total from fixed charges + new subtotal - new discount
        const fixedCharges = roundMoney(
          Number(order.shipping_charge || 0)
          - Number(order.shipping_discount || 0)
          + Number(order.payment_fee || 0)
          - Number(order.payment_discount || 0),
        );
        const walletUsed = roundMoney(Number(order.wallet_amount || 0));
        const nextTotal = isFullCancellation
          ? 0
          : roundMoney(Math.max(0, nextSubtotal + fixedCharges - newCouponDiscount - walletUsed));
        const nextPayable = nextTotal;
        const refundAmount = isFullCancellation
          ? paidAmount
          : roundMoney(Math.max(0, paidAmount - nextPayable));

        orderUpdate.status = remainingQty > 0 ? 'Partially Cancelled' : 'Cancelled';
        if (isFullCancellation) orderUpdate.cancelled_at = new Date();
        orderUpdate.subtotal_amount = nextSubtotal;
        orderUpdate.discount_amount = isFullCancellation ? 0 : newCouponDiscount;
        orderUpdate.total_amount = nextTotal;
        orderUpdate.payable_amount = nextPayable;
        // Lock order against further modifications after any cancel/update
        orderUpdate.is_modified = true;
        orderUpdate.modified_at = new Date();
        orderUpdate.payment_status = paymentMethod === 'COD'
          ? (remainingQty > 0 ? order.payment_status : 'Cancelled')
          : 'Refund Pending';
        refundToCreate = {
          refund_type: isFullCancellation ? REFUND_TYPE.FULL_CANCEL : REFUND_TYPE.PARTIAL_CANCEL,
          amount: paymentMethod === 'COD' ? 0 : refundAmount,
          status: paymentMethod === 'COD' ? REFUND_STATUS.NOT_REQUIRED : REFUND_STATUS.PENDING,
          payment_method: paymentMethod === 'COD' ? REFUND_PAYMENT_METHOD.NOT_REQUIRED : REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
          note: paymentMethod === 'COD'
            ? `Cancellation completed. Remaining COD amount: Rs. ${nextTotal.toLocaleString('en-IN')}.`
            : `Cancellation completed. Refund of Rs. ${refundAmount.toLocaleString('en-IN')} will be processed.`,
        };

        // Decrement coupon usage count on full cancellation
        if (isFullCancellation && order.coupon_code) {
          const Coupon = require('../models/Coupon');
          await Coupon.decrement('usage_count', {
            by: 1,
            where: { code: order.coupon_code, usage_count: { [Op.gt]: 0 } },
            transaction,
          });
        }
      }

      orderUpdate.status_history = appendOrderStatusHistory(order, orderUpdate.status, 'customer', null);
      await order.update(orderUpdate, { transaction });

      if (refundToCreate) {
        await OrderRefund.create({
          order_id: order.id,
          order_item_action_id: createdActions[0]?.id || null,
          ...refundToCreate,
        }, { transaction });
      }

      // Refund wallet on full cancellation
      if (actionType === ACTION_TYPES.CANCEL) {
        const remainingQtyCheck = getRemainingQuantityAfterCancellation(orderItems, cancelledSelections);
        if (remainingQtyCheck <= 0) {
          const walletRefund = Number(order.wallet_amount || 0);
          if (walletRefund > 0 && order.customer_id) {
            await WalletTransaction.create({
              customer_id: order.customer_id,
              amount: walletRefund,
              type: 'ORDER_CANCELLATION_REFUND',
              status: 'completed',
              available_at: null,
              dedupe_key: `order_cancel_wallet:${order.id}`,
              meta: { order_id: order.id },
            }, { transaction });
            await Customer.increment(
              { wallet_balance: walletRefund },
              { where: { id: order.customer_id }, transaction },
            );
          }
        }
      }

      await transaction.commit();

      if (actionType === ACTION_TYPES.CANCEL) {
        const EmailService = require('../services/EmailService');
        const remainingQty = getRemainingQuantityAfterCancellation(orderItems, cancelledSelections);
        const emailStatus = remainingQty <= 0 ? 'Cancelled' : 'Partially Cancelled';
        EmailService.sendOrderStatusUpdate(order, emailStatus).catch((error) => {
          console.error(`[Email] Item action cancel email failed for status ${emailStatus}:`, error.message);
        });
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
          { model: Order, attributes: ['id', 'order_number', 'customer_name', 'customer_email', 'phone', 'payment_method', 'status', 'createdAt'] },
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
      const closesPendingQuantity = [ACTION_STATUS.COMPLETED, ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED].includes(nextStatus);
      const pending = closesPendingQuantity
        ? Math.max(0, Number(item.pending_action_quantity || 0) - quantity)
        : Number(item.pending_action_quantity || 0);
      const itemUpdate = { pending_action_quantity: pending };

      if (nextStatus === ACTION_STATUS.COMPLETED) {
        if (action.action_type === ACTION_TYPES.CANCEL) {
          itemUpdate.cancelled_quantity = Number(item.cancelled_quantity || 0) + quantity;
        } else if (action.action_type === ACTION_TYPES.RETURN) {
          itemUpdate.returned_quantity = Number(item.returned_quantity || 0) + quantity;
        } else if (action.action_type === ACTION_TYPES.EXCHANGE) {
          itemUpdate.exchanged_quantity = Number(item.exchanged_quantity || 0) + quantity;
        }
      }

      const statusSource = { ...item.toJSON(), ...itemUpdate };
      itemUpdate.status = nextStatus === ACTION_STATUS.COMPLETED
        ? statusAfterCompletedAction(statusSource, action.action_type)
        : nextStatus === ACTION_STATUS.REJECTED || nextStatus === ACTION_STATUS.CANCELLED
          ? pending > 0 ? statusForRequestedAction(action.action_type) : 'Active'
          : statusForRequestedAction(action.action_type);

      await item.update(itemUpdate, { transaction });

      const isTerminal = [ACTION_STATUS.COMPLETED, ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED].includes(nextStatus);
      await action.update({
        status: nextStatus,
        reviewed_by: req.user?.id || null,
        reviewed_at: new Date(),
        completed_at: isTerminal ? new Date() : null,
        meta: {
          ...(action.meta || {}),
          admin_note: req.body.note || null,
        },
      }, { transaction });

      // Append terminal action outcome to order's status_history
      if (isTerminal) {
        const orderForHistory = await Order.findByPk(action.order_id, { transaction });
        if (orderForHistory) {
          const historyNote = `${action.action_type} ${nextStatus.toLowerCase()} — qty ${action.quantity}${req.body.note ? ': ' + req.body.note : ''}`;
          await orderForHistory.update({
            status_history: appendOrderStatusHistory(orderForHistory, `${action.action_type} ${nextStatus}`, 'admin', historyNote),
          }, { transaction });
        }
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

              // Bug #2: Wallet proportional refund
              const walletTotal = Number(fullOrder.wallet_amount || 0);
              if (walletTotal > 0 && fullOrder.customer_id) {
                const subtotal = Number(fullOrder.subtotal_amount || 0);
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
                    .catch((err) => console.error('[Razorpay] Return refund failed:', err.message));
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
