const { Op } = require('sequelize');
const ShipRocketService = require('../services/ShipRocketService');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const OrderItemAction = require('../models/OrderItemAction');
const OrderRefund = require('../models/OrderRefund');
const EmailService = require('../services/EmailService');
const WalletService = require('../services/WalletService');
const { config } = require('../config/env');
const {
  COD_RTO_BLOCK_REASON,
  blockCustomerCodForOrder,
  calculateRtoRefundAmount,
  ensureOrderLifecycleColumns,
  getForwardShippingCharge,
  getRtoShippingCharge,
} = require('../utils/orderLifecycle');
const { ACTION_TYPES, ACTION_STATUS } = require('../utils/orderItemActions');
const { REFUND_TYPE, REFUND_STATUS, REFUND_PAYMENT_METHOD } = require('../utils/orderTransactions');

const mapShiprocketStatus = (value = '') => {
  const status = String(value || '').toLowerCase();

  if (status.includes('awb assigned') || status.includes('awb_assigned')) return 'AWB Assigned';
  if (status.includes('rto delivered') || status.includes('returned to origin') || status.includes('return to origin delivered')) return 'RTO Delivered';
  if (status.includes('rto in transit') || status.includes('rto_in_transit') || status.includes('return to origin in transit')) return 'RTO In Transit';
  if (status.includes('rto initiated') || status.includes('rto_initiated') || status.includes('return to origin initiated')) return 'RTO Initiated';
  if (status.includes('undelivered') || status.includes('delivery failed') || status.includes('customer unavailable') || status.includes('address issue')) return 'Undelivered';
  
  // Handle return/exchange reverse statuses first to avoid catching by standard shipped check
  if (status.includes('returned')) return 'Returned';
  if (status.includes('picked up') || status.includes('picked_up')) return 'Return Picked Up';
  if (status.includes('out for pickup') || status.includes('out_for_pickup')) return 'Out For Pickup';
  if (status.includes('pickup scheduled') || status.includes('pickup_scheduled') || status.includes('pickup queued') || status.includes('pickup_queued')) return 'Pickup Scheduled';
  
  if (status.includes('delivered')) return 'Delivered';
  if (status.includes('out for delivery')) return 'Out For Delivery';
  if (status.includes('shipped') || status.includes('manifest') || status.includes('in transit')) return 'Shipped';
  if (status.includes('pickup')) return 'Shipped'; // Standard forward order pickup
  if (status.includes('cancel')) return 'Cancelled';
  if (status.includes('return')) return 'Return Initiated';
  
  return null;
};

class ShipRocketController {

  // ── Push a VNS order to ShipRocket and (optionally) auto-assign AWB ──────────
  async pushOrder(req, res) {
    try {
      const { orderId, autoAssignCourier = true } = req.body;

      if (!orderId) return res.status(400).json({ message: 'orderId is required' });

      // Fetch order + items from DB
      const order = await Order.findByPk(orderId, { include: [OrderItem] });
      if (!order) return res.status(404).json({ message: 'Order not found' });

      // Map OrderItems to a flat items array with name fallback
      const items = order.OrderItems.map(oi => ({
        product_id: oi.product_id,
        quantity: oi.quantity,
        price: oi.price,
        name: oi.product_name || `Product #${oi.product_id}`,
        sku: oi.sku,
      }));

      // Step 1: Create order on ShipRocket
      const srOrder = await ShipRocketService.createOrder({ order, items });
      console.log('ShipRocket Order Created:', srOrder); 
      const shipmentId = srOrder.shipment_id;
      const srOrderId = srOrder.order_id;

      let awbData = null;

      // Step 2 (optional): Auto-assign AWB
      if (autoAssignCourier && shipmentId) {
        awbData = await ShipRocketService.assignAWB(shipmentId);
      }

      // Persist shiprocket_order_id + awb on the local order record if columns exist
      try {
        const updatePayload = { shiprocket_order_id: srOrderId };
        if (awbData?.response?.data?.awb_code) {
          updatePayload.shiprocket_awb = awbData.response.data.awb_code;
          updatePayload.status = 'AWB Assigned';
        }
        await order.update(updatePayload);
      } catch (_) {
        // Columns may not exist yet — ignore silently
      }

      return res.status(200).json({
        message: 'Order pushed to ShipRocket successfully',
        shiprocket_order_id: srOrderId,
        shipment_id: shipmentId,
        awb: awbData?.response?.data?.awb_code || null,
      });
    } catch (error) {
      console.error('[ShipRocket] pushOrder error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to push order to ShipRocket',
        detail: error?.response?.data || error.message,
      });
    }
  }

  // ── Assign / reassign AWB for an existing ShipRocket shipment ────────────────
  async assignAWB(req, res) {
    try {
      const { shipment_id, courier_id } = req.body;
      if (!shipment_id) return res.status(400).json({ message: 'shipment_id is required' });

      const data = await ShipRocketService.assignAWB(shipment_id, courier_id || null);

      // Persist AWB in local database if returned successfully
      const awbCode = data?.response?.data?.awb_code;
      const srOrderId = data?.response?.data?.order_id;
      if (awbCode && srOrderId) {
        try {
          await Order.update(
            { shiprocket_awb: String(awbCode), status: 'AWB Assigned' },
            { where: { shiprocket_order_id: String(srOrderId) } }
          );
        } catch (dbErr) {
          console.error('[ShipRocket] Failed to save AWB to database during assignAWB:', dbErr.message);
        }
      }

      return res.status(200).json(data);
    } catch (error) {
      console.error('[ShipRocket] assignAWB error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to assign AWB',
        detail: error?.response?.data || error.message,
      });
    }
  }

  // ── Generate shipping label (returns label PDF URL) ──────────────────────────
  async generateLabel(req, res) {
    try {
      const { shipment_ids } = req.body;
      if (!shipment_ids || !shipment_ids.length) {
        return res.status(400).json({ message: 'shipment_ids array is required' });
      }
      const data = await ShipRocketService.generateLabel(shipment_ids);
      return res.status(200).json(data);
    } catch (error) {
      console.error('[ShipRocket] generateLabel error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to generate label',
        detail: error?.response?.data || error.message,
      });
    }
  }

  // ── Generate manifest PDF ────────────────────────────────────────────────────
  async generateManifest(req, res) {
    try {
      const { shipment_ids } = req.body;
      if (!shipment_ids || !shipment_ids.length) {
        return res.status(400).json({ message: 'shipment_ids array is required' });
      }
      const data = await ShipRocketService.generateManifest(shipment_ids);
      return res.status(200).json(data);
    } catch (error) {
      console.error('[ShipRocket] generateManifest error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to generate manifest',
        detail: error?.response?.data || error.message,
      });
    }
  }

  // ── Track by AWB ─────────────────────────────────────────────────────────────
  async trackByAWB(req, res) {
    try {
      const { awb } = req.params;
      if (!awb) return res.status(400).json({ message: 'awb is required' });

      const data = await ShipRocketService.trackByAWB(awb);
      return res.status(200).json(data);
    } catch (error) {
      console.error('[ShipRocket] trackByAWB error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to fetch tracking info',
        detail: error?.response?.data || error.message,
      });
    }
  }

  // ── Track by VNS Order ID (looks up shiprocket_order_id from DB) ─────────────
  async trackByOrderId(req, res) {
    try {
      const { orderId } = req.params;
      const order = await Order.findByPk(orderId);
      if (!order) return res.status(404).json({ message: 'Order not found' });

      if (!order.shiprocket_order_id) {
        return res.status(400).json({ message: 'This order has not been pushed to ShipRocket yet' });
      }

      const data = await ShipRocketService.trackByOrderId(order.shiprocket_order_id);
      return res.status(200).json(data);
    } catch (error) {
      console.error('[ShipRocket] trackByOrderId error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to fetch tracking info',
        detail: error?.response?.data || error.message,
      });
    }
  }

  // ── Schedule pickup ───────────────────────────────────────────────────────────
  async schedulePickup(req, res) {
    try {
      const { shipment_ids } = req.body;
      if (!shipment_ids || !shipment_ids.length) {
        return res.status(400).json({ message: 'shipment_ids array is required' });
      }
      const data = await ShipRocketService.schedulePickup(shipment_ids);
      return res.status(200).json(data);
    } catch (error) {
      console.error('[ShipRocket] schedulePickup error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to schedule pickup',
        detail: error?.response?.data || error.message,
      });
    }
  }

  // ── Cancel ShipRocket orders ─────────────────────────────────────────────────
  async cancelOrders(req, res) {
    try {
      const { shiprocket_order_ids } = req.body;
      if (!shiprocket_order_ids || !shiprocket_order_ids.length) {
        return res.status(400).json({ message: 'shiprocket_order_ids array is required' });
      }
      const data = await ShipRocketService.cancelOrders(shiprocket_order_ids);
      return res.status(200).json(data);
    } catch (error) {
      console.error('[ShipRocket] cancelOrders error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to cancel ShipRocket orders',
        detail: error?.response?.data || error.message,
      });
    }
  }

  // ── Check serviceability for a pincode ───────────────────────────────────────
  async checkServiceability(req, res) {
    try {
      const { pincode, shipment_id, weight = 0.5, is_cod = false } = req.query;
      if (!pincode) return res.status(400).json({ message: 'pincode is required' });

      const codFlag = is_cod === 'true' || is_cod === true || is_cod === 1 || is_cod === '1';
      const data = await ShipRocketService.getServiceableCouries(
        shipment_id, 
        pincode, 
        parseFloat(weight) || 0.5, 
        codFlag
      );
      return res.status(200).json(data);
    } catch (error) {
      console.error('[ShipRocket] serviceability error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to check serviceability',
        detail: error?.response?.data || error.message,
      });
    }
  }

  // ── Create return shipment on ShipRocket ─────────────────────────────────────
  async createReturn(req, res) {
    try {
      const { orderId, reason } = req.body;
      if (!orderId) return res.status(400).json({ message: 'orderId is required' });

      const order = await Order.findByPk(orderId, { include: [OrderItem] });
      if (!order) return res.status(404).json({ message: 'Order not found' });
      const isOwnedByCustomerId = Number(order.customer_id) === Number(req.user?.id);
      const isLegacyOwnedByEmail = !order.customer_id
        && req.user?.email
        && String(order.customer_email || '').toLowerCase() === String(req.user.email).toLowerCase();
      if (req.userRole !== 'admin' && !isOwnedByCustomerId && !isLegacyOwnedByEmail) {
        return res.status(403).json({ message: 'This order does not belong to this customer.' });
      }
      if (String(order.status).toLowerCase() !== 'delivered') {
        return res.status(400).json({ message: 'Return is allowed only after delivery' });
      }

      const activeReturnAction = await OrderItemAction.findOne({
        where: { order_id: orderId, action_type: ACTION_TYPES.RETURN, status: { [Op.notIn]: [ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] } },
      });
      if (activeReturnAction) return res.status(400).json({ message: 'Return has already been requested for this order.' });

      const activeExchangeAction = await OrderItemAction.findOne({
        where: { order_id: orderId, action_type: ACTION_TYPES.EXCHANGE, status: { [Op.notIn]: [ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] } },
      });
      if (activeExchangeAction) return res.status(400).json({ message: 'Exchange already used. Return is not available after exchange.' });

      if (!order.delivered_at) {
        return res.status(400).json({ message: 'Return is available only after the delivery date is confirmed.' });
      }
      const returnLastDate = new Date(order.delivered_at);
      returnLastDate.setDate(returnLastDate.getDate() + 7);
      if (new Date() > returnLastDate) {
        return res.status(400).json({ message: 'Return window expired' });
      }

      const items = order.OrderItems.map(oi => ({
        product_id: oi.product_id,
        quantity: oi.quantity,
        price: oi.price,
        name: oi.product_name || `Product #${oi.product_id}`,
        sku: oi.sku,
      }));

      const data = await ShipRocketService.createReturnOrder({ order, items, reason });

      const logisticsDeduction = order.OrderItems.reduce((sum, item) => {
        const rules = item.shipping_meta?.refund_rules || {};
        return sum + Number(rules.return_delivery_deduction || 0);
      }, 0);
      const paidAmount = Number(order.payable_amount ?? order.total_amount ?? 0);
      const isCod = String(order.payment_method || '').toUpperCase() === 'COD';
      const estimatedRefund = isCod ? 0 : Math.max(0, paidAmount - logisticsDeduction);
      const refundNote = isCod
        ? 'Return initiated for COD order. No monetary refund applies.'
        : logisticsDeduction > 0
          ? `Return initiated. Estimated refund Rs. ${estimatedRefund.toLocaleString('en-IN')} after Rs. ${logisticsDeduction.toLocaleString('en-IN')} delivery charge deduction.`
          : `Return initiated. Estimated refund Rs. ${estimatedRefund.toLocaleString('en-IN')}; no delivery charge deduction applies.`;
      const fullNote = reason ? `${refundNote} | Reason: ${String(reason).slice(0, 200)}` : refundNote;

      // Create action rows for all items, linking ShipRocket ID to the first row
      const srReturnId = data.order_id ? String(data.order_id) : null;
      let firstActionId = null;
      for (let i = 0; i < order.OrderItems.length; i++) {
        const oi = order.OrderItems[i];
        const action = await OrderItemAction.create({
          order_id: order.id,
          order_item_id: oi.id,
          product_id: oi.product_id,
          action_type: ACTION_TYPES.RETURN,
          quantity: oi.quantity,
          status: ACTION_STATUS.APPROVED,
          shiprocket_return_order_id: i === 0 ? srReturnId : null,
        });
        if (i === 0) firstActionId = action.id;
      }

      await OrderRefund.create({
        order_id: order.id,
        order_item_action_id: firstActionId,
        refund_type: REFUND_TYPE.RETURN,
        amount: estimatedRefund,
        status: isCod ? REFUND_STATUS.NOT_REQUIRED : REFUND_STATUS.PENDING,
        payment_method: isCod ? REFUND_PAYMENT_METHOD.NOT_REQUIRED : REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
        note: fullNote,
      });

      await order.update({ status: 'Return Initiated' });
      await WalletService.cancelPendingReferralCreditsForOrder(
        order.id,
        'Customer requested return within the reward hold period.',
      );

      return res.status(200).json({
        message: 'Return order created on ShipRocket successfully',
        refund_message: refundNote,
        shiprocket_return_order_id: data.order_id,
        shipment_id: data.shipment_id,
        detail: data,
      });
    } catch (error) {
      console.error('[ShipRocket] createReturn error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to create return order on ShipRocket',
        detail: error?.response?.data || error.message,
      });
    }
  }

  async createExchange(req, res) {
    try {
      const { orderId, reason } = req.body;
      if (!orderId) return res.status(400).json({ message: 'orderId is required' });

      const order = await Order.findByPk(orderId, { include: [OrderItem] });
      if (!order) return res.status(404).json({ message: 'Order not found' });
      const isOwnedByCustomerId = Number(order.customer_id) === Number(req.user?.id);
      const isLegacyOwnedByEmail = !order.customer_id
        && req.user?.email
        && String(order.customer_email || '').toLowerCase() === String(req.user.email).toLowerCase();
      if (req.userRole !== 'admin' && !isOwnedByCustomerId && !isLegacyOwnedByEmail) {
        return res.status(403).json({ message: 'This order does not belong to this customer.' });
      }
      if (String(order.status).toLowerCase() !== 'delivered') {
        return res.status(400).json({ message: 'Exchange is allowed only after delivery' });
      }

      const activeExchangeAction = await OrderItemAction.findOne({
        where: { order_id: orderId, action_type: ACTION_TYPES.EXCHANGE, status: { [Op.notIn]: [ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] } },
      });
      if (activeExchangeAction) return res.status(400).json({ message: 'Exchange has already been requested for this order.' });

      const activeReturnAction = await OrderItemAction.findOne({
        where: { order_id: orderId, action_type: ACTION_TYPES.RETURN, status: { [Op.notIn]: [ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] } },
      });
      if (activeReturnAction) return res.status(400).json({ message: 'Return already used. Exchange is not available after return.' });

      if (!order.delivered_at) {
        return res.status(400).json({ message: 'Exchange is available only after the delivery date is confirmed.' });
      }
      const exchangeLastDate = new Date(order.delivered_at);
      exchangeLastDate.setDate(exchangeLastDate.getDate() + 7);
      if (new Date() > exchangeLastDate) {
        return res.status(400).json({ message: 'Exchange window expired' });
      }

      const items = order.OrderItems.map(oi => ({
        product_id: oi.product_id,
        quantity: oi.quantity,
        price: oi.price,
        name: oi.product_name || `Product #${oi.product_id}`,
        sku: oi.sku,
      }));

      const data = await ShipRocketService.createReturnOrder({
        order,
        items,
        reason: reason ? `Exchange: ${String(reason).slice(0, 200)}` : 'Exchange requested',
      });
      const note = 'Exchange initiated. No delivery deduction applies for one approved exchange.';
      const fullNote = reason ? `${note} | Reason: ${String(reason).slice(0, 200)}` : note;
      const srReturnId = data.order_id ? String(data.order_id) : null;

      let firstActionId = null;
      for (let i = 0; i < order.OrderItems.length; i++) {
        const oi = order.OrderItems[i];
        const action = await OrderItemAction.create({
          order_id: order.id,
          order_item_id: oi.id,
          product_id: oi.product_id,
          action_type: ACTION_TYPES.EXCHANGE,
          quantity: oi.quantity,
          status: ACTION_STATUS.INITIATED,
          shiprocket_return_order_id: i === 0 ? srReturnId : null,
        });
        if (i === 0) firstActionId = action.id;
      }

      await OrderRefund.create({
        order_id: order.id,
        order_item_action_id: firstActionId,
        refund_type: REFUND_TYPE.EXCHANGE,
        amount: 0,
        status: REFUND_STATUS.NOT_REQUIRED,
        payment_method: REFUND_PAYMENT_METHOD.NOT_REQUIRED,
        note: fullNote,
      });

      await order.update({ status: 'Exchange Initiated' });

      return res.status(200).json({
        message: 'Exchange pickup created on ShipRocket successfully',
        exchange_message: note,
        shiprocket_exchange_order_id: data.order_id,
        shipment_id: data.shipment_id,
        detail: data,
      });
    } catch (error) {
      console.error('[ShipRocket] createExchange error:', error?.response?.data || error.message);
      return res.status(500).json({
        message: 'Failed to create exchange pickup on ShipRocket',
        detail: error?.response?.data || error.message,
      });
    }
  }

  async webhook(req, res) {
    console.log("Webhook received");
    try {
      await ensureOrderLifecycleColumns();
      const providedSecret =
        req.headers['x-api-key'] ||
        req.headers['x-webhook-secret'] ||
        req.headers['x-shiprocket-webhook-secret'];
      if (String(providedSecret || '') !== config.shiprocketWebhookSecret) {
        return res.status(401).json({ message: 'Invalid webhook secret' });
      }
      const payload = req.body || {};
      const awb = payload.awb || payload.awb_code || payload.awb_number || payload.shipment?.awb || payload.shipment_track?.awb_code;
      const srOrderId = payload.order_id || payload.shiprocket_order_id || payload.sr_order_id || payload.shipment?.order_id;
      const rawStatus = payload.current_status || payload.shipment_status || payload.status || payload.activity || payload.shipment?.status;
      const nextStatus = mapShiprocketStatus(rawStatus);

      if (!nextStatus || (!awb && !srOrderId)) {
        return res.status(200).json({ message: 'Webhook ignored' });
      }

      // Find order — check order_item_actions first for reverse shipments, then orders for forward
      let order = null;
      let reverseAction = null;

      if (srOrderId) {
        reverseAction = await OrderItemAction.findOne({ where: { shiprocket_return_order_id: String(srOrderId) } });
        if (reverseAction) {
          order = await Order.findByPk(reverseAction.order_id);
        } else {
          order = await Order.findOne({ where: { shiprocket_order_id: String(srOrderId) } });
        }
      }
      if (!order && awb) {
        reverseAction = await OrderItemAction.findOne({ where: { shiprocket_return_awb: String(awb) } });
        if (reverseAction) {
          order = await Order.findByPk(reverseAction.order_id);
        } else {
          order = await Order.findOne({ where: { shiprocket_awb: String(awb) } });
        }
      }

      if (!order) return res.status(200).json({ message: 'Order not found locally' });

      const isReverse = Boolean(reverseAction);
      const updatePayload = {};

      if (isReverse) {
        const isExchange = reverseAction.action_type === ACTION_TYPES.EXCHANGE;
        const prefix = isExchange ? 'Exchange' : 'Return';
        let reverseStatus = nextStatus;
        if (nextStatus === 'Shipped') reverseStatus = `${prefix} Shipped`;
        else if (nextStatus === 'Returned') reverseStatus = `${prefix} Completed`;
        else if (nextStatus === 'RTO Delivered') reverseStatus = `${prefix} Completed`;
        else if (nextStatus === 'Cancelled') reverseStatus = `${prefix} Cancelled`;
        else if (nextStatus === 'Delivered') reverseStatus = `${prefix} Delivered`;
        else if (nextStatus === 'Return Picked Up') reverseStatus = `${prefix} Picked Up`;
        else if (nextStatus === 'Out For Pickup') reverseStatus = `Out For ${prefix} Pickup`;
        else if (nextStatus === 'Pickup Scheduled') reverseStatus = `${prefix} Pickup Scheduled`;

        updatePayload.status = reverseStatus;

        if (awb && !reverseAction.shiprocket_return_awb) {
          await reverseAction.update({ shiprocket_return_awb: String(awb) });
        }
      } else {
        // Forward shipment updates
        updatePayload.status = nextStatus;
        const isRtoStatus = ['RTO Initiated', 'RTO In Transit', 'RTO Delivered'].includes(nextStatus);
        const currentRtoCount = Number(order.rto_count || 0);
        const nextRtoCount = isRtoStatus ? Math.max(1, currentRtoCount || 1) : currentRtoCount;
        
        if (awb && !order.shiprocket_awb) {
          updatePayload.shiprocket_awb = String(awb);
        }
        if (srOrderId && !order.shiprocket_order_id) {
          updatePayload.shiprocket_order_id = String(srOrderId);
        }
        
        if (nextStatus === 'Delivered' && !order.delivered_at) {
          updatePayload.delivered_at = new Date();
        }

        if (isRtoStatus) {
          updatePayload.is_rto = true;
          updatePayload.rto_count = nextRtoCount;
        }

        if (nextStatus === 'RTO Delivered') {
          const paymentMethod = String(order.payment_method || '').toUpperCase();
          const isCodOrder = paymentMethod === 'COD';
          const currentStatus = String(order.status || '').toLowerCase();
          const alreadyFinalRto = currentStatus === 'rto delivered'
            || (currentStatus === 'seller cancelled' && Boolean(order.is_rto));
          const actualRtoCount = alreadyFinalRto
            ? Math.max(1, currentRtoCount)
            : currentRtoCount + 1;

          updatePayload.rto_count = actualRtoCount;

          if (isCodOrder) {
            const blockedAt = new Date();
            updatePayload.status = 'Seller Cancelled';
            updatePayload.cancelled_at = blockedAt;
            updatePayload.customer_cod_blocked = true;
            updatePayload.cod_blocked_at = blockedAt;
            updatePayload.cod_block_reason = COD_RTO_BLOCK_REASON;
            await blockCustomerCodForOrder(order, COD_RTO_BLOCK_REASON);
            await OrderRefund.create({
              order_id: order.id,
              refund_type: REFUND_TYPE.RTO,
              amount: 0,
              status: REFUND_STATUS.NOT_REQUIRED,
              payment_method: REFUND_PAYMENT_METHOD.NOT_REQUIRED,
              note: 'Your order has been cancelled due to unsuccessful delivery. Please place a new order if you still wish to purchase the product. COD is now blocked for this account.',
            });
          } else {
            const refundAmount = calculateRtoRefundAmount(order, actualRtoCount);
            const forwardCharge = getForwardShippingCharge(order);
            const rtoCharge = getRtoShippingCharge(order);
            const hasRedispatch = Number(order.redispatch_count || 0) > 0 || actualRtoCount > 1;
            const rtoNote = hasRedispatch
              ? `Your order could not be delivered after multiple attempts and has been cancelled. Refund eligible amount: Rs. ${refundAmount.toLocaleString('en-IN')} after delivery deductions. Please place a fresh order if you still wish to purchase this item.`
              : `Order returned to seller. Refund eligible amount: Rs. ${refundAmount.toLocaleString('en-IN')} after Rs. ${forwardCharge.toLocaleString('en-IN')} forward charge and Rs. ${rtoCharge.toLocaleString('en-IN')} RTO charge deduction. You may choose refund or re-dispatch.`;

            if (hasRedispatch) {
              updatePayload.status = 'Seller Cancelled';
              updatePayload.cancelled_at = new Date();
            }
            await OrderRefund.create({
              order_id: order.id,
              refund_type: REFUND_TYPE.RTO,
              amount: refundAmount,
              status: hasRedispatch ? REFUND_STATUS.PENDING : 'RTO Action Required',
              payment_method: REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
              note: rtoNote,
            });
          }
        }
      }

      await order.update(updatePayload);
      EmailService.sendOrderStatusUpdate({ ...order.toJSON(), ...updatePayload }, updatePayload.status).catch((error) => {
        console.error(`[Email] ShipRocket webhook email failed for order #${order.id}:`, error.message);
      });

      return res.status(200).json({ message: 'Order status synced', orderId: order.id, status: updatePayload.status });
    } catch (error) {
      console.error('[ShipRocket] webhook error:', error?.response?.data || error.message);
      return res.status(500).json({ message: 'Webhook failed' });
    }
  }

  async cancelReturn(req, res) {
    try {
      const { orderId, reason } = req.body;
      if (!orderId) return res.status(400).json({ message: 'orderId is required' });

      const order = await Order.findByPk(orderId);
      if (!order) return res.status(404).json({ message: 'Order not found' });

      const isOwnedByCustomerId = Number(order.customer_id) === Number(req.user?.id);
      const isLegacyOwnedByEmail = !order.customer_id
        && req.user?.email
        && String(order.customer_email || '').toLowerCase() === String(req.user.email).toLowerCase();
      if (req.userRole !== 'admin' && !isOwnedByCustomerId && !isLegacyOwnedByEmail) {
        return res.status(403).json({ message: 'This order does not belong to this customer.' });
      }

      const returnActions = await OrderItemAction.findAll({
        where: { order_id: orderId, action_type: ACTION_TYPES.RETURN, status: { [Op.notIn]: [ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] } },
      });
      if (!returnActions.length) {
        return res.status(400).json({ message: 'No active return request found for this order.' });
      }

      const srId = returnActions.find((a) => a.shiprocket_return_order_id)?.shiprocket_return_order_id;
      if (srId) {
        try {
          await ShipRocketService.cancelOrders([srId]);
        } catch (srErr) {
          console.error('[ShipRocket] cancelReturn reverse order cancel warning:', srErr.message);
        }
      }

      await OrderItemAction.update(
        { status: ACTION_STATUS.CANCELLED },
        { where: { order_id: orderId, action_type: ACTION_TYPES.RETURN, status: { [Op.notIn]: [ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] } } },
      );
      await OrderRefund.update(
        { status: REFUND_STATUS.NOT_REQUIRED, note: reason ? `Return cancelled: ${reason}` : 'Return request cancelled by customer.' },
        { where: { order_id: orderId, refund_type: REFUND_TYPE.RETURN } },
      );
      await order.update({ status: 'Delivered' });

      return res.status(200).json({ message: 'Return request cancelled successfully and order status reverted to Delivered.' });
    } catch (error) {
      console.error('[ShipRocket] cancelReturn error:', error.message);
      return res.status(500).json({ message: 'Failed to cancel return request', detail: error.message });
    }
  }

  async cancelExchange(req, res) {
    try {
      const { orderId, reason } = req.body;
      if (!orderId) return res.status(400).json({ message: 'orderId is required' });

      const order = await Order.findByPk(orderId);
      if (!order) return res.status(404).json({ message: 'Order not found' });

      const isOwnedByCustomerId = Number(order.customer_id) === Number(req.user?.id);
      const isLegacyOwnedByEmail = !order.customer_id
        && req.user?.email
        && String(order.customer_email || '').toLowerCase() === String(req.user.email).toLowerCase();
      if (req.userRole !== 'admin' && !isOwnedByCustomerId && !isLegacyOwnedByEmail) {
        return res.status(403).json({ message: 'This order does not belong to this customer.' });
      }

      const exchangeActions = await OrderItemAction.findAll({
        where: { order_id: orderId, action_type: ACTION_TYPES.EXCHANGE, status: { [Op.notIn]: [ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] } },
      });
      if (!exchangeActions.length) {
        return res.status(400).json({ message: 'No active exchange request found for this order.' });
      }

      const srId = exchangeActions.find((a) => a.shiprocket_return_order_id)?.shiprocket_return_order_id;
      if (srId) {
        try {
          await ShipRocketService.cancelOrders([srId]);
        } catch (srErr) {
          console.error('[ShipRocket] cancelExchange reverse order cancel warning:', srErr.message);
        }
      }

      await OrderItemAction.update(
        { status: ACTION_STATUS.CANCELLED },
        { where: { order_id: orderId, action_type: ACTION_TYPES.EXCHANGE, status: { [Op.notIn]: [ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] } } },
      );
      await OrderRefund.update(
        { status: REFUND_STATUS.NOT_REQUIRED, note: reason ? `Exchange cancelled: ${reason}` : 'Exchange request cancelled by customer.' },
        { where: { order_id: orderId, refund_type: REFUND_TYPE.EXCHANGE } },
      );
      await order.update({ status: 'Delivered' });

      return res.status(200).json({ message: 'Exchange request cancelled successfully and order status reverted to Delivered.' });
    } catch (error) {
      console.error('[ShipRocket] cancelExchange error:', error.message);
      return res.status(500).json({ message: 'Failed to cancel exchange request', detail: error.message });
    }
  }
}

module.exports = new ShipRocketController();
