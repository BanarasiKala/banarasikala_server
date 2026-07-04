/**
 * orderTransactions.js
 *
 * Auto-migration + helper constants for the payments and order_refunds tables.
 * Called at request time (idempotent — runs only once per server boot).
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');

// ── Column definitions ────────────────────────────────────────────────────────

const PAYMENT_COLUMNS = {
  id:                  { type: DataTypes.INTEGER,       primaryKey: true,  autoIncrement: true },
  order_id:            { type: DataTypes.INTEGER,       allowNull: false },
  payment_method:      { type: DataTypes.STRING,        allowNull: false,  defaultValue: 'COD' },
  payment_gateway:     { type: DataTypes.STRING,        allowNull: true },
  gateway_order_id:    { type: DataTypes.STRING,        allowNull: true },
  gateway_payment_id:  { type: DataTypes.STRING,        allowNull: true },
  gateway_signature:   { type: DataTypes.TEXT,          allowNull: true },
  amount:              { type: DataTypes.DECIMAL(10, 2), allowNull: false,  defaultValue: 0 },
  amount_paise:        { type: DataTypes.INTEGER,       allowNull: true },
  currency:            { type: DataTypes.STRING,        allowNull: false,  defaultValue: 'INR' },
  status:              { type: DataTypes.STRING,        allowNull: false,  defaultValue: 'Initiated' },
  failure_reason:      { type: DataTypes.TEXT,          allowNull: true },
  gateway_response:    { type: DataTypes.JSONB,         allowNull: true },
  verified_at:         { type: DataTypes.DATE,          allowNull: true },
  created_at:          { type: DataTypes.DATE,          allowNull: false,  defaultValue: DataTypes.NOW },
  updated_at:          { type: DataTypes.DATE,          allowNull: false,  defaultValue: DataTypes.NOW },
};

const ORDER_REFUND_COLUMNS = {
  id:                    { type: DataTypes.INTEGER,       primaryKey: true,  autoIncrement: true },
  order_id:              { type: DataTypes.INTEGER,       allowNull: false },
  order_item_action_id:  { type: DataTypes.INTEGER,       allowNull: true },
  refund_type:           { type: DataTypes.STRING,        allowNull: false },
  amount:                { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  status:                { type: DataTypes.STRING,        allowNull: false,  defaultValue: 'Pending' },
  payment_method:        { type: DataTypes.STRING,        allowNull: true },
  gateway_refund_id:     { type: DataTypes.STRING,        allowNull: true },
  bank_details:          { type: DataTypes.JSONB,         allowNull: true },
  note:                  { type: DataTypes.TEXT,          allowNull: true },
  breakdown:             { type: DataTypes.JSONB,         allowNull: true },
  processed_at:          { type: DataTypes.DATE,          allowNull: true },
  processed_by:          { type: DataTypes.INTEGER,       allowNull: true },
  created_at:            { type: DataTypes.DATE,          allowNull: false,  defaultValue: DataTypes.NOW },
  updated_at:            { type: DataTypes.DATE,          allowNull: false,  defaultValue: DataTypes.NOW },
};

// ── REFUND_TYPE constants ─────────────────────────────────────────────────────

const REFUND_TYPE = Object.freeze({
  FULL_CANCEL:     'full_cancel',
  PARTIAL_CANCEL:  'partial_cancel',
  RETURN:          'return',
  EXCHANGE:        'exchange',
  RTO:             'rto',
});

const REFUND_STATUS = Object.freeze({
  PENDING:      'Pending',
  PROCESSING:   'Processing',
  COMPLETED:    'Completed',
  FAILED:       'Failed',
  NOT_REQUIRED: 'Not Required',
});

const REFUND_PAYMENT_METHOD = Object.freeze({
  ORIGINAL_GATEWAY: 'original_gateway',
  WALLET:           'wallet',
  BANK_TRANSFER:    'bank_transfer',
  NOT_REQUIRED:     'not_required',
});

// ── Auto-migration ────────────────────────────────────────────────────────────

let transactionTablesReady = false;

const ensureOrderTransactionTables = async () => {
  if (transactionTablesReady) return;

  const qi = sequelize.getQueryInterface();

  const ensureTable = async (tableName, columns) => {
    const tableRef = { tableName, schema: config.dbSchema };
    try {
      await qi.describeTable(tableRef);
    } catch {
      await qi.createTable(tableRef, columns);
    }

    const existing = await qi.describeTable(tableRef);
    for (const [col, def] of Object.entries(columns)) {
      if (!existing[col]) {
        await qi.addColumn(tableRef, col, def);
      }
    }
  };

  await ensureTable('payments',      PAYMENT_COLUMNS);
  await ensureTable('order_refunds', ORDER_REFUND_COLUMNS);

  transactionTablesReady = true;
};

module.exports = {
  PAYMENT_COLUMNS,
  ORDER_REFUND_COLUMNS,
  REFUND_TYPE,
  REFUND_STATUS,
  REFUND_PAYMENT_METHOD,
  ensureOrderTransactionTables,
};
