const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');
const OrderItemAction = require('./OrderItemAction');

/**
 * order_refunds — one row per refund event.
 *
 * Created when:
 *   - A prepaid order is fully cancelled within 24 h  → refund_type = full_cancel
 *   - Some items are cancelled within 24 h (prepaid)  → refund_type = partial_cancel
 *   - Customer returns item(s) after delivery         → refund_type = return
 *   - RTO: shipment returned to seller                → refund_type = rto
 *   - Exchange (no monetary refund)                   → amount = 0, refund_type = exchange
 *
 * COD orders that have no monetary refund still get a row
 * with status = Not Required so admin has a complete audit trail.
 */
const OrderRefund = sequelize.define('OrderRefund', {
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
  // Null for full-order cancellations; set for item-level actions
  order_item_action_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: OrderItemAction, key: 'id' },
  },
  // full_cancel | partial_cancel | return | exchange | rto
  refund_type: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Amount to refund in INR. 0 for COD orders or exchange.
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  // Pending | Processing | Completed | Failed | Not Required
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'Pending',
  },
  // original_gateway | wallet | bank_transfer | not_required
  payment_method: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Razorpay/PhonePe refund ID for tracking
  gateway_refund_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Bank details for COD refunds via NEFT
  // { account_holder_name, account_number, ifsc_code, bank_name, branch_name }
  bank_details: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  note: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // Structured money breakage saved at request time so it can always be
  // replayed to the customer: { returned_value, coupon: { original_code,
  // original_discount, applied_code, new_discount, adjustment },
  // return_shipping_charge, refund_amount, items: [...] }
  breakdown: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  processed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Admin user ID who marked this refund as processed
  processed_by: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  tableName: 'order_refunds',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(OrderRefund, { foreignKey: 'order_id', as: 'Refunds' });
OrderRefund.belongsTo(Order, { foreignKey: 'order_id' });
OrderRefund.belongsTo(OrderItemAction, { foreignKey: 'order_item_action_id' });

module.exports = OrderRefund;
