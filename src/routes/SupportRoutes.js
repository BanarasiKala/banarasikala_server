const express = require("express");
const router = express.Router();
const SupportController = require("../controllers/SupportController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");
const SupportTicket = require("../models/SupportTicket");
const SupportTicketMessage = require("../models/SupportTicketMessage");

// Global schema sync is off (see config/db.js), so these tables create themselves on first
// load — same pattern as ContactRoutes. Messages after tickets: it references them.
SupportTicket.sync({ force: false })
  .then(() => SupportTicketMessage.sync({ force: false }))
  .catch((err) => console.error("SupportTicket table sync failed:", err));

// The categories the modal offers, so the client never drifts from the validator.
router.get("/categories", (_req, res) => res.json(SupportController.TICKET_CATEGORIES));

// Customer — one ticket per order, then a conversation on it.
router.post("/tickets", authMiddleware, SupportController.createTicket);
router.get("/tickets/my", authMiddleware, SupportController.listMyTickets);

// Admin queue. Declared BEFORE /tickets/:id so "tickets" can't be read as an :id.
router.get("/tickets", authMiddleware, adminMiddleware, SupportController.listTickets);
router.patch("/tickets/:id", authMiddleware, adminMiddleware, SupportController.updateTicket);

// Shared by both sides — the handler decides what it may see/do from the authenticated role.
router.get("/tickets/:id", authMiddleware, SupportController.getTicket);
router.post("/tickets/:id/messages", authMiddleware, SupportController.addMessage);

module.exports = router;
