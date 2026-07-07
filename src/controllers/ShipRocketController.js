const { Op, Transaction } = require('sequelize');
const ShipRocketService = require('../services/ShipRocketService');
const OrderReturnService = require('../services/OrderReturnService');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const OrderItemAction = require('../models/OrderItemAction');
const OrderRefund = require('../models/OrderRefund');
const Payment = require('../models/Payment');
const Shipment = require('../models/Shipment');
const ShipmentItem = require('../models/ShipmentItem');
const RtoEvent = require('../models/RtoEvent');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const OrderAddress = require('../models/OrderAddress');
const Customer = require('../models/Customer');
const WalletTransaction = require('../models/WalletTransaction');
const EmailService = require('../services/EmailService');
const WalletService = require('../services/WalletService');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const {
  COD_RTO_BLOCK_REASON,
  blockCustomerCodForOrder,
  toMoney,
} = require('../utils/orderLifecycle');
const { ACTION_TYPES, ACTION_STATUS, statusAfterCompletedAction } = require('../utils/orderItemActions');
const { REFUND_TYPE, REFUND_STATUS, REFUND_PAYMENT_METHOD } = require('../utils/orderTransactions');
const {
  SHIPMENT_TYPE, SHIPMENT_STATUS, RTO_RESOLUTION, ACTOR,
  LEDGER_ENTRY_TYPE, LEDGER_DIRECTION, LEDGER_REFERENCE_TYPE,
} = require('../utils/orderModelV2');
const { appendEntry, getOrderBalance, deriveOrderTotals } = require('../services/orderLedgerService');
const OrderLedger = require('../models/OrderLedger');
const PaymentTransaction = require('../models/PaymentTransaction');
const RefundTransaction = require('../models/RefundTransaction');
const { refundPayment: razorpayRefund } = require('../services/RazorpayService');

// Courier-money helpers reading from a shipment's stored rate card.
const courierMoney = (data, keys) => {
  const d = data || {};
  for (const k of keys) {
    if (d[k] !== undefined && d[k] !== null && d[k] !== '') return toMoney(d[k]);
  }
  return 0;
};
const forwardChargeOf = (shipment) =>
  courierMoney(shipment?.selected_courier_data, ['freight_charge', 'rate', 'charge', 'shipping_charge'])
  || toMoney(shipment?.forward_charge);
const rtoChargeOf = (shipment) =>
  courierMoney(shipment?.selected_courier_data, ['rto_charges', 'rto_charge', 'rto_freight_charge', 'rto_shipping_charge']);

// Record an order status transition in the history table.
const recordStatus = (orderId, from, to, actor, reason, transaction) =>
  OrderStatusHistory.create(
    { order_id: orderId, from_status: from, to_status: to, actor: actor || ACTOR.SYSTEM, reason: reason || null },
    { transaction },
  );

// In-memory cache for pincode serviceability lookups. Courier ETAs/rates change
// slowly, so caching per pincode+weight+cod for a few hours avoids hammering the
// ShipRocket API on every product card / detail page view.
const SERVICEABILITY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SERVICEABILITY_CACHE_MAX = 1000;
const serviceabilityCache = new Map();

const mapShiprocketStatus = (value = '') => {
  const status = String(value || '').toLowerCase();

  // Courier noise / seller-panel statuses that must never move an order:
  // pickup failures are retried by the courier ("Pickup Error/Exception"),
  // transit exceptions resolve on their own ("Delayed", "Misrouted"), and
  // "RTO Acknowledged/Rejected", "Disposed Of", "Destroyed", "Lost/Damaged"
  // are seller-side outcomes handled outside the customer timeline.
  if (
    status.includes('pickup error') || status.includes('pickup exception')
    || status.includes('acknowledged') || status.includes('rejected')
    || status.includes('disposed') || status.includes('destroyed')
    || status.includes('lost') || status.includes('damaged')
    || status.includes('delayed') || status.includes('misrouted')
  ) return null;

  if (status.includes('awb assigned') || status.includes('awb_assigned')) return 'AWB Assigned';
  if (status.includes('rto delivered') || status.includes('returned to origin') || status.includes('return to origin delivered')) return 'RTO Delivered';
  if (status.includes('rto in transit') || status.includes('rto_in_transit') || status.includes('return to origin in transit')) return 'RTO In Transit';
  if (status.includes('rto initiated') || status.includes('rto_initiated') || status.includes('return to origin initiated')) return 'RTO Initiated';
  // Any other RTO substate (RTO-OFD, RTO OUT FOR DELIVERY, RTO-NDR…) keeps the
  // shipment in the returning-to-seller leg — checked before the forward
  // "out for delivery" / "undelivered" matches so they can't hijack it.
  if (status.includes('rto')) return 'RTO In Transit';
  if (status.includes('undelivered') || status.includes('delivery failed') || status.includes('customer unavailable') || status.includes('address issue')) return 'Undelivered';

  // Handle return/exchange reverse statuses first to avoid catching by standard shipped check.
  // Real ShipRocket sends "RETURN DELIVERED" when a return reaches the seller.
  // The webhook renames the pickup ones for forward shipments (forward orders
  // send the same "PICKED UP" / "OUT FOR PICKUP" scan texts).
  if (status.includes('return delivered') || status.includes('returned')) return 'Returned';
  if (status.includes('picked up') || status.includes('picked_up') || status.includes('pickup completed')) return 'Return Picked Up';
  if (status.includes('out for pickup') || status.includes('out_for_pickup')) return 'Out For Pickup';
  if (status.includes('pickup scheduled') || status.includes('pickup_scheduled') || status.includes('pickup queued') || status.includes('pickup_queued') || status.includes('pickup rescheduled') || status.includes('pickup generated')) return 'Pickup Scheduled';

  if (status.includes('delivered')) return 'Delivered';
  if (status.includes('out for delivery')) return 'Out For Delivery';
  if (status.includes('shipped') || status.includes('manifest') || status.includes('in transit') || status.includes('in-transit') || status.includes('in_transit') || status.includes('destination hub')) return 'Shipped';
  if (status.includes('pickup')) return 'Pickup Scheduled'; // any other pickup state — parcel not collected yet
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

      // Fetch order + items + current address + ledger totals
      const order = await Order.findByPk(orderId, { include: [OrderItem] });
      if (!order) return res.status(404).json({ message: 'Order not found' });
      const address = await OrderAddress.findOne({ where: { order_id: order.id, is_current: true } });
      const totals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: order.id } }));

      const activeItems = order.OrderItems.filter((oi) => !['Cancelled', 'REMOVED'].includes(oi.status));
      const items = activeItems.map(oi => ({
        product_id: oi.product_id,
        quantity: oi.quantity,
        price: oi.price,
        name: oi.product_name || `Product #${oi.product_id}`,
        sku: oi.sku,
      }));

      // Step 1: Create order on ShipRocket (address + totals from V2 tables)
      const srOrder = await ShipRocketService.createOrder({
        order: {
          ...order.toJSON(),
          address: address?.line, city: address?.city, pincode: address?.pincode,
          phone: address?.phone, state: address?.state,
          total_amount: totals.total_amount, discount_amount: totals.discount_amount,
        },
        items,
      });
      const shipmentId = srOrder.shipment_id;
      const srOrderId = srOrder.order_id;

      let awbData = null;
      if (autoAssignCourier && shipmentId) {
        awbData = await ShipRocketService.assignAWB(shipmentId);
      }
      const awbCode = awbData?.response?.data?.awb_code || null;

      // Record the forward shipment (V2)
      const shipment = await Shipment.create({
        order_id: order.id, address_id: address?.id || null, type: SHIPMENT_TYPE.FORWARD,
        status: awbCode ? SHIPMENT_STATUS.DISPATCHED : SHIPMENT_STATUS.CREATED,
        awb_number: awbCode ? String(awbCode) : null,
        shiprocket_order_id: srOrderId ? String(srOrderId) : null,
        forward_charge: totals.shipping_charge, dispatched_at: awbCode ? new Date() : null,
      });
      await ShipmentItem.bulkCreate(activeItems.map((oi) => ({ shipment_id: shipment.id, order_item_id: oi.id, quantity: oi.quantity })));
      await order.update({ status: awbCode ? 'AWB Assigned' : 'Processing' });

      return res.status(200).json({
        message: 'Order pushed to ShipRocket successfully',
        shiprocket_order_id: srOrderId,
        shipment_id: shipmentId,
        awb: awbCode,
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

      // Persist AWB on the forward shipment (V2) and bump the order status.
      const awbCode = data?.response?.data?.awb_code;
      const srOrderId = data?.response?.data?.order_id;
      if (awbCode && srOrderId) {
        try {
          const ship = await Shipment.findOne({ where: { shiprocket_order_id: String(srOrderId), type: SHIPMENT_TYPE.FORWARD } });
          if (ship) {
            await ship.update({ awb_number: String(awbCode), status: SHIPMENT_STATUS.DISPATCHED, dispatched_at: new Date() });
            await Order.update({ status: 'AWB Assigned' }, { where: { id: ship.order_id } });
          }
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

      const ship = await Shipment.findOne({
        where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD, shiprocket_order_id: { [Op.ne]: null } },
        order: [['created_at', 'DESC']],
      });
      if (!ship?.shiprocket_order_id) {
        return res.status(400).json({ message: 'This order has not been pushed to ShipRocket yet' });
      }

      const data = await ShipRocketService.trackByOrderId(ship.shiprocket_order_id);
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
      const providedSecret =
        req.headers['x-api-key'] ||
        req.headers['x-webhook-secret'] ||
        req.headers['x-shiprocket-webhook-secret'];
      if (String(providedSecret || '') !== config.shiprocketWebhookSecret) {
        return res.status(401).json({ message: 'Invalid webhook secret' });
      }
      const payload = req.body || {};
      const awb = payload.awb || payload.awb_code || payload.awb_number || payload.shipment?.awb || payload.shipment_track?.awb_code;
      // ShipRocket is inconsistent about ids across webhook variants: order_id
      // may be their internal id OR the channel id (our order_number), with
      // sr_order_id / channel_order_id present in some payloads. Collect every
      // candidate and try them all.
      const idCandidates = [payload.order_id, payload.sr_order_id, payload.shiprocket_order_id, payload.shipment?.order_id]
        .filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
        .map((v) => String(v).trim());
      const channelOrderNumber = payload.channel_order_id ? String(payload.channel_order_id).trim() : null;
      // Best value to backfill shipments.shiprocket_order_id with — prefer
      // ShipRocket's internal id over the (possibly channel) order_id.
      const srInternalId = payload.sr_order_id || payload.shiprocket_order_id || payload.shipment?.order_id || payload.order_id || null;
      const rawStatus = payload.current_status || payload.shipment_status || payload.status || payload.activity || payload.shipment?.status;
      const nextStatus = mapShiprocketStatus(rawStatus);

      if (!nextStatus || (!awb && !idCandidates.length && !channelOrderNumber)) {
        return res.status(200).json({ message: 'Webhook ignored' });
      }

      // All status mutations run in one transaction with the order row locked so
      // concurrent / redelivered webhooks cannot interleave or double-process.
      const transaction = await sequelize.transaction();
      let committed = false;
      try {
      // Find order. Reverse shipments are still tracked on order_item_actions
      // (returns not yet migrated); forward shipments live in `shipments`.
      let order = null;
      let reverseAction = null;
      let forwardShipment = null;

      if (idCandidates.length) {
        reverseAction = await OrderItemAction.findOne({ where: { shiprocket_return_order_id: { [Op.in]: idCandidates } }, transaction });
      }
      if (!reverseAction && awb) {
        reverseAction = await OrderItemAction.findOne({ where: { shiprocket_return_awb: String(awb) }, transaction });
      }

      if (reverseAction) {
        order = await Order.findByPk(reverseAction.order_id, { transaction, lock: Transaction.LOCK.UPDATE });
      } else {
        const shipWhere = [];
        if (idCandidates.length) shipWhere.push({ shiprocket_order_id: { [Op.in]: idCandidates } });
        if (awb) shipWhere.push({ awb_number: String(awb) });
        if (shipWhere.length) {
          forwardShipment = await Shipment.findOne({
            where: { type: SHIPMENT_TYPE.FORWARD, [Op.or]: shipWhere },
            order: [['created_at', 'DESC']],
            transaction,
            lock: Transaction.LOCK.UPDATE,
          });
        }
        if (forwardShipment) {
          order = await Order.findByPk(forwardShipment.order_id, { transaction, lock: Transaction.LOCK.UPDATE });
        }

        // Fallback: real ShipRocket webhooks often carry the CHANNEL order id
        // (our order_number) instead of their internal id. Before the first
        // AWB-assigned event no AWB is stored locally, so without this the
        // initial webhook can never match the shipment.
        if (!order) {
          const numbers = [channelOrderNumber, ...idCandidates].filter(Boolean);
          // A redispatch pushes ShipRocket a suffixed channel id (<order_number>-R1);
          // match on the base order_number too so its webhooks still resolve.
          const withBase = Array.from(new Set([
            ...numbers,
            ...numbers.map((n) => String(n).replace(/-R\d+$/i, '')),
          ]));
          if (withBase.length) {
            order = await Order.findOne({
              where: { order_number: { [Op.in]: withBase } },
              transaction,
              lock: Transaction.LOCK.UPDATE,
            });
            if (order) {
              forwardShipment = await Shipment.findOne({
                where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD },
                order: [['created_at', 'DESC']],
                transaction,
                lock: Transaction.LOCK.UPDATE,
              });
            }
          }
        }
      }

      if (!order) {
        await transaction.rollback();
        return res.status(200).json({ message: 'Order not found locally' });
      }

      // A cancelled order must never be revived by a late or redelivered
      // courier webhook (e.g. an AWB-assigned event racing a cancellation).
      if (['cancelled', 'seller cancelled'].includes(String(order.status || '').toLowerCase())) {
        await transaction.rollback();
        console.warn(`[ShipRocket] Webhook '${nextStatus}' ignored — order #${order.id} is ${order.status}.`);
        return res.status(200).json({ message: 'Order is cancelled — webhook ignored' });
      }

      const isReverse = Boolean(reverseAction);
      const prevStatus = order.status;
      let orderStatus = nextStatus;
      const orderUpdate = {};

      if (isReverse) {
        const isExchange = reverseAction.action_type === ACTION_TYPES.EXCHANGE;
        const prefix = isExchange ? 'Exchange' : 'Return';
        if (nextStatus === 'Shipped') orderStatus = `${prefix} Shipped`;
        else if (nextStatus === 'Returned') orderStatus = `${prefix} Completed`;
        else if (nextStatus === 'RTO Delivered') orderStatus = `${prefix} Completed`;
        else if (nextStatus === 'Cancelled') orderStatus = `${prefix} Cancelled`;
        else if (nextStatus === 'Delivered') orderStatus = `${prefix} Delivered`;
        else if (nextStatus === 'Return Picked Up') orderStatus = `${prefix} Picked Up`;
        else if (nextStatus === 'Out For Pickup') orderStatus = `Out For ${prefix} Pickup`;
        else if (nextStatus === 'Pickup Scheduled') orderStatus = `${prefix} Pickup Scheduled`;

        if (awb && !reverseAction.shiprocket_return_awb) {
          await reverseAction.update({ shiprocket_return_awb: String(awb) }, { transaction });
        }

        // Terminal reverse scan — the parcel is back with us. Close the open
        // action rows and item status pointers so the item-wise status matches
        // the order status (previously only the order flipped, leaving items
        // stuck on "Return Initiated"). No money moves here — the admin still
        // presses "Initiate refund" explicitly.
        if (orderStatus === `${prefix} Completed`) {
          const reverseType = reverseAction.action_type;
          const allTypeActions = await OrderItemAction.findAll({
            where: { order_id: order.id, action_type: reverseType },
            transaction,
          });
          const openActions = allTypeActions.filter(
            (act) => ![ACTION_STATUS.COMPLETED, ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED].includes(act.status),
          );
          for (const act of openActions) {
            await act.update({ status: ACTION_STATUS.COMPLETED, completed_at: new Date() }, { transaction });
            const itemRow = await OrderItem.findByPk(act.order_item_id, { transaction });
            if (itemRow) {
              const completedQty = allTypeActions
                .filter((a) => Number(a.order_item_id) === Number(itemRow.id))
                .filter((a) => a.id === act.id || a.status === ACTION_STATUS.COMPLETED)
                .reduce((sum, a) => sum + Number(a.quantity || 0), 0);
              await itemRow.update(
                { status: statusAfterCompletedAction(reverseType, completedQty >= Number(itemRow.quantity || 0)) },
                { transaction },
              );
            }
          }

          // COD returns are paid by manual bank transfer — ask the customer
          // for bank details the moment the parcel is back.
          if (reverseType === ACTION_TYPES.RETURN && String(order.payment_method || '').toUpperCase() === 'COD') {
            const refundRow = await OrderRefund.findOne({ where: { order_item_action_id: reverseAction.id }, transaction })
              || await OrderRefund.findOne({
                where: { order_id: order.id, refund_type: REFUND_TYPE.RETURN },
                order: [['created_at', 'DESC']],
                transaction,
              });
            if (refundRow && !refundRow.bank_details && refundRow.status === REFUND_STATUS.PENDING) {
              await refundRow.update({ status: 'Bank Details Required' }, { transaction });
            }
          }
        }
      } else {
        // The mapper labels pickup scans with reverse-flavoured names because
        // returns send the same texts ("PICKED UP", "OUT FOR PICKUP"). On a
        // forward shipment they are the courier collecting the parcel from us.
        if (nextStatus === 'Return Picked Up') orderStatus = 'Picked Up';

        // ── Forward shipment: update the shipment row, not the order ──
        // Late or out-of-order pre-delivery scans must not regress a delivered order.
        if (order.delivered_at && ['AWB Assigned', 'Pickup Scheduled', 'Out For Pickup', 'Return Picked Up', 'Shipped', 'Out For Delivery', 'Undelivered'].includes(nextStatus)) {
          await transaction.rollback();
          return res.status(200).json({ message: 'Stale webhook after delivery — ignored' });
        }
        const shipStatusMap = {
          'AWB Assigned': SHIPMENT_STATUS.DISPATCHED,
          'Return Picked Up': SHIPMENT_STATUS.DISPATCHED, // forward pickup scan — parcel is with the courier
          'Shipped': SHIPMENT_STATUS.IN_TRANSIT,
          'Out For Delivery': SHIPMENT_STATUS.IN_TRANSIT,
          'Delivered': SHIPMENT_STATUS.DELIVERED,
          'RTO Initiated': SHIPMENT_STATUS.RTO,
          'RTO In Transit': SHIPMENT_STATUS.RTO,
          'RTO Delivered': SHIPMENT_STATUS.RTO,
        };
        if (forwardShipment) {
          const shipUpdate = {};
          if (shipStatusMap[nextStatus]) shipUpdate.status = shipStatusMap[nextStatus];
          if (awb && !forwardShipment.awb_number) shipUpdate.awb_number = String(awb);
          if (srInternalId && !forwardShipment.shiprocket_order_id) shipUpdate.shiprocket_order_id = String(srInternalId);
          // The webhook carries the courier ShipRocket actually assigned (which
          // can differ from the one picked at checkout) — persist it so the
          // order page and admin show the real courier.
          if (payload.courier_name && forwardShipment.courier !== String(payload.courier_name)) {
            shipUpdate.courier = String(payload.courier_name);
          }
          if (nextStatus === 'AWB Assigned') {
            shipUpdate.selected_courier_data = {
              ...(forwardShipment.selected_courier_data || {}),
              courier_name: payload.courier_name || forwardShipment.selected_courier_data?.courier_name || null,
              courier_company_id: payload.courier_id ?? forwardShipment.selected_courier_data?.courier_company_id ?? null,
              awb_code: awb ? String(awb) : forwardShipment.awb_number || null,
              etd: payload.etd || forwardShipment.selected_courier_data?.etd || null,
              awb_assigned_date: payload.awb_assigned_date || payload.current_timestamp || null,
            };
          }
          if (nextStatus === 'Delivered' && !forwardShipment.delivered_at) shipUpdate.delivered_at = new Date();
          if (['RTO Initiated', 'RTO In Transit', 'RTO Delivered'].includes(nextStatus) && !forwardShipment.rto_at) shipUpdate.rto_at = new Date();
          if (Object.keys(shipUpdate).length) await forwardShipment.update(shipUpdate, { transaction });
        }

        if (nextStatus === 'Delivered' && !order.delivered_at) {
          orderUpdate.delivered_at = new Date();
          // COD: the courier collected cash on delivery — record it so the
          // ledger balance settles to 0.
          if (String(order.payment_method || '').toUpperCase() === 'COD') {
            const bal = await getOrderBalance(order.id, transaction);
            if (bal > 0) {
              await appendEntry(order.id, {
                type: LEDGER_ENTRY_TYPE.COD_COLLECTION, amount: bal, direction: LEDGER_DIRECTION.CREDIT,
                referenceType: LEDGER_REFERENCE_TYPE.SHIPMENT, referenceId: forwardShipment?.id || null,
                note: 'COD collected on delivery',
              }, transaction);
            }
          }
        }

        if (nextStatus === 'RTO Delivered' && forwardShipment) {
          // Idempotency: one rto_event per forward shipment.
          const existingRto = await RtoEvent.findOne({ where: { shipment_id: forwardShipment.id }, transaction });
          if (!existingRto) {
            const isCodOrder = String(order.payment_method || '').toUpperCase() === 'COD';
            const forwardCharge = forwardChargeOf(forwardShipment);
            const rtoCharge = rtoChargeOf(forwardShipment);

            if (isCodOrder) {
              // COD: product returned, nothing collected → block COD (terminal).
              const rtoEvent = await RtoEvent.create({
                shipment_id: forwardShipment.id,
                order_id: order.id,
                payment_method: 'COD',
                forward_charge_to_recover: 0,
                rto_charge: 0,
                resolution: RTO_RESOLUTION.PRODUCT_RETURNED_COD_BLOCKED,
              }, { transaction });
              await blockCustomerCodForOrder(order, COD_RTO_BLOCK_REASON, transaction);
              // Zero the uncollected COD balance (product is back with us).
              const bal = await getOrderBalance(order.id, transaction);
              if (bal > 0) {
                await appendEntry(order.id, {
                  type: LEDGER_ENTRY_TYPE.PRODUCT_CHARGE, amount: bal, direction: LEDGER_DIRECTION.CREDIT,
                  referenceType: LEDGER_REFERENCE_TYPE.RTO_EVENT, referenceId: rtoEvent.id,
                  note: 'COD RTO — order returned, nothing collected',
                }, transaction);
              }
              // Restore any wallet credit spent on this COD order. Nothing was
              // collected and no logistics are charged back on COD RTO, so the
              // full wallet amount is returned to the customer's wallet.
              const codTotals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: order.id }, transaction }));
              const codWallet = toMoney(codTotals.wallet_amount);
              if (codWallet > 0 && order.customer_id) {
                const dedupeKey = `rto_wallet:${rtoEvent.id}`;
                const existingWallet = await WalletTransaction.findOne({ where: { dedupe_key: dedupeKey }, transaction });
                if (!existingWallet) {
                  await WalletTransaction.create({
                    customer_id: order.customer_id,
                    amount: codWallet,
                    type: 'RTO_REFUND',
                    status: 'completed',
                    available_at: null,
                    dedupe_key: dedupeKey,
                    meta: { order_id: order.id, rto_event_id: rtoEvent.id },
                  }, { transaction });
                  await Customer.increment({ wallet_balance: codWallet }, { where: { id: order.customer_id }, transaction });
                }
              }
              orderUpdate.cancelled_at = new Date();
              orderStatus = 'Seller Cancelled';
              const existingRtoRefund = await OrderRefund.findOne({ where: { order_id: order.id, refund_type: REFUND_TYPE.RTO }, transaction });
              if (!existingRtoRefund) {
                await OrderRefund.create({
                  order_id: order.id, refund_type: REFUND_TYPE.RTO,
                  amount: codWallet,
                  status: codWallet > 0 ? REFUND_STATUS.COMPLETED : REFUND_STATUS.NOT_REQUIRED,
                  payment_method: REFUND_PAYMENT_METHOD.NOT_REQUIRED,
                  ...(codWallet > 0 ? { processed_at: new Date() } : {}),
                  note: codWallet > 0
                    ? `Order cancelled due to unsuccessful delivery. COD is now blocked for this account. Rs. ${codWallet.toLocaleString('en-IN')} wallet credit returned to your wallet.`
                    : 'Order cancelled due to unsuccessful delivery. COD is now blocked for this account.',
                }, { transaction });
              }
            } else {
              // Prepaid: record the event with the logistics owed. The ledger
              // money is posted at resolve time (redispatch payment vs. abandon),
              // so the charges aren't stranded if the customer chooses a refund.
              await RtoEvent.create({
                shipment_id: forwardShipment.id,
                order_id: order.id,
                payment_method: 'Prepaid',
                forward_charge_to_recover: forwardCharge,
                rto_charge: rtoCharge,
                resolution: RTO_RESOLUTION.AWAITING_PAYMENT,
              }, { transaction });
              orderStatus = 'RTO';
              const existingRtoRefund = await OrderRefund.findOne({ where: { order_id: order.id, refund_type: REFUND_TYPE.RTO }, transaction });
              if (!existingRtoRefund) {
                const payable = toMoney(forwardCharge + rtoCharge);
                await OrderRefund.create({
                  order_id: order.id, refund_type: REFUND_TYPE.RTO, amount: 0,
                  status: 'RTO Action Required', payment_method: REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
                  note: `Order returned to seller. Pay Rs. ${payable.toLocaleString('en-IN')} (forward Rs. ${toMoney(forwardCharge).toLocaleString('en-IN')} + RTO Rs. ${toMoney(rtoCharge).toLocaleString('en-IN')}) to re-dispatch, or request a refund.`,
                }, { transaction });
              }
            }
          }
        }
      }

      orderUpdate.status = orderStatus;
      const statusChanged = orderStatus !== prevStatus;
      await order.update(orderUpdate, { transaction });
      // Redelivered webhooks with an unchanged status shouldn't duplicate the
      // history timeline or re-send the customer email.
      if (statusChanged) {
        await recordStatus(order.id, prevStatus, orderStatus, ACTOR.SYSTEM, isReverse ? 'Reverse shipment update' : 'Shipment update', transaction);
      }
      await transaction.commit();
      committed = true;

      if (statusChanged) {
        EmailService.sendOrderStatusUpdate({ ...order.toJSON(), ...orderUpdate }, orderStatus).catch((emailError) => {
          console.error(`[Email] ShipRocket webhook email failed for order #${order.id}:`, emailError.message);
        });
      }

      return res.status(200).json({ message: 'Order status synced', orderId: order.id, status: orderStatus });
      } catch (innerError) {
        if (!committed) await transaction.rollback();
        throw innerError;
      }
    } catch (error) {
      console.error('[ShipRocket] webhook error:', error?.response?.data || error.message);
      return res.status(500).json({ message: 'Webhook failed' });
    }
  }

  // ── TESTING ONLY: forge a ShipRocket status webhook for an order ─────────────
  // POST /api/shiprocket/test-status — guarded by the same x-api-key webhook
  // secret. Looks up the order's shipment identifiers itself, builds the payload
  // ShipRocket would send, and runs it through the REAL webhook handler, so a
  // Postman call exercises the exact production path (status mapping, ledger,
  // RTO events, emails, history timeline).
  // Body: { orderId | orderNumber, status, awb?, courier?, target? }
  //   status: raw ShipRocket status text, e.g. "PICKED UP", "RTO INITIATED".
  //   target: "forward" (default) | "reverse" — reverse fires at the order's
  //           latest return/exchange shipment instead of the forward one.
  async simulateStatus(req, res) {
    try {
      const providedSecret =
        req.headers['x-api-key'] ||
        req.headers['x-webhook-secret'] ||
        req.headers['x-shiprocket-webhook-secret'];
      if (String(providedSecret || '') !== config.shiprocketWebhookSecret) {
        return res.status(401).json({ message: 'Invalid webhook secret' });
      }

      const { orderId, orderNumber, status, awb, courier, target = 'forward' } = req.body || {};
      if (!status || (!orderId && !orderNumber)) {
        return res.status(400).json({ message: 'status and orderId (or orderNumber) are required' });
      }

      const order = orderId
        ? await Order.findByPk(orderId)
        : await Order.findOne({ where: { order_number: String(orderNumber) } });
      if (!order) return res.status(404).json({ message: 'Order not found' });

      let payload;
      if (String(target).toLowerCase() === 'reverse') {
        const action = await OrderItemAction.findOne({
          where: { order_id: order.id, shiprocket_return_order_id: { [Op.ne]: null } },
          order: [['id', 'DESC']],
        });
        if (!action) return res.status(404).json({ message: 'No return/exchange shipment found for this order' });
        payload = {
          order_id: action.shiprocket_return_order_id,
          awb: awb || action.shiprocket_return_awb || undefined,
          current_status: status,
          courier_name: courier || undefined,
          is_return: 1,
        };
      } else {
        const shipment = await Shipment.findOne({
          where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD },
          order: [['created_at', 'DESC']],
        });
        payload = {
          order_id: shipment?.shiprocket_order_id || undefined,
          channel_order_id: order.order_number,
          awb: awb || shipment?.awb_number || undefined,
          current_status: status,
          courier_name: courier || undefined,
        };
      }

      console.log(`[ShipRocket][TEST] Simulating '${status}' for order #${order.id} (${target})`);
      req.body = payload;
      return shipRocketController.webhook(req, res);
    } catch (error) {
      console.error('[ShipRocket] simulateStatus error:', error.message);
      return res.status(500).json({ message: 'Simulation failed' });
    }
  }

  // ── Resolve a prepaid RTO: customer pays to re-dispatch, or abandons for refund ──
  // Body: { orderId, action: 'redispatch' | 'abandon',
  //         gateway_payment_id?, gateway?  (proof of the redispatch payment) }
  async resolveRto(req, res) {
    const transaction = await sequelize.transaction();
    let committed = false;
    try {
      const { orderId, action, gateway_payment_id = null, gateway = 'razorpay' } = req.body;
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

      const rto = await RtoEvent.findOne({
        where: { order_id: order.id, resolution: RTO_RESOLUTION.AWAITING_PAYMENT },
        order: [['created_at', 'DESC']],
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      if (!rto) {
        await transaction.rollback();
        return res.status(400).json({ message: 'No RTO awaiting resolution for this order.' });
      }

      const F = toMoney(rto.forward_charge_to_recover);
      const R = toMoney(rto.rto_charge);
      const payable = toMoney(F + R);

      if (action === 'redispatch') {
        // Customer paid the redispatch fee (forward + RTO). Record charges + payment.
        if (F > 0) await appendEntry(order.id, { type: LEDGER_ENTRY_TYPE.SHIPPING_CHARGE, amount: F, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RTO_EVENT, referenceId: rto.id, note: 'Redispatch: forward shipping' }, transaction);
        if (R > 0) await appendEntry(order.id, { type: LEDGER_ENTRY_TYPE.RTO_CHARGE, amount: R, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RTO_EVENT, referenceId: rto.id, note: 'Redispatch: RTO charge' }, transaction);
        const payLedger = payable > 0
          ? await appendEntry(order.id, { type: LEDGER_ENTRY_TYPE.PAYMENT, amount: payable, direction: LEDGER_DIRECTION.CREDIT, referenceType: LEDGER_REFERENCE_TYPE.PAYMENT, referenceId: rto.id, note: 'Redispatch payment received' }, transaction)
          : null;
        if (payable > 0) {
          await PaymentTransaction.create({
            order_id: order.id, ledger_entry_id: payLedger?.id || null,
            gateway, gateway_ref: gateway_payment_id, amount: payable, status: 'Paid',
          }, { transaction });
        }

        // New forward shipment (same order) from the current address + active items.
        const addr = await OrderAddress.findOne({ where: { order_id: order.id, is_current: true }, transaction });
        const items = await OrderItem.findAll({ where: { order_id: order.id, status: { [Op.notIn]: ['Cancelled', 'REMOVED'] } }, transaction });
        // Redispatch attempt number = how many forward shipments already exist
        // (the original that RTO'd counts as #1). Drives a UNIQUE ShipRocket
        // channel order id so the re-push isn't rejected as a duplicate.
        const priorForwardCount = await Shipment.count({ where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD }, transaction });
        const redispatchSeq = Math.max(1, priorForwardCount);
        const redispatchChannelId = `${order.order_number}-R${redispatchSeq}`;
        const shipment = await Shipment.create({
          order_id: order.id, address_id: addr?.id || null,
          type: SHIPMENT_TYPE.FORWARD, status: SHIPMENT_STATUS.CREATED, forward_charge: F,
          rto_event_id: rto.id,
        }, { transaction });
        await ShipmentItem.bulkCreate(items.map((i) => ({ shipment_id: shipment.id, order_item_id: i.id, quantity: i.quantity })), { transaction });

        await rto.update({ resolution: RTO_RESOLUTION.REDISPATCHED }, { transaction });
        await order.update({ status: 'Processing', cancelled_at: null }, { transaction });
        await recordStatus(order.id, 'RTO', 'Processing', req.userRole === 'admin' ? ACTOR.ADMIN : ACTOR.CUSTOMER, 'RTO redispatch paid', transaction);
        await OrderRefund.update(
          { status: REFUND_STATUS.NOT_REQUIRED, note: 'Customer paid to re-dispatch the order.' },
          { where: { order_id: order.id, refund_type: REFUND_TYPE.RTO }, transaction },
        );

        await transaction.commit();
        committed = true;

        // Best-effort: push the new forward shipment to ShipRocket.
        (async () => {
          try {
            const srItems = items.map((i, idx) => ({ product_id: i.product_id, quantity: i.quantity, price: i.price, name: i.product_name || `Product ${idx + 1}`, sku: i.sku }));
            const totals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: order.id } }));
            const srResult = await ShipRocketService.createOrder({
              // order_number overridden so the re-dispatch is a NEW, unique
              // ShipRocket channel order id (else ShipRocket rejects the duplicate).
              order: { ...order.toJSON(), order_number: redispatchChannelId, address: addr?.line, city: addr?.city, pincode: addr?.pincode, phone: addr?.phone, state: addr?.state, total_amount: totals.total_amount, discount_amount: totals.discount_amount },
              items: srItems,
            });
            await shipment.update({
              status: srResult?.awb_code ? SHIPMENT_STATUS.DISPATCHED : SHIPMENT_STATUS.CREATED,
              awb_number: srResult?.awb_code ? String(srResult.awb_code) : null,
              shiprocket_order_id: srResult?.order_id ? String(srResult.order_id) : null,
              dispatched_at: srResult?.awb_code ? new Date() : null,
            });
          } catch (srErr) {
            console.error(`[ShipRocket] Redispatch push failed for order #${order.id}:`, srErr?.response?.data || srErr.message);
          }
        })();

        const balance = await getOrderBalance(order.id);
        return res.status(200).json({ message: 'Order re-dispatched.', redispatch_fee: payable, balance_due: balance, shipment_id: shipment.id });
      }

      // ── Abandon: refund what the customer paid, minus the forward + RTO charges ──
      // The customer's contribution has two sources: gateway money (amount_paid)
      // and wallet credit spent at checkout (wallet_amount). We keep F + R and
      // refund the rest, splitting it proportionally so the wallet-paid share
      // goes back to the wallet and the remainder to the original gateway
      // (mirrors the return-refund policy). If no wallet was used this collapses
      // to the old gateway-only behaviour.
      const totals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: order.id }, transaction }));
      const walletPaid = toMoney(totals.wallet_amount);
      const contribution = toMoney(totals.amount_paid + walletPaid);
      const refund = Math.max(0, toMoney(contribution - F - R));
      const walletShare = (walletPaid > 0 && order.customer_id && contribution > 0 && refund > 0)
        ? Math.min(walletPaid, refund, toMoney((refund / contribution) * walletPaid))
        : 0;
      const gatewayRefund = toMoney(Math.max(0, refund - walletShare));

      if (refund > 0) {
        // Reverse order value by the refund, then pay it back (balance-neutral, nets to 0).
        await appendEntry(order.id, { type: LEDGER_ENTRY_TYPE.PRODUCT_CHARGE, amount: refund, direction: LEDGER_DIRECTION.CREDIT, referenceType: LEDGER_REFERENCE_TYPE.RTO_EVENT, referenceId: rto.id, note: 'RTO abandoned — value returned' }, transaction);
        const refLedger = await appendEntry(order.id, { type: LEDGER_ENTRY_TYPE.REFUND, amount: refund, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RTO_EVENT, referenceId: rto.id, note: 'RTO refund (less forward + RTO charges)' }, transaction);
        // The gateway leg (RefundTransaction) tracks only the non-wallet remainder.
        if (gatewayRefund > 0) {
          await RefundTransaction.create({
            order_id: order.id, ledger_entry_id: refLedger?.id || null,
            gateway: 'original_gateway', amount: gatewayRefund, status: 'Pending',
          }, { transaction });
        }

        // Restore the wallet-paid share to the customer's wallet (atomic with
        // the rest of the resolution; deduped so a retry can't double-credit).
        if (walletShare > 0) {
          const dedupeKey = `rto_wallet:${rto.id}`;
          const existingWallet = await WalletTransaction.findOne({ where: { dedupe_key: dedupeKey }, transaction });
          if (!existingWallet) {
            await WalletTransaction.create({
              customer_id: order.customer_id,
              amount: walletShare,
              type: 'RTO_REFUND',
              status: 'completed',
              available_at: null,
              dedupe_key: dedupeKey,
              meta: { order_id: order.id, rto_event_id: rto.id },
            }, { transaction });
            await Customer.increment({ wallet_balance: walletShare }, { where: { id: order.customer_id }, transaction });
          }
        }
      }

      const walletNote = walletShare > 0 ? ` (incl. Rs. ${walletShare.toLocaleString('en-IN')} back to wallet)` : '';
      // No refund → nothing required. A gateway leg stays Pending until Razorpay
      // settles it; a wallet-only refund is already done inside this transaction.
      const refundStatus = refund <= 0
        ? REFUND_STATUS.NOT_REQUIRED
        : gatewayRefund > 0 ? REFUND_STATUS.PENDING : REFUND_STATUS.COMPLETED;
      await rto.update({ resolution: RTO_RESOLUTION.ABANDONED }, { transaction });
      await order.update({ status: 'Seller Cancelled', cancelled_at: new Date() }, { transaction });
      await recordStatus(order.id, 'RTO', 'Seller Cancelled', req.userRole === 'admin' ? ACTOR.ADMIN : ACTOR.CUSTOMER, 'RTO abandoned — refund', transaction);
      await OrderRefund.update(
        {
          amount: refund,
          status: refundStatus,
          ...(refundStatus === REFUND_STATUS.COMPLETED ? { processed_at: new Date() } : {}),
          note: `RTO refund of Rs. ${refund.toLocaleString('en-IN')} (after Rs. ${toMoney(F + R).toLocaleString('en-IN')} logistics)${walletNote}.`,
        },
        { where: { order_id: order.id, refund_type: REFUND_TYPE.RTO }, transaction },
      );

      await transaction.commit();
      committed = true;

      // Gateway refund covers only the non-wallet remainder (the wallet share was
      // already credited back above and never touched the gateway).
      if (gatewayRefund > 0) {
        Payment.findOne({ where: { order_id: order.id, status: 'Paid' } }).then((payment) => {
          if (payment?.gateway_payment_id) {
            return razorpayRefund(payment.gateway_payment_id, gatewayRefund, { reason: 'RTO abandoned', orderId: String(order.id) });
          }
        }).catch((err) => console.error(`[Razorpay] RTO refund failed for #${order.id}:`, err?.message || err));
      }

      return res.status(200).json({ message: 'RTO abandoned. Refund initiated.', refund_amount: refund, wallet_refund: walletShare, gateway_refund: gatewayRefund });
    } catch (error) {
      if (!committed) await transaction.rollback();
      console.error('[ShipRocket] resolveRto error:', error?.response?.data || error.message);
      return res.status(500).json({ message: 'Failed to resolve RTO', detail: error.message });
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
        // Reopen the item if it has no other open reverse action.
        const stillOpen = await OrderItemAction.count({
          where: {
            order_item_id: item.id,
            status: { [Op.notIn]: [ACTION_STATUS.COMPLETED, ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED] },
          },
          transaction,
        });
        await item.update({ status: stillOpen > 0 ? item.status : 'Active' }, { transaction });
      }

      await OrderRefund.update(
        { status: REFUND_STATUS.NOT_REQUIRED, note: reason ? `${label} cancelled: ${reason}` : `${label} request cancelled by customer.` },
        { where: { order_id: orderId, refund_type: refundType }, transaction },
      );
      const prevStatus = order.status;
      await order.update({ status: 'Delivered' }, { transaction });
      await recordStatus(order.id, prevStatus, 'Delivered', req.userRole === 'admin' ? ACTOR.ADMIN : ACTOR.CUSTOMER, `${label} request cancelled`, transaction);

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
