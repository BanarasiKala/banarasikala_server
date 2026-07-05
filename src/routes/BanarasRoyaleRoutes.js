const express = require('express');
const router = express.Router();
const BanarasRoyaleController = require('../controllers/BanarasRoyaleController');
const BanarasRoyale = require('../models/BanarasRoyale');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { taxonomyCache } = require('../middleware/cacheHeaders');

// Create table automatically on first load if it doesn't exist.
BanarasRoyale.sync({ force: false }).catch((err) =>
  console.error('BanarasRoyale table sync failed:', err)
);

// Public storefront route (home-page section).
router.get('/', taxonomyCache, BanarasRoyaleController.getAll);

// Admin — pre-signed S3 upload URL for the video + full list incl. inactive.
router.get('/admin/upload-url', authMiddleware, adminMiddleware, BanarasRoyaleController.getUploadUrl);
router.get('/admin/list', authMiddleware, adminMiddleware, BanarasRoyaleController.listAdmin);

// Admin CRUD (image URLs come from Cloudinary, video URL from direct-to-S3).
router.post('/', authMiddleware, adminMiddleware, BanarasRoyaleController.create);
router.put('/:id', authMiddleware, adminMiddleware, BanarasRoyaleController.update);
router.delete('/:id', authMiddleware, adminMiddleware, BanarasRoyaleController.delete);

module.exports = router;
