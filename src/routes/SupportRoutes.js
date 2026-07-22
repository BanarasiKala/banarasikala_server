const express = require("express");
const router = express.Router();
const SupportController = require("../controllers/SupportController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");
const SupportConversation = require("../models/SupportConversation");
const SupportTopic = require("../models/SupportTopic");
const SupportMessage = require("../models/SupportMessage");
const { sequelize } = require("../config/db");
const { config } = require("../config/env");
const { DataTypes } = require("sequelize");
const { migrateToTopics, finalizeTopicSchema } = require("../services/SupportTopicMigration");

/**
 * Schema, then the one-time split into per-order topics.
 *
 * Global schema sync is off (see config/db.js), so these tables create themselves on first
 * load — same pattern as ContactRoutes. Order matters twice over: topics reference
 * conversations, messages reference topics, and the backfill needs somewhere to write before
 * the schema can be tightened around it.
 *
 * `topic_id` is added NULLABLE on an existing table even though the model declares it NOT
 * NULL. It has to be: the rows that need a topic do not have one yet, and adding a NOT NULL
 * column to a populated table fails outright. finalizeTopicSchema tightens it afterwards,
 * once nothing is left unassigned. A fresh install skips all of this — sync creates the
 * column NOT NULL from the model and there is nothing to backfill.
 */
const ensureSupportSchema = async () => {
  await SupportConversation.sync({ force: false });
  await SupportTopic.sync({ force: false });
  await SupportMessage.sync({ force: false });

  const qi = sequelize.getQueryInterface();
  const messages = { tableName: "support_messages", schema: config.dbSchema };
  const columns = await qi.describeTable(messages);
  if (!columns.topic_id) {
    await qi.addColumn(messages, "topic_id", { type: DataTypes.INTEGER, allowNull: true });
  }
};

// Failure is logged and swallowed rather than thrown: the whole API failing to mount because
// support chat could not prepare its schema would be far worse than support chat being
// briefly unavailable.
ensureSupportSchema()
  .then(migrateToTopics)
  .then((result) => {
    if (result?.topics) {
      console.log(`Support topics: created ${result.topics} across ${result.conversations} conversation(s), removed ${result.cardsRemoved} order-card row(s).`);
    }
    return finalizeTopicSchema();
  })
  .then((result) => {
    if (result && !result.tightened) {
      console.warn(`Support topics: ${result.remaining} message(s) still unassigned — schema left loose, will retry next boot.`);
    }
  })
  .catch((err) => console.error("Support schema/topic migration failed:", err));

// Signed credentials for uploading a photo straight to Cloudinary. Auth only (no admin gate)
// — customers attach photos to a complaint and support attaches them to a reply.
router.get("/upload-signature", authMiddleware, SupportController.getUploadSignature);

// ── Customer ────────────────────────────────────────────────────────────────────────────
// No ids in any of these paths: a customer has exactly one conversation and the server
// resolves it from their token, so there is nothing to enumerate or tamper with.
router.get("/conversation", authMiddleware, SupportController.getMyConversation);
router.get("/conversation/unread", authMiddleware, SupportController.getMyUnreadCount);
router.post("/conversation/messages", authMiddleware, SupportController.sendMyMessage);
router.post("/conversation/reopen", authMiddleware, SupportController.reopenMyTopic);
router.post("/conversation/read", authMiddleware, SupportController.markMyRead);
router.post("/conversation/typing", authMiddleware, SupportController.typing);

// ── Realtime ────────────────────────────────────────────────────────────────────────────
// The /stream routes are NOT behind authMiddleware: EventSource cannot send an Authorization
// header. They authenticate with the short-lived single-use token minted here by a normal
// authenticated POST. See SupportRealtime.issueStreamToken.
router.post("/stream-token", authMiddleware, SupportController.streamToken);

// Declared before the parameterised admin route so "admin" is never read as an id.
router.get("/stream/admin", SupportController.stream);
router.get("/stream/conversations/:id", SupportController.stream);
// The customer's own stream — which conversation comes from the token, not the URL.
router.get("/stream", SupportController.stream);

// ── Admin ───────────────────────────────────────────────────────────────────────────────
router.get("/conversations", authMiddleware, adminMiddleware, SupportController.listConversations);
router.get("/conversations/:id", authMiddleware, adminMiddleware, SupportController.getConversation);
router.post("/conversations/:id/messages", authMiddleware, adminMiddleware, SupportController.sendAdminMessage);
router.post("/conversations/:id/read", authMiddleware, adminMiddleware, SupportController.markAdminRead);
router.post("/conversations/:id/typing", authMiddleware, adminMiddleware, SupportController.typing);
// Status is per STRAND, not per customer — the damaged saree can be resolved while the parcel
// that never arrived stays open, so the order is in the path.
router.patch("/conversations/:id/topics/:topicId", authMiddleware, adminMiddleware, SupportController.updateTopic);

module.exports = router;
