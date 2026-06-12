const express = require('express');
const router = express.Router();
const multer = require("multer");
const OccasionController = require('../controllers/OccasionController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { taxonomyCache } = require('../middleware/cacheHeaders');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Public storefront routes
router.get('/', taxonomyCache, OccasionController.getAll);
router.get('/slug/:slug', taxonomyCache, OccasionController.getBySlug);

// Public admin/storefront lookup route
router.get('/:id', taxonomyCache, OccasionController.getById);

// Admin only routes
router.post('/', authMiddleware, adminMiddleware, upload.single('image'), OccasionController.create);
router.put('/:id', authMiddleware, adminMiddleware, upload.single('image'), OccasionController.update);
router.delete('/:id', authMiddleware, adminMiddleware, OccasionController.delete);

module.exports = router;
