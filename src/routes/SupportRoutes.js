const express = require("express");
const router = express.Router();
const SupportController = require("../controllers/SupportController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");
const SupportTicket = require("../models/SupportTicket");
const SupportTicketMessage = require("../models/SupportTicketMessage");

// Global schema sync is off (see config/db.js), so these tables create themselves on first
// load — same pattern as ContactRoutes. Messages after tickets: it references them.
//
// sync({ force: false }) CREATES a missing table but never ALTERS an existing one, so the
// read-receipt columns have to be added explicitly for anyone whose support_tickets table
// already exists. Idempotent, same shape as ensureOrderItemActionSchema.
const { sequelize } = require("../config/db");
const { config } = require("../config/env");
const { DataTypes } = require("sequelize");

const ensureSupportSchema = async () => {
  await SupportTicket.sync({ force: false });
  await SupportTicketMessage.sync({ force: false });

  const qi = sequelize.getQueryInterface();

  const table = { tableName: "support_tickets", schema: config.dbSchema };
  const columns = await qi.describeTable(table);
  for (const name of ["customer_read_at", "admin_read_at", "opening_delivered_at"]) {
    if (!columns[name]) {
      await qi.addColumn(table, name, { type: DataTypes.DATE, allowNull: true });
    }
  }

  // Photo attachments. NOT NULL with a [] default so existing rows land on an empty array
  // rather than null — every read path can then treat this as an array unconditionally.
  if (!columns.attachments) {
    await qi.addColumn(table, "attachments", {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    });
  }

  const messageTable = { tableName: "support_ticket_messages", schema: config.dbSchema };
  const messageColumns = await qi.describeTable(messageTable);
  if (!messageColumns.delivered_at) {
    await qi.addColumn(messageTable, "delivered_at", { type: DataTypes.DATE, allowNull: true });
  }
  if (!messageColumns.attachments) {
    await qi.addColumn(messageTable, "attachments", {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    });
  }
};

ensureSupportSchema().catch((err) => console.error("Support schema sync failed:", err));

// The categories the modal offers, so the client never drifts from the validator.
// The storefront form no longer asks for one, but the admin console still filters by them.
router.get("/categories", (_req, res) => res.json(SupportController.TICKET_CATEGORIES));

// Signed credentials for uploading a photo straight to Cloudinary. Auth only (no admin
// gate) — customers attach photos when raising a query and support attaches them in replies.
router.get("/upload-signature", authMiddleware, SupportController.getUploadSignature);

// Customer — one ticket per order, then a conversation on it.
router.post("/tickets", authMiddleware, SupportController.createTicket);
router.get("/tickets/my", authMiddleware, SupportController.listMyTickets);

// Admin queue. Declared BEFORE /tickets/:id so "tickets" can't be read as an :id.
router.get("/tickets", authMiddleware, adminMiddleware, SupportController.listTickets);
router.patch("/tickets/:id", authMiddleware, adminMiddleware, SupportController.updateTicket);

// ── Realtime ────────────────────────────────────────────────────────────────────────────
// EventSource cannot send an Authorization header, so the two /stream routes are NOT behind
// authMiddleware. They authenticate with a short-lived single-use token minted here, by a
// normal authenticated POST. See SupportRealtime.issueStreamTicket.
router.post("/stream-ticket", authMiddleware, SupportController.streamTicket);

// Admin inbox firehose. Declared BEFORE /tickets/:id/stream so "admin" is never read as an id.
router.get("/stream/admin", SupportController.stream);
router.get("/tickets/:id/stream", SupportController.stream);

router.post("/tickets/:id/typing", authMiddleware, SupportController.typing);
router.post("/tickets/:id/read", authMiddleware, SupportController.markRead);

// Shared by both sides — the handler decides what it may see/do from the authenticated role.
router.get("/tickets/:id", authMiddleware, SupportController.getTicket);
router.post("/tickets/:id/messages", authMiddleware, SupportController.addMessage);

module.exports = router;
