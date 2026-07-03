const express = require('express');
const router = express.Router();
const OrderController = require('../controllers/OrderController');
const OrderItemActionController = require('../controllers/OrderItemActionController');
const { authMiddleware, optionalAuthMiddleware, adminMiddleware } = require('../middleware/authMiddleware');

// Checkout route. Logged-in customers are linked by user id; guests remain supported.
router.post('/', optionalAuthMiddleware, OrderController.createOrder);

// Customer-facing My Orders page. Uses logged-in customer id, not email.
router.get('/my', authMiddleware, OrderController.getCurrentCustomerOrders);

// Legacy route kept for old clients, but protected and resolved by logged-in user id.
router.get('/my/:email', authMiddleware, OrderController.getCurrentCustomerOrders);

// Live tracking by order ID (fetches ShipRocket tracking data)
router.get('/track/:orderId', authMiddleware, OrderController.trackOrder);

// Admin queues for partial cancellations, returns and exchanges.
router.get('/admin/item-actions', authMiddleware, adminMiddleware, OrderItemActionController.listAdmin);
router.patch('/admin/item-actions/:actionId/status', authMiddleware, adminMiddleware, OrderItemActionController.updateAdminStatus);

// Customer return and exchange requests (post-delivery). Item-level
// cancellation was removed — cancellation is whole-order only via /:id/cancel.
router.post('/:orderId/item-actions/estimate', authMiddleware, OrderItemActionController.estimate);
router.post('/:orderId/item-actions', authMiddleware, OrderItemActionController.create);

// Customer COD refund bank details and admin refund status.
router.post('/:id/refund-bank-details', authMiddleware, OrderController.saveRefundBankDetails);
router.patch('/:id/refund-status', authMiddleware, adminMiddleware, OrderController.updateRefundStatus);

// Single customer order detail. Uses logged-in customer id.
router.get('/:id', authMiddleware, OrderController.getCustomerOrderById);

// Customer cancellation: whole order only, within 24 hours and only while the
// order status has not progressed. Also attempts ShipRocket cancel.
router.post('/:id/cancel', authMiddleware, OrderController.cancelOrder);

// Admin/order lookup route.
router.get('/', authMiddleware, adminMiddleware, OrderController.getMyOrders);

// Admin: Update status (e.g., Delivered). Triggers referral reward scheduling.
router.patch('/:id/status', authMiddleware, adminMiddleware, OrderController.updateOrderStatus);

module.exports = router;
