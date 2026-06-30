const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const ReturnRequest = require('./ReturnRequest');
const OrderItem = require('./OrderItem');

/**
 * return_items — line items of a return request.
 * item_value is the GROSS returned value (quantity × unit_price snapshot);
 * the net refund is derived in order_ledger after reverse-shipping deductions.
 */
const ReturnItem = sequelize.define('ReturnItem', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  return_request_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: ReturnRequest, key: 'id' },
  },
  order_item_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: OrderItem, key: 'id' },
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  item_value: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
}, {
  tableName: 'return_items',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

ReturnRequest.hasMany(ReturnItem, { foreignKey: 'return_request_id', as: 'Items' });
ReturnItem.belongsTo(ReturnRequest, { foreignKey: 'return_request_id' });
ReturnItem.belongsTo(OrderItem, { foreignKey: 'order_item_id' });

module.exports = ReturnItem;
