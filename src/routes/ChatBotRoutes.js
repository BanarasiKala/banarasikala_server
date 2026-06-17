const express = require("express");
const router = express.Router();
const ChatBotController = require("../controllers/ChatBotController");

// Public — no auth required for chatbot
router.post("/message", ChatBotController.message);

module.exports = router;
