const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');

/**
 * orders — V2 (normalized). The fat legacy columns have been removed and now
 * live in dedicated tables:
 *   money            → order_ledger / payment_transactions / refund_transactions
 *   shipping address → order_addresses (versioned; current_address_id points here)
 *   RTO / redispatch → shipments / rto_events
 *   COD block        → customers.is_cod_blocked + cod_block_events
 *   status timeline  → order_status_history
 *   courier / AWB    → shipments
 */
const Order = sequelize.define('Order', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  customer_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  order_number: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true
  },
  // Guest-contact snapshot (the shipping name/phone live on order_addresses)
  customer_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  customer_email: {
    type: DataTypes.STRING,
    allowNull: false
  },
  coupon_code: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Gift order: optional custom message (the flat charge is a GIFT_CHARGE ledger entry)
  is_gift: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  gift_message: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Derived pointer: PLACED, MODIFIED, DISPATCHED, DELIVERED, RTO,
  // RTO_AWAITING_PAYMENT, RETURN_REQUESTED, CLOSED…
  status: {
    type: DataTypes.STRING,
    defaultValue: 'Pending'
  },
  // PREPAID | COD
  payment_method: {
    type: DataTypes.STRING,
    defaultValue: 'Prepaid'
  },
  // Denormalized pointer; truth is the ledger + payment_transactions
  payment_status: {
    type: DataTypes.STRING,
    defaultValue: 'Paid'
  },
  // Live shipping-address version (→ order_addresses)
  current_address_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  delivered_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  cancelled_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'orders',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

module.exports = Order;
