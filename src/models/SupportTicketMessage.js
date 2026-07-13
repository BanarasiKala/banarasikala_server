const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const SupportTicket = require('./SupportTicket');

/**
 * support_ticket_messages — one row per message in a ticket's conversation.
 *
 * The ticket itself carries the customer's ORIGINAL message (support_tickets.message); this
 * table is the follow-up thread on top of it, so a customer and an admin can go back and
 * forth until the admin closes the ticket out.
 */
const SupportTicketMessage = sequelize.define('SupportTicketMessage', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  ticket_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: SupportTicket, key: 'id' },
  },
  // customer | admin — who wrote it. Drives which side of the thread it renders on.
  sender: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Display name snapshot, so the thread still reads correctly if the account changes.
  sender_name: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
}, {
  tableName: 'support_ticket_messages',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

SupportTicket.hasMany(SupportTicketMessage, { foreignKey: 'ticket_id', as: 'Messages' });
SupportTicketMessage.belongsTo(SupportTicket, { foreignKey: 'ticket_id' });

module.exports = SupportTicketMessage;
