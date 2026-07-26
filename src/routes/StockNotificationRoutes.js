const express = require('express');
const router = express.Router();
const StockNotificationController = require('../controllers/StockNotificationController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');

// Customer registers interest in a back-in-stock alert.
router.post('/product/:productId', authMiddleware, StockNotificationController.register);
// Admin emails everyone waiting for this product (used from the Products screen).
router.post('/product/:productId/send', authMiddleware, adminMiddleware, StockNotificationController.sendRestock);

module.exports = router;
