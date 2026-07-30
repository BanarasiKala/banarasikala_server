const express = require('express');
const router = express.Router();
const FeedbackController = require('../controllers/FeedbackController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { feedbackUpload: upload } = require('../config/multer');

// Public route to get approved feedback
router.get('/approved', FeedbackController.getApprovedFeedback);
router.get('/product/:productId', FeedbackController.getProductFeedback);

// Protected route to submit feedback
router.get('/upload-signature', authMiddleware, FeedbackController.getUploadSignature);
router.post('/submit', authMiddleware, upload.array('images', 5), FeedbackController.submitFeedback);
router.post('/general', authMiddleware, FeedbackController.submitGeneralFeedback);

// Admin routes
router.get('/pending', authMiddleware, adminMiddleware, FeedbackController.getPendingFeedback);
// Everything, product reviews included — the public /approved above is general testimonials
// only, which left approved product reviews unreachable from the moderation screen.
router.get('/all', authMiddleware, adminMiddleware, FeedbackController.getAllFeedback);
router.put('/approve/:id', authMiddleware, adminMiddleware, FeedbackController.approveFeedback);
// Declared BEFORE '/:id' below — Express matches in order, and 'verified' would otherwise be
// read as an id by the delete route if the paths ever converged.
router.put('/verified/bulk', authMiddleware, adminMiddleware, FeedbackController.setFeedbackVerifiedBulk);
router.put('/verified/:id', authMiddleware, adminMiddleware, FeedbackController.setFeedbackVerified);
router.delete('/:id', authMiddleware, adminMiddleware, FeedbackController.deleteFeedback);

module.exports = router;
