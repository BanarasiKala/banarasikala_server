const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');
const Shipment = require('./Shipment');

/**
 * rto_events — raised when a FORWARD shipment is returned to origin (RTO).
 *
 * Prepaid: forward_charge_to_recover + rto_charge are posted to order_ledger as
 *   DEBIT; resolution walks AWAITING_PAYMENT → PAID → REDISPATCHED (or ABANDONED).
 * COD: no money to recover; resolution = PRODUCT_RETURNED_COD_BLOCKED (terminal),
 *   and the customer is COD-blocked (see cod_block_events).
 */
const RtoEvent = sequelize.define('RtoEvent', {
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
  order_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: Order, key: 'id' },
  },
  // PREPAID | COD — copied for branching
  payment_method: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  forward_charge_to_recover: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  rto_charge: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  // PREPAID: AWAITING_PAYMENT | PAID | REDISPATCHED | ABANDONED
  // COD:     PRODUCT_RETURNED_COD_BLOCKED
  resolution: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'AWAITING_PAYMENT',
  },
}, {
  tableName: 'rto_events',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(RtoEvent, { foreignKey: 'order_id', as: 'RtoEvents' });
RtoEvent.belongsTo(Order, { foreignKey: 'order_id' });
Shipment.hasMany(RtoEvent, { foreignKey: 'shipment_id' });
RtoEvent.belongsTo(Shipment, { foreignKey: 'shipment_id' });

module.exports = RtoEvent;
