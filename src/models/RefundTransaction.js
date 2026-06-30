const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');
const OrderLedger = require('./OrderLedger');

/**
 * refund_transactions — gateway record of money returned to the customer.
 * References the order_ledger REFUND credit it settles. bank_details is used
 * for COD/NEFT refunds where there is no original gateway to reverse to.
 */
const RefundTransaction = sequelize.define('RefundTransaction', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  order_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: Order, key: 'id' },
  },
  ledger_entry_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: OrderLedger, key: 'id' },
  },
  // original_gateway | wallet | bank_transfer
  gateway: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  gateway_ref: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  // Pending | Processing | Completed | Failed
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'Pending',
  },
  // { account_holder_name, account_number, ifsc_code, bank_name, branch_name }
  bank_details: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  gateway_response: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  processed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'refund_transactions',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(RefundTransaction, { foreignKey: 'order_id', as: 'RefundTransactions' });
RefundTransaction.belongsTo(Order, { foreignKey: 'order_id' });
RefundTransaction.belongsTo(OrderLedger, { foreignKey: 'ledger_entry_id' });

module.exports = RefundTransaction;
