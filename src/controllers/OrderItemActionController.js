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
      // Exchange only: the colour variant of the SAME product the customer
      // wants instead. Null/absent means "same colour" (or a single-variant
      // product with no choice to make).
      const rawColor = item.exchangeColorId ?? item.exchange_color_id ?? null;
      const exchangeColorId = Number(rawColor) > 0 ? Number(rawColor) : null;
      itemMap.set(orderItemId, { quantity: qty > 0 ? qty : null, exchangeColorId });
    }
  });
  return Array.from(itemMap.entries()).map(([orderItemId, value]) => ({
    orderItemId,
    quantity: value.quantity,
    exchangeColorId: value.exchangeColorId,
  }));
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

      // Coupon + pickup-charge preview: same maths as the real request, so the
      // modal shows exactly what will be saved when the return is submitted.
      totals.coupon_adjustment = 0;
      totals.return_shipping_charge = 0;
      let couponBreakdown = null;
      if (actionType === ACTION_TYPES.RETURN && estimates.length) {
        const orderItems = order.OrderItems || [];
        const itemActions = orderItems.flatMap((item) => item.OrderItemActions || []);
        const targets = estimates.map((estimateRow) => ({
          item: itemMap.get(estimateRow.order_item_id),
          quantity: estimateRow.quantity,
        }));
        const refundInfo = await OrderReturnService.computeReturnRefund({ order, orderItems, itemActions, targets });
        totals.coupon_adjustment = roundMoney(refundInfo.couponAdjustment);
        totals.return_shipping_charge = roundMoney(refundInfo.returnShippingCharge);
        totals.return_shipping_weight_kg = refundInfo.pickupWeightKg;
        totals.estimated_refund_amount = roundMoney(refundInfo.refundAmount);
        totals.is_full_return = Boolean(refundInfo.isFullReturn);
        // Full return: the paid money (amount_paid) is refunded to the gateway
        // minus the non-refundable fees + pickup charge (gateway_refund), while
        // the wallet credit is returned to the wallet IN FULL (wallet_return).
        // Exposed line by line so the modal can show the formula instead of a
        // single lumped figure.
        if (refundInfo.isFullReturn) {
          totals.amount_paid = roundMoney(refundInfo.amountPaid);
          totals.wallet_amount = roundMoney(refundInfo.walletAmount);
          totals.wallet_return = roundMoney(refundInfo.walletReturn);
          totals.gateway_refund = roundMoney(refundInfo.gatewayRefund);
          totals.platform_fee = roundMoney(refundInfo.platformFee);
          totals.cod_fee = roundMoney(refundInfo.codFee);
          totals.gift_charge = roundMoney(refundInfo.giftCharge);
          // Payment-gateway cost retained on the refund (fee + GST on the fee), so the
          // estimate the customer confirms matches what is actually paid out.
          totals.payment_gateway_fee = roundMoney(refundInfo.paymentGatewayFee);
          totals.payment_gateway_fee_gst = roundMoney(refundInfo.paymentGatewayFeeGst);
          totals.payment_gateway_charge = roundMoney(refundInfo.paymentGatewayCharge);
          totals.payment_gateway_fee_percent = refundInfo.gatewayFeePercent;
          totals.payment_gateway_gst_percent = refundInfo.gatewayGstPercent;
        }
        if ((refundInfo.originalCouponCode && refundInfo.currentDiscount > 0) || refundInfo.couponAdjustment > 0) {
          couponBreakdown = {
            original_code: refundInfo.originalCouponCode,
            original_discount: roundMoney(refundInfo.currentDiscount),
            original_eligible: refundInfo.originalCouponEligible,
            applied_code: refundInfo.appliedCouponCode,
            new_discount: roundMoney(refundInfo.newDiscount),
            remaining_subtotal: roundMoney(refundInfo.remainingSubtotal),
            adjustment: roundMoney(refundInfo.couponAdjustment),
          };
        }
      }

      return res.status(200).json({ items: estimates, totals, coupon: couponBreakdown });
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

      // Exchange: validate & name each requested colour variant against the
      // product's live per-colour stock (Product.color_stocks: colorId → qty),
      // so a stale/forged client can't request an unavailable colour and the
      // stored request carries a human-readable colour for the admin queue.
      if (actionType === ACTION_TYPES.EXCHANGE) {
        for (const selection of selections) {
          if (!selection.exchangeColorId) continue;
          const orderItem = orderItems.find((it) => Number(it.id) === Number(selection.orderItemId));
          if (!orderItem) continue;
          const product = await Product.findByPk(orderItem.product_id, {
            attributes: ['id', 'color_stocks'],
            transaction,
          });
          const stocks = product?.color_stocks || {};
          const key = String(selection.exchangeColorId);
          if (!(key in stocks)) {
            await transaction.rollback();
            return res.status(400).json({ message: 'The selected colour is not available for this product.' });
          }
          if (Number(stocks[key]) <= 0) {
            await transaction.rollback();
            return res.status(400).json({ message: 'The selected colour is out of stock. Please choose another colour.' });
          }
          const color = await Color.findByPk(selection.exchangeColorId, { attributes: ['id', 'name'], transaction });
          selection.exchangeColorName = color?.name || null;
        }
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

      // Which returns already had their refund initiated (money settled) —
      // the product-reversal ledger entry is the marker.
      const actionIds = actions.map((row) => row.id);
      const settledRows = actionIds.length ? await OrderLedger.findAll({
        where: {
          entry_type: LEDGER_ENTRY_TYPE.PRODUCT_CHARGE,
          reference_type: LEDGER_REFERENCE_TYPE.RETURN,
          reference_id: { [Op.in]: actionIds },
        },
        attributes: ['reference_id'],
      }) : [];
      const initiatedSet = new Set(settledRows.map((row) => Number(row.reference_id)));

      // Attach the refund row (status + bank details) so the queue can show
      // COD payout readiness and the account to transfer to.
      const refundRows = actionIds.length ? await OrderRefund.findAll({
        where: { order_item_action_id: { [Op.in]: actionIds } },
      }) : [];
      const refundByAction = new Map(refundRows.map((row) => [Number(row.order_item_action_id), row]));

      return res.status(200).json(actions.map((row) => {
        const refundRow = refundByAction.get(Number(row.id)) || null;
        return {
          ...serializeAction(row),
          refund_initiated: initiatedSet.has(Number(row.id)),
          refund_status: refundRow?.status || null,
          refund_amount: refundRow ? roundMoney(refundRow.amount) : null,
          refund_bank_details: refundRow?.bank_details || null,
        };
      }));
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

      // NOTE: completing a return only records that the item is back with us.
      // No money moves here — the admin explicitly presses "Initiate refund"
      // (initiateRefund below) to settle the ledger and pay the customer.

      // COD returns are paid out by manual bank transfer — the moment the
      // return completes, flag the refund row so the customer's order page
      // asks for their bank details.
      if (nextStatus === ACTION_STATUS.COMPLETED && action.action_type === ACTION_TYPES.RETURN) {
        const orderRow = await Order.findByPk(action.order_id, { transaction });
        if (String(orderRow?.payment_method || '').toUpperCase() === 'COD') {
          const refundRow = await OrderRefund.findOne({ where: { order_item_action_id: action.id }, transaction })
            || await OrderRefund.findOne({
              where: { order_id: action.order_id, refund_type: REFUND_TYPE.RETURN },
              order: [['created_at', 'DESC']],
              transaction,
            });
          if (refundRow && !refundRow.bank_details && refundRow.status === REFUND_STATUS.PENDING) {
            await refundRow.update({ status: 'Bank Details Required' }, { transaction });
          }
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

      // Completing a return/exchange also moves the ORDER status (the courier
      // webhook normally does this, but an admin can complete first) so the
      // order and its items never disagree.
      if (nextStatus === ACTION_STATUS.COMPLETED && [ACTION_TYPES.RETURN, ACTION_TYPES.EXCHANGE].includes(action.action_type)) {
        const completedLabel = action.action_type === ACTION_TYPES.EXCHANGE ? 'Exchange Completed' : 'Return Completed';
        await Order.update({ status: completedLabel }, { where: { id: action.order_id }, transaction });
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

  // ── Explicitly trigger the money leg of a COMPLETED return ───────────────────
  // POST /admin/item-actions/:actionId/initiate-refund
  // Completing a return only records that the item is back. Money moves only
  // here: ledger settlement (product reversal, shipping retained, coupon
  // clawback, refund debit) + the wallet-paid share back to the wallet + an
  // automatic Razorpay refund for the remainder (prepaid). COD stays a manual
  // bank transfer — this still settles the ledger and wallet share for it.
  async initiateRefund(req, res) {
    const transaction = await sequelize.transaction();
    try {
      await ensureOrderItemActionSchema();
      const action = await OrderItemAction.findByPk(req.params.actionId, {
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      if (!action) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Request not found.' });
      }
      if (String(action.action_type || '').toLowerCase() !== ACTION_TYPES.RETURN) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Refunds can be initiated for return requests only.' });
      }
      if (action.status !== ACTION_STATUS.COMPLETED) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Complete the return first — initiate the refund once the item is received.' });
      }

      // Idempotency: the product-reversal ledger entry is the settlement marker.
      const alreadySettled = await OrderLedger.findOne({
        where: {
          entry_type: LEDGER_ENTRY_TYPE.PRODUCT_CHARGE,
          reference_type: LEDGER_REFERENCE_TYPE.RETURN,
          reference_id: action.id,
        },
        transaction,
      });
      if (alreadySettled) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Refund has already been initiated for this return.' });
      }

      const order = await Order.findByPk(action.order_id, { transaction, lock: Transaction.LOCK.UPDATE });
      if (!order) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Order not found.' });
      }
      const isCodOrder = String(order.payment_method || '').toUpperCase() === 'COD';
      const itemValue = roundMoney(Number(action.item_amount || 0));
      const deductions = roundMoney(Number(action.forward_shipping_deduction || 0) + Number(action.reverse_shipping_deduction || 0));
      const couponAdjustment = roundMoney(Number(action.meta?.coupon_adjustment || 0));
      const returnRefundAmount = roundMoney(Math.max(0, Number(action.estimated_refund_amount ?? (itemValue - deductions - couponAdjustment))));

      if (itemValue > 0) {
        await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.PRODUCT_CHARGE, amount: itemValue, direction: LEDGER_DIRECTION.CREDIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: action.id, note: 'Return — product value reversed' }, transaction);
      }
      if (deductions > 0) {
        await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.SHIPPING_CHARGE, amount: deductions, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: action.id, note: 'Return — return pickup charge retained' }, transaction);
      }
      if (couponAdjustment > 0) {
        await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.COUPON_DISCOUNT, amount: couponAdjustment, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: action.id, note: 'Return — coupon benefit no longer earned by remaining items' }, transaction);
      }
      if (returnRefundAmount > 0) {
        const refLedger = await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.REFUND, amount: returnRefundAmount, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: action.id, note: 'Return refund' }, transaction);
        await RefundTransaction.create({
          order_id: action.order_id, ledger_entry_id: refLedger?.id || null,
          gateway: isCodOrder ? 'bank_transfer' : 'original_gateway', amount: returnRefundAmount, status: 'Pending',
        }, { transaction });
      }

      await transaction.commit();

      // Fire-and-forget: wallet share + automatic gateway refund.
      setImmediate(async () => {
        try {
          const fullOrder = await Order.findByPk(action.order_id);
          if (!fullOrder) return;
          const refund = await OrderRefund.findOne({ where: { order_item_action_id: action.id } });

          // Wallet refund — wallet/subtotal sourced from the ledger. The refund
          // splits between the wallet and the original gateway (never both in
          // full):
          //   • Full return → the wallet credit is returned IN FULL (capped at
          //     the total refund); the gateway gets the remainder. computeReturnRefund
          //     already sized the total so the fees + pickup come out of the paid
          //     money, not the wallet.
          //   • Partial return → the wallet-paid share is refunded PROPORTIONALLY
          //     to the value being returned.
          const orderTotals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: fullOrder.id } }));
          const walletTotal = Number(orderTotals.wallet_amount || 0);
          const refundAmt = Number(refund?.amount || 0);
          const subtotal = Number(orderTotals.subtotal_amount || 0);
          const isFullReturn = Boolean(refund?.breakdown?.is_full_return);
          let walletShare = 0;
          if (walletTotal > 0 && fullOrder.customer_id && refundAmt > 0 && (isFullReturn || subtotal > 0)) {
            walletShare = isFullReturn
              ? Math.min(walletTotal, refundAmt)
              : Math.min(walletTotal, refundAmt, Math.round((refundAmt / subtotal) * walletTotal * 100) / 100);
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

          // Razorpay gateway refund (total minus the wallet share — the wallet
          // money never reached the gateway).
          if (refund && refundAmt > 0 && refund.payment_method === REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY) {
            const gatewayAmount = Math.round(Math.max(0, refundAmt - walletShare) * 100) / 100;
            const payment = gatewayAmount > 0
              ? await Payment.findOne({ where: { order_id: fullOrder.id, status: 'Paid' } })
              : null;
            if (gatewayAmount <= 0) {
              refund.update({
                status: REFUND_STATUS.COMPLETED,
                processed_at: new Date(),
                note: `${refund.note || ''}${refund.note ? ' | ' : ''}Fully refunded to wallet (Rs. ${walletShare.toLocaleString('en-IN')}).`.slice(0, 1000),
              }).catch((updateErr) => console.error('[Refund] Failed to mark wallet-only refund Completed:', updateErr.message));
            } else if (payment?.gateway_payment_id) {
              razorpayRefund(payment.gateway_payment_id, gatewayAmount, {
                reason: 'Customer return approved',
              }).then((gatewayRefund) => refund.update({ status: REFUND_STATUS.PROCESSING, gateway_refund_id: gatewayRefund?.id || null }))
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
        } catch (err) {
          console.error('[OrderItemAction] initiate-refund async error:', err.message);
        }
      });

      return res.status(200).json({
        message: `Refund of Rs. ${returnRefundAmount.toLocaleString('en-IN')} initiated.`,
        amount: returnRefundAmount,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('[OrderItemAction] initiate refund error:', error);
      return res.status(500).json({ message: 'Unable to initiate this refund right now.' });
    }
  }
}

module.exports = new OrderItemActionController();
