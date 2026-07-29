const express = require('express');
const router = express.Router();
const AdminReviewController = require('../controllers/AdminReviewController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');

// Admin-only: manage the seed reviews shown when a product has no real customer reviews yet.
router.get('/product/:productId', authMiddleware, adminMiddleware, AdminReviewController.listForProduct);
router.post('/', authMiddleware, adminMiddleware, AdminReviewController.create);
// Before '/:id' — Express matches in declaration order, so this literal path must be tried
// first or 'verified' arrives at update() as an id.
router.put('/verified/bulk', authMiddleware, adminMiddleware, AdminReviewController.setVerifiedBulk);
router.put('/:id', authMiddleware, adminMiddleware, AdminReviewController.update);
router.delete('/:id', authMiddleware, adminMiddleware, AdminReviewController.remove);

module.exports = router;
