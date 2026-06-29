const { Op, Transaction } = require('sequelize');
const ShipRocketService = require('../services/ShipRocketService');
const OrderReturnService = require('../services/OrderReturnService');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const OrderItemAction = require('../models/OrderItemAction');
const OrderRefund = require('../models/OrderRefund');
const EmailService = require('../services/EmailService');
const WalletService = require('../services/WalletService');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const {
  COD_RTO_BLOCK_REASON,
  blockCustomerCodForOrder,
  calculateRtoRefundAmount,
  ensureOrderLifecycleColumns,
  getForwardShippingCharge,
  getRtoShippingCharge,
} = require('../utils/orderLifecycle');
const { ACTION_TYPES, ACTION_STATUS, appendOrderStatusHistory } = require('../utils/orderItemActions');
const { REFUND_TYPE, REFUND_STATUS, REFUND_PAYMENT_METHOD } = require('../utils/orderTransactions');

// In-memory cache for pincode serviceability lookups. Courier ETAs/rates change
// slowly, so caching per pincode+weight+cod for a few hours avoids hammering the
// ShipRocket API on every product card / detail page view.
const SERVICEABILITY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SERVICEABILITY_CACHE_MAX = 1000;
const serviceabilityCache = new Map();

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
      const weightKg = parseFloat(weight) || 0.5;

      // Only cache generic pincode lookups (not order-specific shipment_id checks).
      const weightBucket = Math.ceil(weightKg * 2) / 2; // round up to nearest 0.5 kg
      const cacheKey = shipment_id ? null : `${pincode}_${weightBucket}_${codFlag ? 1 : 0}`;

      if (cacheKey) {
        const cached = serviceabilityCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < SERVICEABILITY_TTL_MS) {
          return res.status(200).json(cached.data);
        }
      }

      const data = await ShipRocketService.getServiceableCouries(
        shipment_id,
        pincode,
        weightKg,
        codFlag
      );

      if (cacheKey) {
        if (serviceabilityCache.size >= SERVICEABILITY_CACHE_MAX) {
          serviceabilityCache.delete(serviceabilityCache.keys().next().value);
        }
        serviceabilityCache.set(cacheKey, { data, ts: Date.now() });
      }

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
  // Whole-order return/exchange entry point (MyOrders list). Delegates to the shared
  // OrderReturnService so behaviour matches the per-item path exactly.
  async _createReverseOrder(req, res, actionType) {
    const transaction = await sequelize.transaction();
    let committed = false;
    try {
      const { orderId, reason } = req.body;
      if (!orderId) {
        await transaction.rollback();
        return res.status(400).json({ message: 'orderId is required' });
      }

      const order = await Order.findByPk(orderId, { transaction, lock: Transaction.LOCK.UPDATE });
      if (!order) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Order not found' });
      }
      const isOwnedByCustomerId = Number(order.customer_id) === Number(req.user?.id);
      const isLegacyOwnedByEmail = !order.customer_id
        && req.user?.email
        && String(order.customer_email || '').toLowerCase() === String(req.user.email).toLowerCase();
      if (req.userRole !== 'admin' && !isOwnedByCustomerId && !isLegacyOwnedByEmail) {
        await transaction.rollback();
        return res.status(403).json({ message: 'This order does not belong to this customer.' });
      }

      const orderItems = await OrderItem.findAll({
        where: { order_id: order.id },
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      const itemActions = await OrderItemAction.findAll({ where: { order_id: order.id }, transaction });

      let result;
      try {
        result = await OrderReturnService.createReverseActions({
          order,
          orderItems,
          itemActions,
          actionType,
          selections: null, // whole order
          reason,
          requestedBy: req.userRole === 'admin' ? null : req.user?.id,
          actor: req.userRole === 'admin' ? 'admin' : 'customer',
          transaction,
        });
      } catch (serviceError) {
        await transaction.rollback();
        if (serviceError instanceof OrderReturnService.ReverseActionError) {
          return res.status(serviceError.status).json({ message: serviceError.message });
        }
        throw serviceError;
      }

      await transaction.commit();
      committed = true;

      const finalize = await OrderReturnService.finalizeReverseActions({
        order,
        entries: result.entries,
        actionType,
        reason,
      });

      const statusLabel = actionType === ACTION_TYPES.EXCHANGE ? 'Exchange Initiated' : 'Return Initiated';
      EmailService.sendOrderStatusUpdate(order, statusLabel).catch((emailError) => {
        console.error(`[Email] ${statusLabel} email failed:`, emailError.message);
      });

      if (actionType === ACTION_TYPES.EXCHANGE) {
        return res.status(200).json({
          message: 'Exchange request submitted.',
          exchange_message: 'Exchange initiated. No delivery deduction applies for one approved exchange.',
          shiprocket_exchange_order_id: finalize.shiprocketReturnId,
          shipment_id: finalize.shipmentId,
          detail: finalize.detail,
        });
      }

      const isCod = String(order.payment_method || '').toUpperCase() === 'COD';
      const refundAmount = Number(result.refundRow?.amount || 0);
      const refundMessage = isCod
        ? 'Return initiated. After we receive the product, your refund will be paid to your bank account (please add bank details).'
        : `Return initiated. Estimated refund Rs. ${refundAmount.toLocaleString('en-IN')} to your original payment method after pickup.`;
      return res.status(200).json({
        message: 'Return request submitted.',
        refund_message: refundMessage,
        shiprocket_return_order_id: finalize.shiprocketReturnId,
        shipment_id: finalize.shipmentId,
        detail: finalize.detail,
      });
    } catch (error) {
      if (!committed) await transaction.rollback();
      const label = actionType === ACTION_TYPES.EXCHANGE ? 'createExchange' : 'createReturn';
      console.error(`[ShipRocket] ${label} error:`, error?.response?.data || error.message);
      return res.status(500).json({
        message: actionType === ACTION_TYPES.EXCHANGE
          ? 'Failed to create exchange request.'
          : 'Failed to create return request.',
        detail: error?.response?.data || error.message,
      });
    }
  }

  async createReturn(req, res) {
    return this._createReverseOrder(req, res, ACTION_TYPES.RETURN);
  }

  async createExchange(req, res) {
    return this._createReverseOrder(req, res, ACTION_TYPES.EXCHANGE);
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

      // All status mutations run in one transaction with the order row locked so
      // concurrent / redelivered webhooks cannot interleave or double-process.
      const transaction = await sequelize.transaction();
      let committed = false;
      try {
      // Find order — check order_item_actions first for reverse shipments, then orders for forward
      let order = null;
      let reverseAction = null;

      if (srOrderId) {
        reverseAction = await OrderItemAction.findOne({ where: { shiprocket_return_order_id: String(srOrderId) }, transaction });
        if (reverseAction) {
          order = await Order.findByPk(reverseAction.order_id, { transaction, lock: Transaction.LOCK.UPDATE });
        } else {
          order = await Order.findOne({ where: { shiprocket_order_id: String(srOrderId) }, transaction, lock: Transaction.LOCK.UPDATE });
        }
      }
      if (!order && awb) {
        reverseAction = await OrderItemAction.findOne({ where: { shiprocket_return_awb: String(awb) }, transaction });
        if (reverseAction) {
          order = await Order.findByPk(reverseAction.order_id, { transaction, lock: Transaction.LOCK.UPDATE });
        } else {
          order = await Order.findOne({ where: { shiprocket_awb: String(awb) }, transaction, lock: Transaction.LOCK.UPDATE });
        }
      }

      if (!order) {
        await transaction.rollback();
        return res.status(200).json({ message: 'Order not found locally' });
      }

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
          await reverseAction.update({ shiprocket_return_awb: String(awb) }, { transaction });
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

          // Idempotency: a redelivered "RTO Delivered" webhook must not create a
          // second RTO refund row or re-block COD.
          const existingRtoRefund = await OrderRefund.findOne({
            where: { order_id: order.id, refund_type: REFUND_TYPE.RTO },
            transaction,
          });

          if (isCodOrder) {
            const blockedAt = new Date();
            updatePayload.status = 'Seller Cancelled';
            updatePayload.cancelled_at = blockedAt;
            updatePayload.customer_cod_blocked = true;
            updatePayload.cod_blocked_at = blockedAt;
            updatePayload.cod_block_reason = COD_RTO_BLOCK_REASON;
            await blockCustomerCodForOrder(order, COD_RTO_BLOCK_REASON, transaction);
            if (!existingRtoRefund) {
              await OrderRefund.create({
                order_id: order.id,
                refund_type: REFUND_TYPE.RTO,
                amount: 0,
                status: REFUND_STATUS.NOT_REQUIRED,
                payment_method: REFUND_PAYMENT_METHOD.NOT_REQUIRED,
                note: 'Your order has been cancelled due to unsuccessful delivery. Please place a new order if you still wish to purchase the product. COD is now blocked for this account.',
              }, { transaction });
            }
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
            if (!existingRtoRefund) {
              await OrderRefund.create({
                order_id: order.id,
                refund_type: REFUND_TYPE.RTO,
                amount: refundAmount,
                status: hasRedispatch ? REFUND_STATUS.PENDING : 'RTO Action Required',
                payment_method: REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
                note: rtoNote,
              }, { transaction });
            }
          }
        }
      }

      updatePayload.status_history = appendOrderStatusHistory(
        order,
        updatePayload.status,
        'system',
        isReverse ? 'Reverse shipment update' : 'Shipment update',
      );

      await order.update(updatePayload, { transaction });
      await transaction.commit();
      committed = true;

      EmailService.sendOrderStatusUpdate({ ...order.toJSON(), ...updatePayload }, updatePayload.status).catch((emailError) => {
        console.error(`[Email] ShipRocket webhook email failed for order #${order.id}:`, emailError.message);
      });

      return res.status(200).json({ message: 'Order status synced', orderId: order.id, status: updatePayload.status });
      } catch (innerError) {
        if (!committed) await transaction.rollback();
        throw innerError;
      }
    } catch (error) {
      console.error('[ShipRocket] webhook error:', error?.response?.data || error.message);
      return res.status(500).json({ message: 'Webhook failed' });
    }
  }

  // Shared transactional cancel for an in-progress return/exchange flow. Reverts the
  // quantity accounting (pending_action_quantity) and item status that
  // OrderReturnService applied, cancels the reverse pickup, and re-opens the order.
  async _cancelReverseFlow(req, res, actionType) {
    const transaction = await sequelize.transaction();
    let committed = false;
    try {
      const { orderId, reason } = req.body;
      if (!orderId) {
        await transaction.rollback();
        return res.status(400).json({ message: 'orderId is required' });
      }

      const order = await Order.findByPk(orderId, { transaction, lock: Transaction.LOCK.UPDATE });
      if (!order) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Order not found' });
      }

      const isOwnedByCustomerId = Number(order.customer_id) === Number(req.user?.id);
      const isLegacyOwnedByEmail = !order.customer_id
        && req.user?.email
        && String(order.customer_email || '').toLowerCase() === String(req.user.email).toLowerCase();
      if (req.userRole !== 'admin' && !isOwnedByCustomerId && !isLegacyOwnedByEmail) {
        await transaction.rollback();
        return res.status(403).json({ message: 'This order does not belong to this customer.' });
      }

      const label = actionType === ACTION_TYPES.EXCHANGE ? 'Exchange' : 'Return';
      const refundType = actionType === ACTION_TYPES.EXCHANGE ? REFUND_TYPE.EXCHANGE : REFUND_TYPE.RETURN;

      const actions = await OrderItemAction.findAll({
        where: { order_id: orderId, action_type: actionType, status: { [Op.notIn]: [ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] } },
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      if (!actions.length) {
        await transaction.rollback();
        return res.status(400).json({ message: `No active ${label.toLowerCase()} request found for this order.` });
      }

      const srId = actions.find((action) => action.shiprocket_return_order_id)?.shiprocket_return_order_id;

      // Cancel the actions and roll back the per-item pending quantity / status.
      const pendingByItem = new Map();
      for (const action of actions) {
        const itemId = Number(action.order_item_id);
        pendingByItem.set(itemId, Number(pendingByItem.get(itemId) || 0) + Number(action.quantity || 0));
        await action.update({ status: ACTION_STATUS.CANCELLED, completed_at: new Date() }, { transaction });
      }
      for (const [itemId, qty] of pendingByItem.entries()) {
        const item = await OrderItem.findByPk(itemId, { transaction, lock: Transaction.LOCK.UPDATE });
        if (!item) continue;
        const pending = Math.max(0, Number(item.pending_action_quantity || 0) - qty);
        await item.update(
          { pending_action_quantity: pending, status: pending > 0 ? item.status : 'Active' },
          { transaction },
        );
      }

      await OrderRefund.update(
        { status: REFUND_STATUS.NOT_REQUIRED, note: reason ? `${label} cancelled: ${reason}` : `${label} request cancelled by customer.` },
        { where: { order_id: orderId, refund_type: refundType }, transaction },
      );
      await order.update(
        {
          status: 'Delivered',
          status_history: appendOrderStatusHistory(
            order,
            'Delivered',
            req.userRole === 'admin' ? 'admin' : 'customer',
            `${label} request cancelled`,
          ),
        },
        { transaction },
      );

      await transaction.commit();
      committed = true;

      // Best-effort reverse-pickup cancellation on ShipRocket (after commit).
      if (srId) {
        try {
          await ShipRocketService.cancelOrders([srId]);
        } catch (srErr) {
          console.error(`[ShipRocket] cancel${label} reverse order cancel warning:`, srErr.message);
        }
      }

      return res.status(200).json({ message: `${label} request cancelled successfully and order status reverted to Delivered.` });
    } catch (error) {
      if (!committed) await transaction.rollback();
      const label = actionType === ACTION_TYPES.EXCHANGE ? 'Exchange' : 'Return';
      console.error(`[ShipRocket] cancel${label} error:`, error.message);
      return res.status(500).json({ message: `Failed to cancel ${label.toLowerCase()} request`, detail: error.message });
    }
  }

  async cancelReturn(req, res) {
    return this._cancelReverseFlow(req, res, ACTION_TYPES.RETURN);
  }

  async cancelExchange(req, res) {
    return this._cancelReverseFlow(req, res, ACTION_TYPES.EXCHANGE);
  }
}

const shipRocketController = new ShipRocketController();
// These delegate to shared `this`-bound helpers, so they must stay bound even
// though Express receives them as detached method references.
['createReturn', 'createExchange', 'cancelReturn', 'cancelExchange'].forEach((method) => {
  shipRocketController[method] = shipRocketController[method].bind(shipRocketController);
});

module.exports = shipRocketController;
