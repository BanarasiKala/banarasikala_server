const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');

/**
 * support_tickets — a help request raised by a customer against one of their
 * orders ("Need help with this order?" on the My Orders card).
 *
 * Distinct from contact_messages, which is the public, order-less contact form:
 * a ticket is always tied to an order and to the logged-in customer who owns it,
 * so support can act on it without asking which order the customer means.
 */
const SupportTicket = sequelize.define('SupportTicket', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  // Human-readable reference quoted back to the customer. Assigned from the row
  // id right after insert, so it is unique without a separate counter.
  ticket_number: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
  },
  order_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: Order, key: 'id' },
  },
  customer_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  // Contact snapshot, so support can reach the customer even if the account changes.
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  category: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  // Open | In Progress | Resolved | Closed
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'Open',
  },
  admin_response: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  resolved_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Read receipts, stored as a per-side watermark rather than a flag per message.
  //
  // "Unread for me" is then `messages from the other side WHERE created_at > my watermark`
  // — one column write on open instead of N row updates, and it yields the unread badge
  // for free. A per-message read flag would cost a write per message and answer no
  // question this one doesn't.
  customer_read_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  admin_read_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'support_tickets',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(SupportTicket, { foreignKey: 'order_id', as: 'SupportTickets' });
SupportTicket.belongsTo(Order, { foreignKey: 'order_id' });

module.exports = SupportTicket;
