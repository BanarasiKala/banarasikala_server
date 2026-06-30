const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');

/**
 * order_ledger — append-only source of truth for all money on an order.
 *
 * Every monetary event is a row with a POSITIVE amount and a direction:
 *   DEBIT  = customer owes us (product, shipping, RTO, redispatch, COD fee)
 *   CREDIT = we owe / paid customer (payment received, coupon, wallet, refund)
 *
 * Outstanding balance = Σ DEBIT − Σ CREDIT. Nothing is ever recomputed in place;
 * modifications, RTO and returns only APPEND entries.
 */
const OrderLedger = sequelize.define('OrderLedger', {
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
  // PRODUCT_CHARGE | SHIPPING_CHARGE | RTO_CHARGE | REDISPATCH_CHARGE | COD_FEE
  // | PLATFORM_FEE | PAYMENT_FEE | GIFT_CHARGE | COUPON_DISCOUNT | WALLET_CREDIT
  // | PAYMENT | COD_COLLECTION | REFUND
  entry_type: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Always positive; direction carries the sign
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  // DEBIT | CREDIT
  direction: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // MODIFICATION | SHIPMENT | RTO_EVENT | RETURN | PAYMENT | ORDER
  reference_type: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  reference_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  note: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'order_ledger',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(OrderLedger, { foreignKey: 'order_id', as: 'Ledger' });
OrderLedger.belongsTo(Order, { foreignKey: 'order_id' });

module.exports = OrderLedger;
