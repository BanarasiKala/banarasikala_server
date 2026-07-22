const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const SupportConversation = require('./SupportConversation');

/**
 * support_topics — one strand of a customer's chat, about one order.
 *
 * The conversation is still the relationship (one row per customer, for life). A topic is a
 * strand INSIDE it, and it exists because "which order is this about" turned out to be two
 * different questions wearing one hat:
 *
 *   - what should this message be filed under?   → needs to be on every message
 *   - is this particular problem dealt with?     → needs a status of its own
 *
 * Marking an order card in the message stream answered neither. A photo sent while two orders
 * were live got filed under whichever card happened to be most recent, and a single
 * conversation-level status could not say "the torn saree is resolved but the missing one is
 * not". A topic answers both: messages point at it, and it carries the status.
 *
 * ── The general topic ───────────────────────────────────────────────────────────────────
 * `order_id` is nullable, and the row with NULL is where messages that are about no order at
 * all go — someone opening /support to ask whether a fabric runs small. Without it those
 * messages would have to be forced under an unrelated order, or floated outside the model.
 *
 * ── Why the snapshot lives here and not on the message ──────────────────────────────────
 * The order card is rendered once per strand, not once per message, so the snapshot belongs
 * to the strand. It is denormalised for the same reason it always was: the card has to show
 * the saree as it was when the customer complained, and joining live order data would
 * silently rewrite history when a line is cancelled or an item renamed.
 */
const SupportTopic = sequelize.define('SupportTopic', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  conversation_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: SupportConversation, key: 'id' },
  },
  // Null = the general strand: questions that are not about a specific order.
  order_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  // { number, productName, productImage, statusLabel, extraItems } — null on the general
  // strand, which has no order to show.
  order_snapshot: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  // Open | In Progress | Resolved | Closed — this strand's own state. Support can settle the
  // damaged saree without implying anything about the parcel that has not arrived.
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'Open',
  },
  /**
   * Last message time in this strand, denormalised.
   *
   * Both queues sort by it — the admin's list of strands needing action, and the customer's
   * own list of chats — and the messages live in another table. Ordering by a subquery per
   * row is the query that gets slow first. Read receipts deliberately do not touch it:
   * opening a strand must not reorder the queue under the person reading it.
   */
  last_message_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'support_topics',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
  indexes: [
    // One strand per order per customer. Postgres does not treat NULLs as equal, so this
    // constrains the real orders only; the general strand is kept unique by the partial
    // index added in SupportRoutes, which this cannot express.
    { unique: true, fields: ['conversation_id', 'order_id'] },
  ],
});

SupportConversation.hasMany(SupportTopic, { foreignKey: 'conversation_id', as: 'Topics' });
SupportTopic.belongsTo(SupportConversation, { foreignKey: 'conversation_id' });

module.exports = SupportTopic;
