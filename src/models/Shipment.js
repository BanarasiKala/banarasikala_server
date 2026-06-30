const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');
const OrderAddress = require('./OrderAddress');

/**
 * shipments — one row per physical movement of goods.
 *
 * type = FORWARD for a dispatch (a redispatch after RTO is just a NEW forward
 * shipment on the same order); type = REVERSE for a return/RTO pickup.
 * forward_charge is the courier cost of THIS dispatch, so redispatch costs are
 * tracked independently instead of being overwritten on the order.
 */
const Shipment = sequelize.define('Shipment', {
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
  // Address version this shipment was sent to (forward shipments)
  address_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: OrderAddress, key: 'id' },
  },
  // FORWARD | REVERSE
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'FORWARD',
  },
  courier: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  awb_number: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // FORWARD: CREATED | DISPATCHED | IN_TRANSIT | DELIVERED | RTO
  // REVERSE: CREATED | PICKUP_SCHEDULED | PICKED_UP | RECEIVED
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'CREATED',
  },
  forward_charge: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  // Shiprocket linkage for this specific shipment
  shiprocket_order_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  selected_courier_data: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  dispatched_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  delivered_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  rto_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'shipments',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(Shipment, { foreignKey: 'order_id', as: 'Shipments' });
Shipment.belongsTo(Order, { foreignKey: 'order_id' });
Shipment.belongsTo(OrderAddress, { foreignKey: 'address_id' });

module.exports = Shipment;
