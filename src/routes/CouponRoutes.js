const express = require('express');
const router = express.Router();
const CouponController = require('../controllers/CouponController');
const { authMiddleware, adminMiddleware, optionalAuthMiddleware } = require('../middleware/authMiddleware');

router.get('/', optionalAuthMiddleware, CouponController.getAll);
router.get('/homepage', CouponController.getHomepageCoupons);
router.get('/:id', CouponController.getById);
router.post('/', authMiddleware, adminMiddleware, CouponController.create);
router.post('/validate', optionalAuthMiddleware, CouponController.validate);
router.put('/:id', authMiddleware, adminMiddleware, CouponController.update);
router.delete('/:id', authMiddleware, adminMiddleware, CouponController.delete);

module.exports = router;
