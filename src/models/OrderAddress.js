const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');

/**
 * order_addresses — versioned snapshot of the shipping address for an order.
 *
 * v1 is created at placement. A modify-window ADDRESS_CHANGE adds a new version
 * and flips is_current. Each shipment records which version it actually went to,
 * so history is never lost when the address changes.
 */
const OrderAddress = sequelize.define('OrderAddress', {
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
  version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  is_current: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  line: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  city: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  state: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  pincode: {
    type: DataTypes.STRING,
    allowNull: false,
  },
}, {
  tableName: 'order_addresses',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(OrderAddress, { foreignKey: 'order_id', as: 'Addresses' });
OrderAddress.belongsTo(Order, { foreignKey: 'order_id' });

module.exports = OrderAddress;
