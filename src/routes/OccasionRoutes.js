const express = require('express');
const router = express.Router();
const OccasionController = require('../controllers/OccasionController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { taxonomyCache } = require('../middleware/cacheHeaders');

// Public storefront routes
router.get('/', taxonomyCache, OccasionController.getAll);
router.get('/slug/:slug', taxonomyCache, OccasionController.getBySlug);

// Admin — pre-signed S3 upload URL (static path before /:id so it doesn't collide)
router.get('/admin/upload-url', authMiddleware, adminMiddleware, OccasionController.getUploadUrl);

// Public admin/storefront lookup route
router.get('/:id', taxonomyCache, OccasionController.getById);

// Admin only routes (video URL sent as JSON after direct-to-S3 upload)
router.post('/', authMiddleware, adminMiddleware, OccasionController.create);
router.put('/:id', authMiddleware, adminMiddleware, OccasionController.update);
router.delete('/:id', authMiddleware, adminMiddleware, OccasionController.delete);

module.exports = router;
