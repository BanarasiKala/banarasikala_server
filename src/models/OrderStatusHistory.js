const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');

/**
 * order_status_history — one row per status transition of an order.
 * Replaces the JSONB status_history column on orders with a queryable table.
 */
const OrderStatusHistory = sequelize.define('OrderStatusHistory', {
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
  from_status: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  to_status: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // CUSTOMER | ADMIN | SYSTEM
  actor: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'SYSTEM',
  },
}, {
  tableName: 'order_status_history',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(OrderStatusHistory, { foreignKey: 'order_id', as: 'StatusHistory' });
OrderStatusHistory.belongsTo(Order, { foreignKey: 'order_id' });

module.exports = OrderStatusHistory;
