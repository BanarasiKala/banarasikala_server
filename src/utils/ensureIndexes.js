const { sequelize } = require('../config/db');
const { config } = require('../config/env');

/**
 * Foreign-key indexes for the order graph.
 *
 * Postgres creates an index automatically for PRIMARY KEY and UNIQUE constraints — but NOT
 * for foreign keys. Every `order_id` / `customer_id` column in this schema was therefore
 * unindexed, so a single My Orders page load ran NINE sequential scans:
 *
 *   orders (customer_id) + order_items, order_item_actions, order_refunds, order_addresses,
 *   order_ledger, shipments, order_status_history, rto_events (all order_id) + feedbacks
 *
 * Each `separate: true` include in ORDER_V2_INCLUDES issues its own
 * `WHERE order_id IN (...)`, and without an index each one reads the whole table. The cost
 * grows with total rows in the system, not with the rows the customer actually owns — so the
 * page gets slower for everyone every time anyone places an order. order_ledger (append-only,
 * several rows per money event) and order_status_history (a row per status change) grow
 * fastest and hurt most.
 *
 * CREATE INDEX IF NOT EXISTS is idempotent, so this is safe to run on every boot. It is NOT
 * run inside a request — see the call in server startup.
 */

// [table, columns] — mirrors the FKs the order queries actually filter on.
const ORDER_GRAPH_INDEXES = [
  ['orders', ['customer_id']],
  ['orders', ['customer_email']],
  ['order_items', ['order_id']],
  ['order_item_actions', ['order_id']],
  ['order_item_actions', ['order_item_id']],
  ['order_item_actions', ['request_group_id']],
  ['order_refunds', ['order_id']],
  ['order_refunds', ['order_item_action_id']],
  ['order_addresses', ['order_id']],
  ['order_ledger', ['order_id']],
  ['order_status_history', ['order_id']],
  ['shipments', ['order_id']],
  ['shipments', ['exchange_action_id']],
  ['rto_events', ['order_id']],
  ['rto_events', ['shipment_id']],
  ['shipment_items', ['shipment_id']],
  ['return_items', ['return_request_id']],
  ['return_requests', ['order_id']],
  ['payments', ['order_id']],
  ['feedbacks', ['customer_id']],
  ['feedbacks', ['order_id']],
  // Webhook lookups: every ShipRocket scan finds its shipment by these.
  ['shipments', ['awb_number']],
  ['shipments', ['shiprocket_order_id']],
  ['order_item_actions', ['shiprocket_return_awb']],
  ['order_item_actions', ['shiprocket_return_order_id']],
];

let indexesReady = false;

const ensureOrderIndexes = async () => {
  if (indexesReady) return;

  const schema = config.dbSchema;
  let created = 0;

  for (const [table, columns] of ORDER_GRAPH_INDEXES) {
    const name = `idx_${table}_${columns.join('_')}`;
    const cols = columns.map((c) => `"${c}"`).join(', ');
    try {
      const [, meta] = await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "${name}" ON "${schema}"."${table}" (${cols})`,
      );
      // Postgres reports 0 rows either way; count attempts that didn't throw.
      if (meta) created += 1;
    } catch (error) {
      // A missing table is expected on a fresh DB where that feature hasn't been used yet —
      // the model's own sync creates it later. Never block boot on an index.
      if (!/does not exist/i.test(error.message)) {
        console.error(`[Indexes] Could not create ${name}:`, error.message);
      }
    }
  }

  indexesReady = true;
  console.log(`[Indexes] Order-graph indexes ensured (${created} statements ran).`);
};

module.exports = { ensureOrderIndexes, ORDER_GRAPH_INDEXES };
