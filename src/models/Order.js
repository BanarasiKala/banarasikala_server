const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');

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
  customer_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  customer_email: {
    type: DataTypes.STRING,
    allowNull: false
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  city: {
    type: DataTypes.STRING,
    allowNull: false
  },
  pincode: {
    type: DataTypes.STRING,
    allowNull: false
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false
  },
  subtotal_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  shipping_charge: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  shipping_discount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  payment_fee: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  platform_fee: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  cod_fee: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  payment_discount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  total_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false
  },
  coupon_code: {
    type: DataTypes.STRING,
    allowNull: true
  },
  discount_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  wallet_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  payable_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  // Gift order: optional custom message + a flat extra charge.
  is_gift: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  gift_message: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  gift_charge: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'Pending'
  },
  delivered_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  state: {
    type: DataTypes.STRING,
    defaultValue: 'Uttar Pradesh'
  },
  payment_method: {
    type: DataTypes.STRING,
    defaultValue: 'Prepaid'
  },
  payment_status: {
    type: DataTypes.STRING,
    defaultValue: 'Paid'
  },
  shiprocket_order_id: {
    type: DataTypes.STRING,
    allowNull: true
  },
  shiprocket_awb: {
    type: DataTypes.STRING,
    allowNull: true
  },
  selected_courier_data: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  is_rto: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  rto_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  is_redispatched: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  redispatch_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  original_order_id: {
    type: DataTypes.BIGINT,
    allowNull: true
  },
  redispatch_payment_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: 0
  },
  customer_cod_blocked: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  cod_blocked_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  cod_block_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  cancelled_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  is_modified: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  modified_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Full status timeline — each entry: { status, timestamp, actor, note }
  // actor is 'customer' | 'admin' | 'system'
  status_history: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: []
  }
}, {
  tableName: 'orders',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

module.exports = Order;
