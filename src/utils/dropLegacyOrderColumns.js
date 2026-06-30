/**
 * dropLegacyOrderColumns.js
 *
 * Phase 1b — force-drop the legacy order columns that are superseded by the V2
 * tables. Run once (test data was already cleared). Idempotent: DROP COLUMN IF
 * EXISTS, so re-running is a no-op.
 *
 * NOTE: This intentionally takes the legacy order/payment/RTO/return flow
 * offline until Phase 2 rewrites the controllers onto the ledger + shipments.
 *
 * Usage:  node src/utils/dropLegacyOrderColumns.js
 */
const { sequelize } = require('../config/db');
const { config } = require('../config/env');

// Columns removed from `orders` and where their data now lives.
const ORDERS_DROP = [
  // money → order_ledger / payment_transactions / refund_transactions
  'subtotal_amount', 'shipping_charge', 'shipping_discount', 'payment_fee',
  'platform_fee', 'cod_fee', 'payment_discount', 'discount_amount',
  'wallet_amount', 'payable_amount', 'gift_charge', 'total_amount',
  // shipping address → order_addresses (current_address_id stays)
  'address', 'city', 'pincode', 'phone', 'state',
  // RTO / redispatch → shipments / rto_events
  'is_rto', 'rto_count', 'is_redispatched', 'redispatch_count',
  'original_order_id', 'redispatch_payment_amount',
  // COD block → customers.is_cod_blocked + cod_block_events
  'customer_cod_blocked', 'cod_blocked_at', 'cod_block_reason',
  // modify flags → order_modifications
  'is_modified', 'modified_at',
  // status timeline → order_status_history
  'status_history',
  // courier / AWB → shipments
  'shiprocket_order_id', 'shiprocket_awb', 'selected_courier_data',
];

// Rollup counters removed from `order_items` → derived from shipment_items / return_items
const ORDER_ITEMS_DROP = [
  'cancelled_quantity', 'returned_quantity', 'exchanged_quantity',
  'pending_action_quantity',
];

const dropColumns = async (table, columns) => {
  const qualified = `"${config.dbSchema}"."${table}"`;
  for (const col of columns) {
    await sequelize.query(`ALTER TABLE ${qualified} DROP COLUMN IF EXISTS "${col}"`);
  }
};

const dropLegacyOrderColumns = async () => {
  await dropColumns('orders', ORDERS_DROP);
  await dropColumns('order_items', ORDER_ITEMS_DROP);
};

module.exports = { dropLegacyOrderColumns, ORDERS_DROP, ORDER_ITEMS_DROP };

if (require.main === module) {
  (async () => {
    await sequelize.authenticate();
    await dropLegacyOrderColumns();
    console.log('Legacy order columns dropped.');
    await sequelize.close();
  })().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
