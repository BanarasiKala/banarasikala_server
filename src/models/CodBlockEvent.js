const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Customer = require('./Customer');
const Order = require('./Order');

/**
 * cod_block_events — history of COD block/unblock actions on a customer.
 * The live flag stays on customers.is_cod_blocked; this table is the audit
 * trail of how it got there (typically a COD RTO).
 */
const CodBlockEvent = sequelize.define('CodBlockEvent', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  customer_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: Customer, key: 'id' },
  },
  // BLOCK | UNBLOCK
  action: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // The RTO order that caused the block (nullable for manual admin actions)
  triggered_by_order_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: Order, key: 'id' },
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'cod_block_events',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Customer.hasMany(CodBlockEvent, { foreignKey: 'customer_id', as: 'CodBlockEvents' });
CodBlockEvent.belongsTo(Customer, { foreignKey: 'customer_id' });
CodBlockEvent.belongsTo(Order, { foreignKey: 'triggered_by_order_id', as: 'TriggeredByOrder' });

module.exports = CodBlockEvent;
