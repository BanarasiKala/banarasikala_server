const express = require('express');
const router = express.Router();
const NewsletterController = require('../controllers/NewsletterController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');

// Public — anyone can subscribe
router.post('/subscribe', NewsletterController.subscribe);

// Admin only — view all subscribers
router.get('/subscribers', authMiddleware, adminMiddleware, NewsletterController.getAll);

module.exports = router;
