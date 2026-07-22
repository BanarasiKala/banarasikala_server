const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const SupportConversation = require('./SupportConversation');
const SupportTopic = require('./SupportTopic');

/**
 * support_messages — every entry in a customer's support chat.
 *
 * Two kinds of thing share this table, because both are bubbles in one scroll ordered by one
 * clock, and both have to arrive over the same live stream:
 *
 *   text    what someone said — `body` and/or `attachments`
 *   status  a system line ("Marked resolved by support"). sender is 'system'
 *
 * There used to be a third, `order`, which rendered the order card as a message in the
 * stream. It was the only thing saying which order a conversation had moved onto, and being
 * positional it could only ever be a hint: a photo sent while two orders were live was filed
 * under whichever card came last, and nothing in the row said otherwise. The order now lives
 * on the TOPIC (see SupportTopic) and every message names its topic outright, so the
 * association is a foreign key rather than a reading of the scroll order.
 *
 * `conversation_id` is kept alongside `topic_id` even though the topic already implies it.
 * Every read that matters — the customer's whole history, the admin's unread count — filters
 * by conversation, and making those go through a join to reach the column they filter on
 * would be a join per read for a value that cannot drift: a topic never changes hands.
 */
const SupportMessage = sequelize.define('SupportMessage', {
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
  // Which strand this belongs to — the order it is about, or the general strand.
  topic_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: SupportTopic, key: 'id' },
  },
  // customer | admin | system
  sender: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Display name snapshot, so the thread still reads correctly if the account changes.
  sender_name: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // text | status
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'text',
  },
  // Nullable: an image-only message has no text.
  body: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // Photos sent with this message — [{ url, public_id }]. Either side can attach.
  attachments: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  /**
   * When the RECIPIENT's client actually received this — the middle tick state.
   *
   * Distinct from "read" (a per-side watermark on the conversation): delivered means it
   * reached their browser, read means they looked. Persisted rather than derived because the
   * sender must still see ✓✓ after a reload; an in-memory notion of delivery would reset to
   * a single ✓ on every refresh.
   */
  delivered_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'support_messages',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

SupportConversation.hasMany(SupportMessage, { foreignKey: 'conversation_id', as: 'Messages' });
SupportMessage.belongsTo(SupportConversation, { foreignKey: 'conversation_id' });

SupportTopic.hasMany(SupportMessage, { foreignKey: 'topic_id', as: 'Messages' });
SupportMessage.belongsTo(SupportTopic, { foreignKey: 'topic_id', as: 'Topic' });

module.exports = SupportMessage;
