const express = require('express');
const router = express.Router();
const BoxSectionController = require('../controllers/BoxSectionController');
const BoxSection = require('../models/BoxSection');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { taxonomyCache } = require('../middleware/cacheHeaders');

// Create table automatically on first load if it doesn't exist.
BoxSection.sync({ force: false }).catch((err) =>
  console.error('BoxSection table sync failed:', err)
);

// Public storefront route (home-page section).
router.get('/', taxonomyCache, BoxSectionController.getAll);

// Admin — pre-signed S3 upload URL per video + full list incl. inactive.
router.get('/admin/upload-url', authMiddleware, adminMiddleware, BoxSectionController.getUploadUrl);
router.get('/admin/list', authMiddleware, adminMiddleware, BoxSectionController.listAdmin);

// Admin CRUD (image URLs come from Cloudinary, video URLs from direct-to-S3).
router.post('/', authMiddleware, adminMiddleware, BoxSectionController.create);
router.put('/:id', authMiddleware, adminMiddleware, BoxSectionController.update);
router.delete('/:id', authMiddleware, adminMiddleware, BoxSectionController.delete);

module.exports = router;
