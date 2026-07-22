const { QueryTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const SupportConversation = require('../models/SupportConversation');
const SupportTopic = require('../models/SupportTopic');

/**
 * One-time migration: split each conversation's flat message stream into per-order topics.
 *
 * Before this, "which order is this about" was positional — an order-card message marked a
 * switch and everything after it was assumed to belong to that order. That assumption is
 * exactly what this can lean on to undo itself: replaying a conversation in order and
 * carrying the last card forward reconstructs precisely the association the UI was already
 * drawing, so nothing changes meaning in the process.
 *
 * Messages arriving before any card belong to the general strand (order_id NULL) — the
 * customer wrote in without an order in hand.
 *
 * The order-card rows are deleted afterwards. Their entire content (order id and snapshot)
 * now lives on the topic, and leaving them would give one fact two homes that could drift.
 *
 * ── Raw SQL on purpose ──────────────────────────────────────────────────────────────────
 * It reads `order_id` and `order_snapshot`, columns SupportMessage no longer declares. A
 * migration that goes through the live model can only ever see the schema as it is now, so
 * it could not read the very columns it exists to drain. Migrations read the database, not
 * the model.
 *
 * Idempotent by construction: it only touches messages whose `topic_id` is still NULL, which
 * is a state no message can be in once it has been through. A crash halfway leaves the
 * remainder for the next boot.
 */

const table = `"${config.dbSchema}"."support_messages"`;
const topicTable = `"${config.dbSchema}"."support_topics"`;

// Postgres does not treat NULLs as equal, so the model's unique index on
// (conversation_id, order_id) cannot stop two general strands existing for one customer.
// A partial index does exactly that, and nothing else can express it.
const ensureGeneralTopicUniqueness = async () => {
  await sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS support_topics_general_unique
       ON ${topicTable} (conversation_id) WHERE order_id IS NULL`,
  );
};

const columnsOf = async () => {
  const rows = await sequelize.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = :schema AND table_name = 'support_messages'`,
    { replacements: { schema: config.dbSchema }, type: QueryTypes.SELECT },
  );
  return new Set(rows.map((r) => r.column_name));
};

const migrateToTopics = async () => {
  await ensureGeneralTopicUniqueness();

  const columns = await columnsOf();
  if (!columns.has('topic_id')) return { conversations: 0, topics: 0, cardsRemoved: 0 };
  // A database that never had the flat shape has no cards to drain — only the general strand
  // matters, and the send path creates that on demand.
  const hasLegacyOrderColumns = columns.has('order_id') && columns.has('order_snapshot');

  const pending = await sequelize.query(
    `SELECT DISTINCT conversation_id FROM ${table} WHERE topic_id IS NULL`,
    { type: QueryTypes.SELECT },
  );
  if (!pending.length) return { conversations: 0, topics: 0, cardsRemoved: 0 };

  let topicsMade = 0;
  let cardsRemoved = 0;

  for (const { conversation_id: conversationId } of pending) {
    // Per conversation, so one bad row cannot strand every other customer's history.
    await sequelize.transaction(async (transaction) => {
      const select = hasLegacyOrderColumns
        ? `SELECT id, type, order_id, order_snapshot, created_at, topic_id FROM ${table}`
        : `SELECT id, type, NULL::int AS order_id, NULL::jsonb AS order_snapshot, created_at, topic_id FROM ${table}`;
      const messages = await sequelize.query(
        `${select} WHERE conversation_id = :id ORDER BY created_at ASC, id ASC`,
        { replacements: { id: conversationId }, type: QueryTypes.SELECT, transaction },
      );

      // Topics this conversation already has, so a partial run does not duplicate them.
      const existing = await SupportTopic.findAll({
        where: { conversation_id: conversationId },
        transaction,
      });
      const byKey = new Map(existing.map((t) => [String(t.order_id ?? 'general'), t]));

      const topicFor = async (orderId, snapshot, at) => {
        const key = String(orderId ?? 'general');
        if (byKey.has(key)) return byKey.get(key);
        const topic = await SupportTopic.create({
          conversation_id: conversationId,
          order_id: orderId ?? null,
          order_snapshot: snapshot || null,
          status: 'Open',
          last_message_at: at,
        }, { transaction });
        byKey.set(key, topic);
        topicsMade += 1;
        return topic;
      };

      let current = null;
      const cardIds = [];
      const lastAt = new Map();

      for (const message of messages) {
        if (message.type === 'order') {
          // The card marks a switch. It becomes the topic, then stops being a message.
          current = await topicFor(message.order_id, message.order_snapshot, message.created_at);
          cardIds.push(message.id);
          continue;
        }
        // Anything before the first card was written without an order in hand.
        if (!current) current = await topicFor(null, null, message.created_at);

        if (message.topic_id !== current.id) {
          await sequelize.query(
            `UPDATE ${table} SET topic_id = :topic WHERE id = :id`,
            { replacements: { topic: current.id, id: message.id }, transaction },
          );
        }
        lastAt.set(current.id, message.created_at);
      }

      for (const [topicId, at] of lastAt) {
        await SupportTopic.update({ last_message_at: at }, { where: { id: topicId }, transaction });
      }

      if (cardIds.length) {
        await sequelize.query(
          `DELETE FROM ${table} WHERE id IN (:ids)`,
          { replacements: { ids: cardIds }, transaction },
        );
        cardsRemoved += cardIds.length;
      }

      // The conversation's status described whatever was most recently in play, so it belongs
      // to the newest strand. The rest stay Open — claiming they were resolved would invent a
      // fact nobody recorded.
      const conversation = await SupportConversation.findByPk(conversationId, { transaction });
      const newest = [...byKey.values()].sort(
        (a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0),
      )[0];
      if (conversation && newest) {
        await SupportTopic.update(
          { status: conversation.status },
          { where: { id: newest.id }, transaction },
        );
      }
    });
  }

  return { conversations: pending.length, topics: topicsMade, cardsRemoved };
};

/**
 * Tighten the schema once nothing is left unassigned.
 *
 * Deliberately separate from the migration and guarded on there being no NULLs: `topic_id`
 * had to arrive nullable so the backfill had somewhere to write, and the drained columns
 * cannot go until everything that needed them has been read. Run early, either would destroy
 * the data the migration is midway through moving.
 */
const finalizeTopicSchema = async () => {
  const [{ count }] = await sequelize.query(
    `SELECT COUNT(*)::int AS count FROM ${table} WHERE topic_id IS NULL`,
    { type: QueryTypes.SELECT },
  );
  if (count > 0) return { tightened: false, remaining: count };

  await sequelize.query(`ALTER TABLE ${table} ALTER COLUMN topic_id SET NOT NULL`);
  await sequelize.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS order_id`);
  await sequelize.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS order_snapshot`);
  return { tightened: true, remaining: 0 };
};

module.exports = { migrateToTopics, finalizeTopicSchema, ensureGeneralTopicUniqueness };
