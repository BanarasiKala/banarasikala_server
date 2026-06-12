const express = require('express');
const router = express.Router();
const ColorController = require('../controllers/ColorController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { taxonomyCache } = require('../middleware/cacheHeaders');

router.get('/', taxonomyCache, ColorController.getAll);
router.get('/:id', taxonomyCache, ColorController.getById);
router.post('/', authMiddleware, adminMiddleware, ColorController.create);
router.put('/:id', authMiddleware, adminMiddleware, ColorController.update);
router.delete('/:id', authMiddleware, adminMiddleware, ColorController.delete);

module.exports = router;
