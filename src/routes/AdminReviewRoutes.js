const express = require('express');
const router = express.Router();
const AdminReviewController = require('../controllers/AdminReviewController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');

// Admin-only: manage the seed reviews shown when a product has no real customer reviews yet.
router.get('/product/:productId', authMiddleware, adminMiddleware, AdminReviewController.listForProduct);
router.post('/', authMiddleware, adminMiddleware, AdminReviewController.create);
router.put('/:id', authMiddleware, adminMiddleware, AdminReviewController.update);
router.delete('/:id', authMiddleware, adminMiddleware, AdminReviewController.remove);

module.exports = router;
