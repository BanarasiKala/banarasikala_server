const express = require("express");
const router = express.Router();
const StatsController = require("../controllers/StatsController");

// Public social-proof stats (no auth).
router.get("/orders-today", StatsController.ordersToday);
router.post("/products/:productId/viewers", StatsController.productViewers);

module.exports = router;
