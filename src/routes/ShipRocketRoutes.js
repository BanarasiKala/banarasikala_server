const express = require('express');
const router = express.Router();
const ShipRocketController = require('../controllers/ShipRocketController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');

router.post('/push-order', authMiddleware, adminMiddleware, ShipRocketController.pushOrder);
router.post('/assign-awb', authMiddleware, adminMiddleware, ShipRocketController.assignAWB);
router.post('/generate-label', authMiddleware, adminMiddleware, ShipRocketController.generateLabel);
router.post('/generate-manifest', authMiddleware, adminMiddleware, ShipRocketController.generateManifest);
router.post('/schedule-pickup', authMiddleware, adminMiddleware, ShipRocketController.schedulePickup);
router.post('/cancel', authMiddleware, adminMiddleware, ShipRocketController.cancelOrders);

/**
 * GET /api/shiprocket/track/awb/:awb
 * Track a shipment by AWB number.
 */
router.get('/track/awb/:awb', ShipRocketController.trackByAWB);

/**
 * GET /api/shiprocket/track/order/:orderId
 * Track a shipment using the VNS Order ID (DB lookup).
 */
router.get('/track/order/:orderId', ShipRocketController.trackByOrderId);

/**
 * GET /api/shiprocket/serviceability?pincode=123456
 * Check which couriers serve a given pincode.
 */
router.get('/serviceability', ShipRocketController.checkServiceability);

/**
 * POST /api/shiprocket/create-return
 * Body: { orderId: number }
 * Initiate return shipment on ShipRocket.
 */
router.post('/create-return', authMiddleware, ShipRocketController.createReturn);
router.post('/create-exchange', authMiddleware, ShipRocketController.createExchange);
router.post('/cancel-return', authMiddleware, ShipRocketController.cancelReturn);
router.post('/cancel-exchange', authMiddleware, ShipRocketController.cancelExchange);

/**
 * POST /api/shiprocket/webhook
 * ShipRocket webhook for shipment status updates.
 */
router.post('/webhook', ShipRocketController.webhook);

module.exports = router;
