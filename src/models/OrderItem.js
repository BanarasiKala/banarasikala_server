const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const Order = require('./Order');
const Product = require('./Product');
const Color = require('./Color');

const OrderItem = sequelize.define('OrderItem', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  order_id: {
    type: DataTypes.INTEGER,
    references: { model: Order, key: 'id' }
  },
  product_id: {
    type: DataTypes.INTEGER,
    references: { model: Product, key: 'id' }
  },
  colorId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    field: 'color_id',
    references: { model: Color, key: 'id' }
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false
  },
  product_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  sku: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // ACTIVE | REMOVED | RETURNED. The per-action rollup counters
  // (cancelled/returned/exchanged/pending_action) are removed — those
  // quantities are now derived from shipment_items / return_items.
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'Active'
  },
  shipping_meta: {
    type: DataTypes.JSONB,
    allowNull: true
  }
}, {
  tableName: 'order_items',
  schema: 'vns_saree',
  timestamps: true,
  underscored: true
});

// Associations
Order.hasMany(OrderItem, { foreignKey: 'order_id' });
OrderItem.belongsTo(Order, { foreignKey: 'order_id' });
OrderItem.belongsTo(Product, { foreignKey: 'product_id' });
OrderItem.belongsTo(Color, { foreignKey: 'colorId' });

module.exports = OrderItem;
