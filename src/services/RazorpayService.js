const Razorpay = require("razorpay");
const { config } = require("../config/env");

const razorpay = new Razorpay({
  key_id: config.razorpayKeyId,
  key_secret: config.razorpayKeySecret,
});

const toPaise = (amount) => Math.round(Number(amount || 0) * 100);

const refundPayment = async (paymentId, amountRupees, notes = {}) => {
  const amountPaise = toPaise(amountRupees);
  if (!paymentId || amountPaise <= 0) return null;
  return razorpay.payments.refund(paymentId, {
    amount: amountPaise,
    notes,
  });
};

const createOrder = async (amountRupees) => {
  return razorpay.orders.create({
    amount: toPaise(amountRupees),
    currency: "INR",
    receipt: `bk_${Date.now()}`,
  });
};

module.exports = { razorpay, refundPayment, createOrder };
