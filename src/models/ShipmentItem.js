const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Shipment = require('./Shipment');
const OrderItem = require('./OrderItem');

/**
 * shipment_items — which order_items, and how many units, moved in a shipment.
 * Σ quantity across FORWARD shipments = units actually dispatched for an item.
 */
const ShipmentItem = sequelize.define('ShipmentItem', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  shipment_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: Shipment, key: 'id' },
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
}, {
  tableName: 'shipment_items',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Shipment.hasMany(ShipmentItem, { foreignKey: 'shipment_id', as: 'Items' });
ShipmentItem.belongsTo(Shipment, { foreignKey: 'shipment_id' });
ShipmentItem.belongsTo(OrderItem, { foreignKey: 'order_item_id' });

module.exports = ShipmentItem;
