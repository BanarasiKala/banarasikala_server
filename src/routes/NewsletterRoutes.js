const express = require('express');
const router = express.Router();
const NewsletterController = require('../controllers/NewsletterController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');

// Public — anyone can subscribe
router.post('/subscribe', NewsletterController.subscribe);

// Admin only — view all subscribers
router.get('/subscribers', authMiddleware, adminMiddleware, NewsletterController.getAll);

// Admin only — compose and send campaigns. `test` exists so the real email can be checked in
// a real inbox before it goes to the whole list; there is no recalling a send.
router.get('/campaigns', authMiddleware, adminMiddleware, NewsletterController.listCampaigns);
router.get('/campaigns/summary', authMiddleware, adminMiddleware, NewsletterController.campaignSummary);
router.post('/campaigns/test', authMiddleware, adminMiddleware, NewsletterController.sendTest);
router.post('/campaigns/send', authMiddleware, adminMiddleware, NewsletterController.sendCampaign);

// Generated from an entity rather than typed — the Coupons and Products screens use these.
router.post('/campaigns/coupon/:couponId', authMiddleware, adminMiddleware, NewsletterController.sendCouponCampaign);
router.post('/campaigns/product/:productId', authMiddleware, adminMiddleware, NewsletterController.sendProductCampaign);

module.exports = router;
