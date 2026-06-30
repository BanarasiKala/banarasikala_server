const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');
const OrderLedger = require('./OrderLedger');

/**
 * payment_transactions — gateway record of money received from the customer.
 * Each row references the order_ledger PAYMENT/COD_COLLECTION credit it backs,
 * keeping the ledger as the truth and the gateway detail beside it.
 */
const PaymentTransaction = sequelize.define('PaymentTransaction', {
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
  // razorpay | phonepe | cod
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
  // Initiated | Paid | Failed
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'Initiated',
  },
  gateway_response: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
}, {
  tableName: 'payment_transactions',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(PaymentTransaction, { foreignKey: 'order_id', as: 'PaymentTransactions' });
PaymentTransaction.belongsTo(Order, { foreignKey: 'order_id' });
PaymentTransaction.belongsTo(OrderLedger, { foreignKey: 'ledger_entry_id' });

module.exports = PaymentTransaction;
