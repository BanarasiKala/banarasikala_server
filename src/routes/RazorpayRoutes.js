const express = require('express');
const RazorpayController = require('../controllers/RazorpayController');

const router = express.Router();

router.post('/create-order', RazorpayController.createOrder);
router.post('/verify-payment', RazorpayController.verifyPayment);

module.exports = router;
