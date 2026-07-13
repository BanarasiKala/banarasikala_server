const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Customer = require('./Customer');

/**
 * One chat session with the AI assistant.
 *
 * Persisted for three reasons, in order of value:
 *   1. PRODUCT SIGNAL — what customers ask for, and whether we had it. "green tissue silk
 *      under 4000" asked fifty times with zero search hits is a buying decision sitting in
 *      the logs. This cannot be reconstructed after the fact, which is why we save from day one.
 *   2. CONVERSATION STATE — the Messages API is stateless; the history has to live somewhere.
 *      Keeping it in Postgres (rather than an in-process Map) means it survives a restart and
 *      works with more than one Node instance.
 *   3. COST + DEBUGGING — token usage per conversation, and the transcript behind a bad answer.
 *
 * `customer_id` is null for anonymous visitors, which is where most of the product signal
 * lives and which carries no PII.
 */
const ChatConversation = sequelize.define('ChatConversation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  // Null = anonymous visitor. Nulled out (not deleted) when a transcript is anonymised.
  customer_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: Customer, key: 'id' },
  },
  // Running token totals — this is how you notice a runaway loop or a spiking bill.
  input_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  output_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  cache_read_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  message_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  // Set when the assistant handed the customer off to a human.
  escalated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  last_message_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'chat_conversations',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Customer.hasMany(ChatConversation, { foreignKey: 'customer_id' });
ChatConversation.belongsTo(Customer, { foreignKey: 'customer_id' });

module.exports = ChatConversation;
