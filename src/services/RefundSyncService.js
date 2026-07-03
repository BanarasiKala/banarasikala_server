/**
 * RefundSyncService
 *
 * Keeps our refund records in step with Razorpay. A gateway refund is
 * asynchronous — we initiate it (status → Processing) and Razorpay confirms it
 * later. Two sync paths feed into the same settle logic:
 *
 *   1. Webhook  — Razorpay POSTs `refund.processed` / `refund.failed` to
 *      /api/razorpay/webhook (production path, needs a public URL).
 *   2. Lazy read — when a customer opens an order that still has a Processing
 *      refund, we ask Razorpay for its current status (works on localhost).
 *
 * On `processed`: OrderRefund → Completed (+processed_at), RefundTransaction →
 * Completed, orders.payment_status → Refunded.
 */
const { Op } = require('sequelize');
const Order = require('../models/Order');
const OrderRefund = require('../models/OrderRefund');
const RefundTransaction = require('../models/RefundTransaction');
const Payment = require('../models/Payment');
const { REFUND_STATUS } = require('../utils/orderTransactions');
const { fetchRefund } = require('./RazorpayService');

const OPEN_STATUSES = [REFUND_STATUS.PENDING, REFUND_STATUS.PROCESSING];

/**
 * Apply a Razorpay refund entity ({ id, payment_id, status, … }) to our rows.
 * Idempotent — re-delivered webhooks just re-write the same terminal state.
 * Returns { matched, settled }.
 */
const settleGatewayRefund = async (refundEntity) => {
  if (!refundEntity?.id) return { matched: false, settled: false };
  const gatewayStatus = String(refundEntity.status || '').toLowerCase();

  // Locate our refund row: prefer the stored gateway refund id, fall back to
  // the payment id (covers refunds initiated before the id was recorded).
  let refundRow = await OrderRefund.findOne({ where: { gateway_refund_id: refundEntity.id } });
  if (!refundRow && refundEntity.payment_id) {
    const payment = await Payment.findOne({ where: { gateway_payment_id: refundEntity.payment_id } });
    if (payment) {
      refundRow = await OrderRefund.findOne({
        where: { order_id: payment.order_id, status: { [Op.in]: OPEN_STATUSES } },
        order: [['created_at', 'DESC']],
      });
    }
  }
  if (!refundRow) return { matched: false, settled: false };

  if (gatewayStatus === 'processed') {
    await refundRow.update({
      status: REFUND_STATUS.COMPLETED,
      gateway_refund_id: refundEntity.id,
      processed_at: refundRow.processed_at || new Date(),
    });
    await RefundTransaction.update(
      { status: 'Completed', gateway_ref: refundEntity.id },
      { where: { order_id: refundRow.order_id, status: { [Op.in]: ['Pending', 'Processing'] } } },
    );
    await Order.update({ payment_status: 'Refunded' }, { where: { id: refundRow.order_id } });
    return { matched: true, settled: true };
  }

  if (gatewayStatus === 'failed') {
    await refundRow.update({
      status: REFUND_STATUS.FAILED,
      gateway_refund_id: refundEntity.id,
      note: `${refundRow.note || ''}${refundRow.note ? ' | ' : ''}Razorpay reported the refund as failed — manual retry required.`.slice(0, 1000),
    });
    return { matched: true, settled: true };
  }

  // created / pending on Razorpay's side — nothing to change yet.
  return { matched: true, settled: false };
};

/**
 * Lazy reconciliation: for an order with open gateway refunds that already
 * have a Razorpay refund id, ask Razorpay for their current status and settle.
 * Best-effort — failures are logged and never block the caller.
 * Returns true when at least one refund reached a terminal state.
 */
const reconcileOrderRefunds = async (orderId) => {
  let changed = false;
  try {
    const open = await OrderRefund.findAll({
      where: {
        order_id: orderId,
        status: { [Op.in]: OPEN_STATUSES },
        gateway_refund_id: { [Op.ne]: null },
        payment_method: 'original_gateway',
      },
    });
    for (const row of open) {
      try {
        const refundEntity = await fetchRefund(row.gateway_refund_id);
        const result = await settleGatewayRefund(refundEntity);
        changed = changed || result.settled;
      } catch (err) {
        console.error(`[RefundSync] Could not check refund ${row.gateway_refund_id}:`, err?.message || err);
      }
    }
  } catch (err) {
    console.error(`[RefundSync] Reconcile failed for order #${orderId}:`, err?.message || err);
  }
  return changed;
};

module.exports = { settleGatewayRefund, reconcileOrderRefunds };
