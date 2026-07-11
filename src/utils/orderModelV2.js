/**
 * orderModelV2.js
 *
 * Phase 1 of the normalized order model. Creates the new tables and the
 * orders.current_address_id pointer. Additive and idempotent — nothing reads
 * from these tables yet, so this is safe to run on every boot.
 *
 * The new tables are created via Model.sync() (CREATE TABLE IF NOT EXISTS) in
 * foreign-key dependency order. We intentionally do NOT use sync({ alter: true })
 * anywhere — only create-if-missing.
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');

// Models — required in dependency order so associations are registered.
const OrderAddress = require('../models/OrderAddress');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const Shipment = require('../models/Shipment');
const ShipmentItem = require('../models/ShipmentItem');
const RtoEvent = require('../models/RtoEvent');
const ReturnRequest = require('../models/ReturnRequest');
const ReturnItem = require('../models/ReturnItem');
const OrderLedger = require('../models/OrderLedger');
const PaymentTransaction = require('../models/PaymentTransaction');
const RefundTransaction = require('../models/RefundTransaction');
const CodBlockEvent = require('../models/CodBlockEvent');

// ── Enum constants (single source of truth for the new model) ──────────────────

const ORDER_STATUS = Object.freeze({
  PLACED: 'PLACED',
  DISPATCHED: 'DISPATCHED',
  DELIVERED: 'DELIVERED',
  RTO: 'RTO',
  RTO_AWAITING_PAYMENT: 'RTO_AWAITING_PAYMENT',
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  CLOSED: 'CLOSED',
});

const ACTOR = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN',
  SYSTEM: 'SYSTEM',
});

const SHIPMENT_TYPE = Object.freeze({ FORWARD: 'FORWARD', REVERSE: 'REVERSE' });

const SHIPMENT_STATUS = Object.freeze({
  CREATED: 'CREATED',
  DISPATCHED: 'DISPATCHED',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  RTO: 'RTO',
  PICKUP_SCHEDULED: 'PICKUP_SCHEDULED',
  PICKED_UP: 'PICKED_UP',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
});

const RTO_RESOLUTION = Object.freeze({
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  PAID: 'PAID',
  REDISPATCHED: 'REDISPATCHED',
  ABANDONED: 'ABANDONED',
  PRODUCT_RETURNED_COD_BLOCKED: 'PRODUCT_RETURNED_COD_BLOCKED',
});

// How long after a parcel is returned to the seller (the rto_events row is raised on
// the "RTO Delivered" scan) the customer may still pay to have it re-dispatched.
// Once the window closes the order can only be refunded.
const RTO_REDISPATCH_WINDOW_DAYS = 7;
const RTO_REDISPATCH_WINDOW_MS = RTO_REDISPATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** ms timestamp of the rto_events row (models are `underscored`: attr is createdAt). */
const rtoEventTime = (rtoEvent) =>
  new Date(rtoEvent?.created_at || rtoEvent?.createdAt || 0).getTime();

/** Is a re-dispatch still offerable for this RTO event? (time window only) */
const isWithinRedispatchWindow = (rtoEvent, now = Date.now()) => {
  const raisedAt = rtoEventTime(rtoEvent);
  return raisedAt > 0 && (now - raisedAt) <= RTO_REDISPATCH_WINDOW_MS;
};

const RETURN_TYPE = Object.freeze({ PARTIAL: 'PARTIAL', FULL: 'FULL' });

const RETURN_STATUS = Object.freeze({
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  PICKED_UP: 'PICKED_UP',
  RECEIVED: 'RECEIVED',
  REFUNDED: 'REFUNDED',
  REJECTED: 'REJECTED',
});

const LEDGER_ENTRY_TYPE = Object.freeze({
  PRODUCT_CHARGE: 'PRODUCT_CHARGE',
  SHIPPING_CHARGE: 'SHIPPING_CHARGE',
  RTO_CHARGE: 'RTO_CHARGE',
  REDISPATCH_CHARGE: 'REDISPATCH_CHARGE',
  COD_FEE: 'COD_FEE',
  PLATFORM_FEE: 'PLATFORM_FEE',
  PAYMENT_FEE: 'PAYMENT_FEE',
  GIFT_CHARGE: 'GIFT_CHARGE',
  COUPON_DISCOUNT: 'COUPON_DISCOUNT',
  PREPAID_DISCOUNT: 'PREPAID_DISCOUNT',
  WALLET_CREDIT: 'WALLET_CREDIT',
  PAYMENT: 'PAYMENT',
  COD_COLLECTION: 'COD_COLLECTION',
  REFUND: 'REFUND',
});

const LEDGER_DIRECTION = Object.freeze({ DEBIT: 'DEBIT', CREDIT: 'CREDIT' });

const LEDGER_REFERENCE_TYPE = Object.freeze({
  ORDER: 'ORDER',
  SHIPMENT: 'SHIPMENT',
  RTO_EVENT: 'RTO_EVENT',
  RETURN: 'RETURN',
  PAYMENT: 'PAYMENT',
});

const COD_BLOCK_ACTION = Object.freeze({ BLOCK: 'BLOCK', UNBLOCK: 'UNBLOCK' });

// ── Auto-migration ─────────────────────────────────────────────────────────────

// Create tables parents-first so foreign keys resolve.
const SYNC_ORDER = [
  OrderAddress,
  OrderStatusHistory,
  Shipment,
  ShipmentItem,
  RtoEvent,
  ReturnRequest,
  ReturnItem,
  OrderLedger,
  PaymentTransaction,
  RefundTransaction,
  CodBlockEvent,
];

let modelV2Ready = false;

const ensureOrderModelV2Tables = async () => {
  if (modelV2Ready) return;

  // 1. Create the new tables if they don't exist (no alter).
  for (const model of SYNC_ORDER) {
    await model.sync();
  }

  // 2. Add the orders.current_address_id pointer (additive, idempotent).
  const qi = sequelize.getQueryInterface();
  const ordersTable = { tableName: 'orders', schema: config.dbSchema };
  const ordersColumns = await qi.describeTable(ordersTable);
  if (!ordersColumns.current_address_id) {
    await qi.addColumn(ordersTable, 'current_address_id', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
  }

  // 3. Order modification was removed (cancellation is whole-order only) —
  // drop its table if a previous deploy created it. Idempotent.
  await sequelize.query(`DROP TABLE IF EXISTS "${config.dbSchema}"."order_modifications"`);

  // 3b. Additive: shipments.rto_event_id — links a redispatch's new forward
  // shipment back to the RTO it resolved. And shipments.exchange_action_id —
  // links an exchange REPLACEMENT's new forward shipment back to the exchange
  // request it fulfils (and makes a double-ship detectable). Both idempotent.
  const shipmentsTable = { tableName: 'shipments', schema: config.dbSchema };
  try {
    const shipmentsColumns = await qi.describeTable(shipmentsTable);
    if (!shipmentsColumns.rto_event_id) {
      await qi.addColumn(shipmentsTable, 'rto_event_id', { type: DataTypes.INTEGER, allowNull: true });
    }
    if (!shipmentsColumns.exchange_action_id) {
      await qi.addColumn(shipmentsTable, 'exchange_action_id', { type: DataTypes.INTEGER, allowNull: true });
    }
  } catch {
    // Table missing entirely (fresh DB) — the model.sync above already created
    // it with the column.
  }

  // 4. Additive: order_refunds.breakdown (JSONB) — the persisted refund
  // breakage shown to the customer. Global sync is off, so added here.
  const refundsTable = { tableName: 'order_refunds', schema: config.dbSchema };
  try {
    const refundsColumns = await qi.describeTable(refundsTable);
    if (!refundsColumns.breakdown) {
      await qi.addColumn(refundsTable, 'breakdown', { type: DataTypes.JSONB, allowNull: true });
    }
  } catch {
    // Table missing entirely (fresh database) — create it from the model,
    // which already includes the breakdown column.
    await require('../models/OrderRefund').sync();
  }

  modelV2Ready = true;
};

module.exports = {
  ensureOrderModelV2Tables,
  ORDER_STATUS,
  ACTOR,
  SHIPMENT_TYPE,
  SHIPMENT_STATUS,
  RTO_RESOLUTION,
  RTO_REDISPATCH_WINDOW_DAYS,
  RTO_REDISPATCH_WINDOW_MS,
  rtoEventTime,
  isWithinRedispatchWindow,
  RETURN_TYPE,
  RETURN_STATUS,
  LEDGER_ENTRY_TYPE,
  LEDGER_DIRECTION,
  LEDGER_REFERENCE_TYPE,
  COD_BLOCK_ACTION,
};
