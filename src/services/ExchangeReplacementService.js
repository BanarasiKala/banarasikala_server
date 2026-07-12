const { Op } = require('sequelize');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const OrderAddress = require('../models/OrderAddress');
const OrderItemAction = require('../models/OrderItemAction');
const Shipment = require('../models/Shipment');
const ShipmentItem = require('../models/ShipmentItem');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const ShipRocketService = require('./ShipRocketService');
const { findOrderRateCard } = require('../utils/rateCard');
const { ACTION_TYPES, ACTION_STATUS, roundMoney } = require('../utils/orderItemActions');
const {
  SHIPMENT_TYPE, SHIPMENT_STATUS, ACTOR,
} = require('../utils/orderModelV2');

/**
 * Ship the replacement goods for a COMPLETED exchange.
 *
 * Until now the exchange flow only implemented the INBOUND half: it collected the old item
 * back, set the order to "Exchange Completed", emailed the admin "replacement required" and
 * stopped. Nothing created an outbound shipment, so the customer had no AWB, no tracking,
 * and an order that claimed to be finished while they waited for goods no system had been
 * told to send.
 *
 * Shape follows RTO re-dispatch (ShipRocketController.resolveRto), which already solves the
 * same problem — a SECOND forward shipment on an EXISTING order:
 *   • a new FORWARD Shipment on the same order (never a new Order: that would double-count
 *     revenue and detach the replacement from the exchange that justified it);
 *   • the order's rate card carried across, so a later RTO on this shipment can still price
 *     its return leg;
 *   • a UNIQUE ShipRocket channel order id (-X1, -X2…), because ShipRocket rejects a
 *     duplicate order_number outright.
 *
 * The replacement ships FREE (forward_charge: 0). That is the policy the codebase already
 * promises the customer twice: "No monetary refund applies for one approved exchange" and
 * "No delivery deduction applies for one approved exchange." No ledger entry is made — no
 * money moves, so there is nothing to record.
 *
 * Best-effort and never throws: the exchange is already committed and the goods are already
 * back with us. A ShipRocket outage must not undo that — it leaves the Shipment row in
 * CREATED with a `replacement_push_failed` marker, which is exactly what a re-book needs.
 */

const REPLACEMENT_FAILED_KEY = 'replacement_push_failed';

const createReplacement = async ({ orderId, actionIds = [] }) => {
  const result = { shipmentId: null, shiprocketOrderId: null, awb: null, booked: false, error: null };

  try {
    const order = await Order.findByPk(orderId);
    if (!order) return result;

    // Only the items of THIS exchange request ship — a partial exchange must not re-send the
    // items the customer kept.
    const actions = await OrderItemAction.findAll({
      where: {
        id: actionIds,
        order_id: orderId,
        action_type: ACTION_TYPES.EXCHANGE,
        status: ACTION_STATUS.COMPLETED,
      },
    });
    if (!actions.length) return result;

    const orderItems = await OrderItem.findAll({
      where: { id: actions.map((a) => a.order_item_id) },
    });
    const itemById = new Map(orderItems.map((item) => [Number(item.id), item]));

    // Reuse an existing shipment row for these actions instead of creating a second one
    // (double-ship guard). If it's already booked with the courier, we're done — report it
    // and stop. If it exists but was NEVER booked (a prior ShipRocket outage left it in
    // CREATED with no awb/order id), fall through and retry the courier push on this SAME
    // row rather than creating a duplicate — that's the "retry/re-book must be safe" this
    // comment always promised but, until now, never actually did (it just gave up and
    // reported "already exists" forever).
    let shipment = await Shipment.findOne({
      where: { order_id: orderId, type: SHIPMENT_TYPE.FORWARD, exchange_action_id: actions[0].id },
    });
    if (shipment && (shipment.shiprocket_order_id || shipment.awb_number)) {
      result.shipmentId = shipment.id;
      result.shiprocketOrderId = shipment.shiprocket_order_id;
      result.awb = shipment.awb_number;
      result.booked = true;
      return result;
    }

    const address = await OrderAddress.findOne({ where: { order_id: orderId, is_current: true } });

    if (!shipment) {
      const rateCard = await findOrderRateCard(orderId);
      shipment = await Shipment.create({
        order_id: orderId,
        address_id: address?.id || null,
        type: SHIPMENT_TYPE.FORWARD,
        status: SHIPMENT_STATUS.CREATED,
        forward_charge: 0, // One approved exchange ships free — see header.
        selected_courier_data: rateCard,
        exchange_action_id: actions[0].id,
      });

      await ShipmentItem.bulkCreate(actions.map((action) => ({
        shipment_id: shipment.id,
        order_item_id: action.order_item_id,
        quantity: action.quantity,
      })));

      // Back into the forward lifecycle. The webhook drives it from here exactly as it does
      // a re-dispatch: Processing -> AWB Assigned -> Shipped -> Delivered, and the customer
      // gets a real tracking button again. Only on first creation — a retry after a failed
      // push doesn't need a second "back to Processing" transition.
      const previousStatus = order.status;
      await order.update({ status: 'Processing' });
      await OrderStatusHistory.create({
        order_id: orderId,
        from_status: previousStatus,
        to_status: 'Processing',
        actor: ACTOR.SYSTEM,
        reason: `Exchange replacement dispatched — ${actions.length} item(s)`,
      });
    }
    result.shipmentId = shipment.id;

    // Unique ShipRocket channel id. Counting prior forward shipments EXCLUDING this one
    // (original dispatch, any RTO re-dispatches, any earlier replacement) guarantees it
    // can't collide, and stays stable across a retry since it never counts itself twice.
    const priorForwardCount = await Shipment.count({
      where: { order_id: orderId, type: SHIPMENT_TYPE.FORWARD, id: { [Op.ne]: shipment.id } },
    });
    const channelOrderId = `${order.order_number}-X${Math.max(1, priorForwardCount)}`;

    // Declared value = the goods being carried (price × qty), same basis as the forward and
    // reverse legs. It is an insurance/liability figure, not a payment instruction — the
    // replacement is free to the customer.
    const srItems = actions.map((action) => {
      const item = itemById.get(Number(action.order_item_id));
      return {
        product_id: item?.product_id || action.product_id,
        quantity: action.quantity,
        price: Number(item?.price || 0),
        name: item?.product_name || `Product #${action.product_id}`,
        sku: item?.sku || null,
      };
    });
    const declaredTotal = roundMoney(srItems.reduce(
      (sum, line) => sum + Number(line.price) * Math.max(1, Number(line.quantity || 1)),
      0,
    ));

    try {
      const srResult = await ShipRocketService.createOrder({
        order: {
          ...order.toJSON(),
          // Overridden so this is a NEW, unique ShipRocket channel order id.
          order_number: channelOrderId,
          // An exchange replacement is never COD — the customer already paid for the goods.
          payment_method: 'Prepaid',
          address: address?.line,
          city: address?.city,
          pincode: address?.pincode,
          phone: address?.phone,
          state: address?.state,
          total_amount: declaredTotal,
          discount_amount: 0,
        },
        items: srItems,
      });

      const srOrderId = srResult?.order_id ? String(srResult.order_id) : null;
      const awb = srResult?.awb_code ? String(srResult.awb_code) : null;

      await shipment.update({
        status: awb ? SHIPMENT_STATUS.DISPATCHED : SHIPMENT_STATUS.CREATED,
        awb_number: awb,
        shiprocket_order_id: srOrderId,
        dispatched_at: awb ? new Date() : null,
      });

      result.shiprocketOrderId = srOrderId;
      result.awb = awb;
      result.booked = Boolean(srOrderId || awb);

      if (!result.booked) {
        throw new Error('ShipRocket accepted the replacement order but returned no order_id/awb.');
      }
    } catch (srError) {
      // The Shipment row stays (CREATED, no SR id) so the goods are still owed and a re-book
      // has something to work with. Mark the action so it is findable rather than silent.
      result.error = srError?.response?.data || srError.message;
      console.error(`[Exchange] Replacement push failed for order #${orderId}:`, result.error);
      await OrderItemAction.update(
        {
          meta: {
            ...(actions[0].meta || {}),
            [REPLACEMENT_FAILED_KEY]: true,
            replacement_push_error: String(srError.message || '').slice(0, 500),
            replacement_push_failed_at: new Date().toISOString(),
          },
        },
        { where: { id: actions[0].id } },
      ).catch(() => {});
    }

    return result;
  } catch (error) {
    console.error(`[Exchange] Could not create replacement for order #${orderId}:`, error.message);
    result.error = error.message;
    return result;
  }
};

module.exports = { createReplacement, REPLACEMENT_FAILED_KEY };
