const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');
const Shipment = require('./Shipment');

/**
 * return_requests — a customer request to return item(s) after delivery.
 * Money is computed from order_ledger (REFUND credit minus reverse-shipping
 * debit), never stored as a single magic number here.
 */
const ReturnRequest = sequelize.define('ReturnRequest', {
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
  // PARTIAL | FULL
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'PARTIAL',
  },
  // REQUESTED | APPROVED | PICKED_UP | RECEIVED | REFUNDED | REJECTED
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'REQUESTED',
  },
  // The REVERSE shipment created when the pickup is scheduled (nullable until then)
  reverse_shipment_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: Shipment, key: 'id' },
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'return_requests',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(ReturnRequest, { foreignKey: 'order_id', as: 'ReturnRequests' });
ReturnRequest.belongsTo(Order, { foreignKey: 'order_id' });
ReturnRequest.belongsTo(Shipment, { foreignKey: 'reverse_shipment_id', as: 'ReverseShipment' });

module.exports = ReturnRequest;
