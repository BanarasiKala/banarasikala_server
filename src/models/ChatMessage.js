const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const ChatConversation = require('./ChatConversation');

/**
 * One turn in a conversation.
 *
 * ⚠️ `tool_calls` stores the tool NAME and ARGUMENTS — never the tool RESULT.
 *
 * That distinction is the whole privacy design. A `get_order_details` result contains the
 * customer's address and phone number. Writing that payload in here would duplicate PII out
 * of `orders` into a second, unowned store with its own retention problem — for no benefit,
 * because the order row is still right there to re-read.
 *
 * So we record what was ASKED (`{name: "get_order_details", input: {order_number: "BKS..."}}`),
 * not what came back. The assistant's own reply is stored verbatim; a sentence mentioning a
 * delivery date is prose, not a data store.
 */
const ChatMessage = sequelize.define('ChatMessage', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  conversation_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: ChatConversation, key: 'id' },
  },
  // 'user' | 'assistant'
  role: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // [{ id, name, input }] — arguments only, for EVERY tool. See the header.
  tool_calls: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  // [{ tool_use_id, content }] — results, for PUBLIC (catalogue) tools ONLY.
  //
  // Catalogue results are public data with no PII, and they must be replayed or the model
  // loses the thread: "tell me about the second one" is unanswerable if the sarees it just
  // showed have vanished from its context.
  //
  // Account-tool results (orders, cart) are NEVER stored here. On replay their tool_use block
  // is dropped too — a tool_use with no matching tool_result is an API error — so the model
  // keeps only what it SAID about the order, never the address and phone it saw.
  tool_results: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
}, {
  tableName: 'chat_messages',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
  indexes: [{ fields: ['conversation_id'] }],
});

ChatConversation.hasMany(ChatMessage, { foreignKey: 'conversation_id', as: 'Messages' });
ChatMessage.belongsTo(ChatConversation, { foreignKey: 'conversation_id' });

module.exports = ChatMessage;
