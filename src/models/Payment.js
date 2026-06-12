const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');

/**
 * payments — one row per payment attempt for an order.
 * An order can have multiple rows if the first attempt failed (status = Failed)
 * and the customer retried. Only one row should have status = Paid at a time.
 *
 * For COD orders: one row is created at order placement with status = Pending,
 * then updated to Paid when admin confirms collection.
 */
const Payment = sequelize.define('Payment', {
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
  // COD | Prepaid
  payment_method: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'COD',
  },
  // razorpay | phonepe | null (for COD)
  payment_gateway: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  gateway_order_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  gateway_payment_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  gateway_signature: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // Rupees (not paise)
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  // Paise (for gateway amount verification)
  amount_paise: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  currency: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'INR',
  },
  // Initiated | Paid | Failed | Refunded | Partially Refunded
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'Initiated',
  },
  failure_reason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // Full gateway webhook/callback JSON for audit
  gateway_response: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  verified_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'payments',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(Payment, { foreignKey: 'order_id', as: 'Payments' });
Payment.belongsTo(Order, { foreignKey: 'order_id' });

module.exports = Payment;
