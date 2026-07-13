const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const router = express.Router();
const ChatBotController = require("../controllers/ChatBotController");
const { optionalAuthMiddleware } = require("../middleware/authMiddleware");

/**
 * Every call to this endpoint spends money at Anthropic. Without a limit, one bored person
 * with a `for` loop runs up the bill — this is not a theoretical abuse, it is the first thing
 * that happens to a public LLM endpoint.
 *
 * Keyed by customer id when signed in, IP otherwise, so one logged-in customer behind a shared
 * office IP is not throttled by their colleagues.
 */
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  // ipKeyGenerator normalises IPv6 to its /64 prefix. A raw `req.ip` would let one IPv6 user
  // rotate addresses inside their own subnet and bypass the limit completely.
  keyGenerator: (req) => (req.user?.id ? `c:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => res.status(429).json({
    reply: "You're sending messages a little quickly — give me a moment to catch up. 🙏",
  }),
});

/**
 * optionalAuth, not auth: the assistant answers product questions for anonymous visitors, and
 * the account tools (orders, returns, cart) are only registered when a customer is signed in.
 * The identity comes from the JWT here and is never read from the request body.
 */
router.post("/message", optionalAuthMiddleware, chatLimiter, ChatBotController.message);

module.exports = router;
