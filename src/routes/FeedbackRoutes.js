const express = require('express');
const router = express.Router();
const FeedbackController = require('../controllers/FeedbackController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { feedbackUpload: upload } = require('../config/multer');

// Public route to get approved feedback
router.get('/approved', FeedbackController.getApprovedFeedback);
router.get('/product/:productId', FeedbackController.getProductFeedback);

// Protected route to submit feedback
router.post('/submit', authMiddleware, upload.array('images', 5), FeedbackController.submitFeedback);
router.post('/general', authMiddleware, FeedbackController.submitGeneralFeedback);

// Admin routes
router.get('/pending', authMiddleware, adminMiddleware, FeedbackController.getPendingFeedback);
router.put('/approve/:id', authMiddleware, adminMiddleware, FeedbackController.approveFeedback);
router.delete('/:id', authMiddleware, adminMiddleware, FeedbackController.deleteFeedback);

module.exports = router;
