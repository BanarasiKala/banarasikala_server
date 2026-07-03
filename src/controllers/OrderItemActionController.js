const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const OrderItemAction = require('../models/OrderItemAction');
const OrderRefund = require('../models/OrderRefund');
const { REFUND_STATUS, REFUND_PAYMENT_METHOD } = require('../utils/orderTransactions');
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
const { appendEntry, deriveOrderTotals } = require('../services/orderLedgerService');

const customerOwnsOrder = (order, user) => {
  const isOwnedByCustomerId = Number(order.customer_id) === Number(user?.id);
  const isLegacyOwnedByEmail = !order.customer_id
    && user?.email
    && String(order.customer_email || '').toLowerCase() === String(user.email).toLowerCase();
  return isOwnedByCustomerId || isLegacyOwnedByEmail;
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
      if (!actionType || actionType === ACTION_TYPES.CANCEL) {
        return res.status(400).json({ message: 'Please choose return or exchange. Cancellation applies to the whole order.' });
      }

      const order = await Order.findByPk(req.params.orderId, {
        include: [{ model: OrderItem, include: [OrderItemAction] }],
      });
      if (!order) return res.status(404).json({ message: 'Order not found.' });
      if (req.userRole !== 'admin' && !customerOwnsOrder(order, req.user)) {
        return res.status(403).json({ message: 'This order does not belong to this account.' });
      }

      if (!isDeliveredEnoughForPostDeliveryAction(order)) {
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
      if (!actionType || actionType === ACTION_TYPES.CANCEL) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Please choose return or exchange. Cancellation applies to the whole order.' });
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

      if (!isDeliveredEnoughForPostDeliveryAction(order)) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Return or exchange is available after delivery.' });
      }

      const selections = normalizeItems(req.body.items);
      if (!selections.length) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Please select at least one product.' });
      }

      // ── Return / Exchange → unified OrderReturnService (also books reverse pickup) ──
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
