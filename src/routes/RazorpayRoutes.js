const express = require('express');
const RazorpayController = require('../controllers/RazorpayController');

const router = express.Router();

router.post('/create-order', RazorpayController.createOrder);
router.post('/verify-payment', RazorpayController.verifyPayment);

// Razorpay server-to-server webhook (refund.processed / refund.failed).
// Authenticated by HMAC signature, not by a user token.
router.post('/webhook', RazorpayController.webhook);

module.exports = router;
