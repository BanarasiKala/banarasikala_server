const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');

/**
 * support_conversations — ONE ongoing chat per customer, for life.
 *
 * The unit here is the RELATIONSHIP, not a unit of work: this row is the customer, and it
 * holds only what is true of them rather than of any one problem — who they are, and how far
 * each side has read.
 *
 * The work happens one level down, in support_topics: a strand per order, each carrying its
 * own status. That split is what lets support settle the damaged saree while the parcel that
 * never arrived stays open, without fragmenting the customer into three inbox rows.
 *
 * Deliberately NOT here: a status. It used to be, back when a conversation was one flat
 * stream, and it could only ever describe whichever problem was most recent — which is
 * precisely the question the customer is least likely to be asking about.
 */
const SupportConversation = sequelize.define('SupportConversation', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  // Unique: the "one chat per customer" rule is enforced by the database, not by whichever
  // code path happens to create it. Two tabs opening support at the same moment is a real
  // race, and losing it should be a constraint violation we can retry, not a second thread.
  customer_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
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
  /**
   * Last message time, denormalised.
   *
   * The admin inbox sorts by "who spoke most recently", and the messages live in another
   * table — ordering by a subquery per row is exactly the query that gets slow first as the
   * inbox grows. Read receipts deliberately do NOT touch this: merely opening a thread must
   * not reorder the queue under the person reading it.
   */
  last_message_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  /**
   * Read watermarks, one per side.
   *
   * "Unread for me" is `messages from the other side WHERE created_at > my watermark` — one
   * column write on open instead of one per message, and it answers the unread badge for
   * free. It is also what turns the sender's ticks blue.
   */
  customer_read_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  admin_read_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'support_conversations',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

module.exports = SupportConversation;
