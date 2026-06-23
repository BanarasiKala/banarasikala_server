const express = require('express');
const router = express.Router();
const ProductController = require('../controllers/ProductController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { catalogCache } = require('../middleware/cacheHeaders');

// Public routes
router.get('/', catalogCache, ProductController.getAll);
router.get('/summary', authMiddleware, adminMiddleware, ProductController.getSummary);
router.get('/upload-signature', authMiddleware, adminMiddleware, ProductController.getUploadSignature);
router.get('/s3-video-url', authMiddleware, adminMiddleware, ProductController.getS3VideoUrl);
router.get('/:slug/related', catalogCache, ProductController.getRelatedBySlug);
router.get('/:slug/detail', catalogCache, ProductController.getDetailBySlug);
router.get('/:slug/colors/:colorId/images', catalogCache, ProductController.getColorImages);
router.get('/:id(\\d+)', catalogCache, ProductController.getById);
router.get('/:slug', catalogCache, ProductController.getBySlug);

// Admin only routes
router.post('/', authMiddleware, adminMiddleware, ProductController.create);
router.put('/:id', authMiddleware, adminMiddleware, ProductController.update);
router.post('/with-images', authMiddleware, adminMiddleware, ProductController.createWithImages);
router.put('/:id/with-images', authMiddleware, adminMiddleware, ProductController.updateWithImages);
router.delete('/:id', authMiddleware, adminMiddleware, ProductController.delete);

module.exports = router;
