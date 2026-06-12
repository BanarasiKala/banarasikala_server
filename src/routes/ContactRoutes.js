const express = require("express");
const router = express.Router();
const ContactController = require("../controllers/ContactController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");
const ContactMessage = require("../models/ContactMessage");

// Create table automatically on first load if it doesn't exist
ContactMessage.sync({ force: false }).catch((err) =>
  console.error("ContactMessage table sync failed:", err)
);

// Public — no auth required
router.post("/submit", ContactController.submit);

// Admin only
router.get("/", authMiddleware, adminMiddleware, ContactController.list);
router.put("/:id/read", authMiddleware, adminMiddleware, ContactController.markRead);

module.exports = router;
