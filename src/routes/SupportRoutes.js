const express = require("express");
const router = express.Router();
const SupportController = require("../controllers/SupportController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");
const SupportTicket = require("../models/SupportTicket");

// Global schema sync is off (see config/db.js), so this table creates itself on
// first load — same pattern as ContactRoutes.
SupportTicket.sync({ force: false }).catch((err) =>
  console.error("SupportTicket table sync failed:", err)
);

// The categories the modal offers, so the client never drifts from the validator.
router.get("/categories", (_req, res) => res.json(SupportController.TICKET_CATEGORIES));

// Customer — raise a ticket against an order they own, and read their own tickets.
router.post("/tickets", authMiddleware, SupportController.createTicket);
router.get("/tickets/my", authMiddleware, SupportController.listMyTickets);

// Admin queue.
router.get("/tickets", authMiddleware, adminMiddleware, SupportController.listTickets);
router.patch("/tickets/:id", authMiddleware, adminMiddleware, SupportController.updateTicket);

module.exports = router;
