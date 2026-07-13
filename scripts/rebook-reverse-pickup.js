/**
 * One-off re-book of a reverse (return / exchange) pickup that never got its own
 * ShipRocket booking.
 *
 * Why this exists: reverse orders used to be pushed to ShipRocket under a channel order id
 * of `RET-${order_number}`, which is the same for every reverse request on an order. A
 * second reverse request (e.g. an exchange raised after a return) therefore collided with
 * the first: ShipRocket echoed back the FIRST return order's id instead of booking a new
 * pickup, so the parcel was never actually scheduled for collection. That id is now unique
 * per request group, but requests booked before the fix are still orphaned.
 *
 * This re-runs the SAME post-commit path a fresh request uses (finalizeReverseActions), so
 * it books a real pickup, writes a REVERSE shipment row for the request, and stamps the new
 * ShipRocket id onto the anchor action. Nothing about the request itself (items, quantities,
 * refund, ledger) is touched — only the courier booking.
 *
 * Usage:
 *   node scripts/rebook-reverse-pickup.js --order 84 --group 34            # do it
 *   node scripts/rebook-reverse-pickup.js --order 84 --group 34 --dry-run  # inspect only
 *   node scripts/rebook-reverse-pickup.js --order 84                       # list groups
 */
require('dotenv').config();

const { sequelize } = require('../src/config/db');
const Order = require('../src/models/Order');
const OrderItem = require('../src/models/OrderItem');
const OrderItemAction = require('../src/models/OrderItemAction');
const Shipment = require('../src/models/Shipment');
const OrderReturnService = require('../src/services/OrderReturnService');
const { SHIPMENT_TYPE } = require('../src/utils/orderModelV2');

const argOf = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : null;
};

const groupIdOf = (action) => Number(action.request_group_id || action.id);

(async () => {
  const orderId = Number(argOf('order'));
  const groupId = argOf('group') ? Number(argOf('group')) : null;
  const dryRun = process.argv.includes('--dry-run');

  if (!orderId) {
    console.error('Usage: node scripts/rebook-reverse-pickup.js --order <orderId> [--group <requestGroupId>] [--dry-run]');
    process.exit(1);
  }

  try {
    const order = await Order.findByPk(orderId);
    if (!order) throw new Error(`Order ${orderId} not found.`);

    const orderItems = await OrderItem.findAll({ where: { order_id: orderId } });
    const actions = await OrderItemAction.findAll({
      where: { order_id: orderId },
      order: [['created_at', 'ASC']],
    });

    const reverseActions = actions.filter((action) => (
      ['return', 'exchange'].includes(String(action.action_type || '').toLowerCase())
      && !['rejected', 'cancelled'].includes(String(action.status || '').toLowerCase())
    ));

    // Group the request's action rows together — one group per reverse request.
    const groups = new Map();
    reverseActions.forEach((action) => {
      const key = groupIdOf(action);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(action);
    });

    const reverseShipments = await Shipment.findAll({
      where: { order_id: orderId, type: SHIPMENT_TYPE.REVERSE },
    });
    const shipmentBySrId = new Map(
      reverseShipments.filter((s) => s.shiprocket_order_id).map((s) => [String(s.shiprocket_order_id), s]),
    );

    const anchorOf = (groupActions) => (
      groupActions.find((a) => a.shiprocket_return_order_id || a.shiprocket_return_awb) || groupActions[0]
    );
    const createdAtOf = (action) => new Date(action.created_at || action.createdAt || 0).getTime();

    // When several groups share one ShipRocket id, the EARLIEST request is the one that
    // actually created that booking; every later one merely collided with it and was never
    // really booked. Only those later ones need re-booking.
    const ownerGroupBySrId = new Map();
    for (const [key, groupActions] of groups) {
      const anchor = anchorOf(groupActions);
      const srId = anchor.shiprocket_return_order_id;
      if (!srId) continue;
      const current = ownerGroupBySrId.get(String(srId));
      if (!current || createdAtOf(anchor) < current.createdAt) {
        ownerGroupBySrId.set(String(srId), { key, createdAt: createdAtOf(anchor) });
      }
    }

    console.log(`\nOrder ${orderId} (${order.order_number}) — reverse requests:\n`);
    for (const [key, groupActions] of groups) {
      const anchor = anchorOf(groupActions);
      const srId = anchor.shiprocket_return_order_id;
      const ownRowId = Number(anchor.meta?.reverse_shipment_row_id) || null;
      const owner = srId ? ownerGroupBySrId.get(String(srId)) : null;
      const isOrphan = Boolean(srId) && owner && owner.key !== key;

      console.log(`  group ${key} — ${anchor.action_type} (${anchor.status})`);
      console.log(`    items            : ${groupActions.length}`);
      console.log(`    sr_return_order  : ${srId || '—'}`);
      console.log(`    sr_return_awb    : ${anchor.shiprocket_return_awb || '—'}`);
      console.log(`    own shipment row : ${ownRowId || (srId && shipmentBySrId.has(String(srId)) ? '(shared, by SR id)' : '—')}`);
      if (isOrphan) {
        console.log(`    ⚠ NEVER BOOKED — collided with group ${owner.key}, which owns SR order ${srId}.`);
        console.log(`      Re-book: node scripts/rebook-reverse-pickup.js --order ${orderId} --group ${key}`);
      } else if (!srId && !anchor.shiprocket_return_awb) {
        console.log('    ⚠ NEVER BOOKED — no ShipRocket identifiers at all.');
        console.log(`      Re-book: node scripts/rebook-reverse-pickup.js --order ${orderId} --group ${key}`);
      } else {
        console.log('    ✓ booked');
      }
      console.log('');
    }

    if (!groupId) {
      console.log('Pass --group <id> to re-book one of the above.\n');
      await sequelize.close();
      return;
    }

    const groupActions = groups.get(groupId);
    if (!groupActions?.length) throw new Error(`No reverse request with group ${groupId} on order ${orderId}.`);

    const actionType = String(groupActions[0].action_type).toLowerCase();
    const itemById = new Map(orderItems.map((item) => [Number(item.id), item]));

    // Same shape createReverseActions hands to finalizeReverseActions: { action, item, quantity }.
    // The anchor (the row that carries the ShipRocket ids) must come first — finalize stamps
    // the new booking onto entries[0].
    const ordered = [...groupActions].sort((a, b) => (
      Number(groupIdOf(a) === Number(a.id) ? 0 : 1) - Number(groupIdOf(b) === Number(b.id) ? 0 : 1)
    ));
    const entries = ordered.map((action) => ({
      action,
      item: itemById.get(Number(action.order_item_id)),
      quantity: Number(action.quantity || 1),
    })).filter((entry) => entry.item);

    if (!entries.length) throw new Error('Could not resolve the order items for this request.');

    console.log(`Re-booking group ${groupId} (${actionType}) with ${entries.length} item(s):`);
    entries.forEach(({ item, quantity }) => console.log(`  · ${item.product_name} × ${quantity}`));

    if (dryRun) {
      console.log('\n--dry-run: nothing was sent to ShipRocket.\n');
      await sequelize.close();
      return;
    }

    // Clear the stale id so the anchor can't be mistaken for already-booked, then re-run the
    // exact path a fresh request takes. finalizeReverseActions is post-commit by design and
    // safe to re-run: it creates the request's own REVERSE shipment row (remembering it on
    // the action) and overwrites the anchor's ShipRocket ids with the new booking's.
    const anchor = entries[0].action;
    await anchor.update({ shiprocket_return_order_id: null, shiprocket_return_awb: null });

    const finalize = await OrderReturnService.finalizeReverseActions({
      order,
      entries,
      actionType,
      reason: `Re-book of ${actionType} request #${groupId}`,
    });

    if (!finalize.booked) {
      console.error(`\n✗ ShipRocket did not accept the pickup: ${finalize.error}\n`);
      process.exitCode = 1;
    } else {
      console.log('\n✓ Pickup re-booked.');
      console.log(`  shiprocket_return_order_id : ${finalize.shiprocketReturnId}`);
      console.log(`  reverse shipment row       : ${finalize.reverseShipmentId}\n`);
    }
  } catch (error) {
    console.error(`\n✗ ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
