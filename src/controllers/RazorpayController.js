const crypto = require('crypto');
const { config } = require('../config/env');
const { createOrder: razorpayCreateOrder } = require('../services/RazorpayService');

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

class RazorpayController {
  async createOrder(req, res) {
    try {
      // Accept either a legacy `amount` field or structured cart fields.
      // Structured fields (subtotal_amount + discount_amount + wallet_amount) are
      // preferred because the backend computes fees from its own env vars, which
      // guarantees the Razorpay order amount always matches the order-creation check.
      const { subtotal_amount, discount_amount = 0, wallet_amount = 0, is_gift = false } = req.body;
      const subtotal = roundMoney(Number(subtotal_amount || 0));

      let finalAmount;
      if (subtotal > 0) {
        const platformFee = roundMoney(Math.max(0, Number(config.platformFeeAmount || 0)));
        const giftCharge = is_gift ? roundMoney(Math.max(0, Number(config.giftChargeAmount || 0))) : 0;
        const paymentDiscount = roundMoney(Math.min(Number(config.prepaidDiscountAmount || 0), subtotal));
        const grossBeforeCoupon = roundMoney(Math.max(0, subtotal + platformFee + giftCharge - paymentDiscount));
        const couponDiscount = roundMoney(Math.max(0, Math.min(Number(discount_amount || 0), grossBeforeCoupon)));
        const grossAfterCoupon = roundMoney(Math.max(0, grossBeforeCoupon - couponDiscount));
        const walletDebit = roundMoney(Math.min(Math.max(0, Number(wallet_amount || 0)), grossAfterCoupon));
        finalAmount = roundMoney(Math.max(1, grossAfterCoupon - walletDebit));
      } else {
        // Legacy path: direct amount in rupees
        finalAmount = roundMoney(Number(req.body.amount || 0));
        if (!Number.isFinite(finalAmount) || finalAmount < 1) {
          return res.status(400).json({ message: 'Valid order amount is required.' });
        }
      }

      const order = await razorpayCreateOrder(finalAmount);
      return res.status(200).json(order);
    } catch (error) {
      console.error('[Razorpay] createOrder error:', error?.message || error);
      return res.status(500).json({ message: 'Unable to start online payment.' });
    }
  }

  async verifyPayment(req, res) {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Payment verification details are missing.' });
      }

      const expectedSign = crypto
        .createHmac('sha256', config.razorpayKeySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      if (expectedSign !== razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Payment verification failed.' });
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('[Razorpay] verifyPayment error:', error?.message || error);
      return res.status(500).json({ success: false, message: 'Unable to verify payment.' });
    }
  }
}

module.exports = new RazorpayController();
