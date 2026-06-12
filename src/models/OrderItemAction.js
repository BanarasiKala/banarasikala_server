const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const Order = require('./Order');
const OrderItem = require('./OrderItem');
const Product = require('./Product');

const OrderItemAction = sequelize.define('OrderItemAction', {
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
  order_item_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: OrderItem, key: 'id' },
  },
  product_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: Product, key: 'id' },
  },
  action_type: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'Requested',
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  item_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  forward_shipping_deduction: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  reverse_shipping_deduction: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  estimated_refund_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  meta: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  requested_by: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  reviewed_by: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  reviewed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Set when action reaches a terminal state (Completed / Rejected / Cancelled)
  completed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Shiprocket reverse-shipment IDs — stored here (not on orders) because
  // each return/exchange action has its own independent reverse shipment.
  shiprocket_return_order_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  shiprocket_return_awb: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  tableName: 'order_item_actions',
  schema: 'vns_saree',
  timestamps: true,
  underscored: true,
});

Order.hasMany(OrderItemAction, { foreignKey: 'order_id' });
OrderItemAction.belongsTo(Order, { foreignKey: 'order_id' });
OrderItem.hasMany(OrderItemAction, { foreignKey: 'order_item_id' });
OrderItemAction.belongsTo(OrderItem, { foreignKey: 'order_item_id' });
OrderItemAction.belongsTo(Product, { foreignKey: 'product_id' });

module.exports = OrderItemAction;
