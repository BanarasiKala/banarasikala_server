/**
 * orderLedgerService.js
 *
 * Helpers for the append-only order_ledger — the single source of truth for
 * money on an order. Balance = Σ DEBIT − Σ CREDIT. Nothing is recomputed in
 * place; every flow (placement, cancel, RTO, return) only APPENDS entries.
 */
const OrderLedger = require('../models/OrderLedger');
const RefundTransaction = require('../models/RefundTransaction');
const {
  LEDGER_ENTRY_TYPE: T,
  LEDGER_DIRECTION: D,
  LEDGER_REFERENCE_TYPE: R,
} = require('../utils/orderModelV2');

const round = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** Push a ledger row onto `entries` only when amount > 0. */
const pushEntry = (entries, orderId, { type, amount, direction, referenceType, referenceId, note }) => {
  const amt = round(amount);
  if (amt <= 0) return entries;
  entries.push({
    order_id: orderId,
    entry_type: type,
    amount: amt,
    direction,
    reference_type: referenceType || R.ORDER,
    reference_id: referenceId || null,
    note: note || null,
  });
  return entries;
};

/**
 * Seed the ledger for a freshly placed order.
 *
 * Prepaid → balance nets to 0 (PAYMENT credit equals the charges minus discounts).
 * COD     → balance equals the amount owed at delivery (no PAYMENT entry yet;
 *           COD_COLLECTION is appended when the courier collects on delivery).
 *
 * Returns the created ledger rows so callers can link a PaymentTransaction to
 * the PAYMENT entry.
 */
const seedPlacementLedger = async ({
  orderId,
  paymentMethod,
  itemSubtotal,
  netShipping = 0,
  platformFee = 0,
  codFee = 0,
  giftCharge = 0,
  couponDiscount = 0,
  prepaidDiscount = 0,
  walletCredit = 0,
  paymentReceived = 0,
  transaction,
}) => {
  const isCod = String(paymentMethod || '').toUpperCase() === 'COD';
  const entries = [];

  // Charges (customer owes us)
  pushEntry(entries, orderId, { type: T.PRODUCT_CHARGE, amount: itemSubtotal, direction: D.DEBIT });
  pushEntry(entries, orderId, { type: T.SHIPPING_CHARGE, amount: netShipping, direction: D.DEBIT });
  pushEntry(entries, orderId, { type: T.PLATFORM_FEE, amount: platformFee, direction: D.DEBIT });
  pushEntry(entries, orderId, { type: T.COD_FEE, amount: codFee, direction: D.DEBIT });
  pushEntry(entries, orderId, { type: T.GIFT_CHARGE, amount: giftCharge, direction: D.DEBIT });

  // Discounts (we reduce what they owe)
  pushEntry(entries, orderId, { type: T.COUPON_DISCOUNT, amount: couponDiscount, direction: D.CREDIT });
  pushEntry(entries, orderId, { type: T.PREPAID_DISCOUNT, amount: prepaidDiscount, direction: D.CREDIT });
  pushEntry(entries, orderId, { type: T.WALLET_CREDIT, amount: walletCredit, direction: D.CREDIT });

  // Money actually received now (prepaid only)
  if (!isCod) {
    pushEntry(entries, orderId, {
      type: T.PAYMENT,
      amount: paymentReceived,
      direction: D.CREDIT,
      referenceType: R.PAYMENT,
    });
  }

  return OrderLedger.bulkCreate(entries, { transaction, returning: true });
};

/** Outstanding balance: positive = customer owes us, negative = we owe customer. */
const getOrderBalance = async (orderId, transaction) => {
  const rows = await OrderLedger.findAll({
    where: { order_id: orderId },
    attributes: ['amount', 'direction'],
    transaction,
  });
  let debit = 0;
  let credit = 0;
  for (const row of rows) {
    const amt = Number(row.amount) || 0;
    if (row.direction === D.DEBIT) debit += amt;
    else credit += amt;
  }
  return round(debit - credit);
};

/**
 * Reconstruct the legacy money breakdown from ledger rows, so read endpoints
 * can keep returning the same shape the frontend expects (subtotal_amount,
 * shipping_charge, total_amount, …) without storing those columns.
 */
const deriveOrderTotals = (ledgerRows = []) => {
  // Accumulate debit/credit per entry_type so adjustment entries (e.g. a CREDIT
  // PRODUCT_CHARGE that reduces the subtotal after a modify) net correctly.
  const acc = {};
  let totalDebit = 0;
  let totalCredit = 0;
  for (const row of ledgerRows) {
    const a = Number(row.amount) || 0;
    const bucket = acc[row.entry_type] || (acc[row.entry_type] = { debit: 0, credit: 0 });
    if (row.direction === D.DEBIT) { bucket.debit += a; totalDebit += a; }
    else { bucket.credit += a; totalCredit += a; }
  }
  // Charge types: net = DEBIT − CREDIT. Credit/discount types: net = CREDIT − DEBIT.
  const chargeNet = (type) => round((acc[type]?.debit || 0) - (acc[type]?.credit || 0));
  const creditNet = (type) => round((acc[type]?.credit || 0) - (acc[type]?.debit || 0));

  const subtotal_amount = chargeNet(T.PRODUCT_CHARGE);
  const shipping_charge = chargeNet(T.SHIPPING_CHARGE);
  const platform_fee = chargeNet(T.PLATFORM_FEE);
  const cod_fee = chargeNet(T.COD_FEE);
  const gift_charge = chargeNet(T.GIFT_CHARGE);
  const rto_charge = chargeNet(T.RTO_CHARGE);
  const redispatch_charge = chargeNet(T.REDISPATCH_CHARGE);
  const discount_amount = creditNet(T.COUPON_DISCOUNT);
  const payment_discount = creditNet(T.PREPAID_DISCOUNT);
  const wallet_amount = creditNet(T.WALLET_CREDIT);
  const amount_paid = round(creditNet(T.PAYMENT) + creditNet(T.COD_COLLECTION));
  // REFUND is recorded as a DEBIT (money paid back to the customer).
  const refund_amount = chargeNet(T.REFUND);

  const charges = subtotal_amount + shipping_charge + platform_fee
    + cod_fee + gift_charge + rto_charge + redispatch_charge;
  const discounts = discount_amount + payment_discount + wallet_amount;
  const total_amount = round(charges - discounts);
  return {
    subtotal_amount, shipping_charge, shipping_discount: 0,
    platform_fee, cod_fee, payment_fee: round(platform_fee + cod_fee),
    gift_charge, discount_amount, payment_discount, wallet_amount,
    rto_charge, redispatch_charge, amount_paid, refund_amount,
    total_amount, payable_amount: total_amount,
    // Authoritative outstanding balance straight from the ledger.
    balance_due: round(totalDebit - totalCredit),
  };
};

/** Append a single ledger entry (used by cancel / RTO / return flows). */
const appendEntry = async (orderId, entry, transaction) => {
  const rows = [];
  pushEntry(rows, orderId, entry);
  if (!rows.length) return null;
  const [created] = await OrderLedger.bulkCreate(rows, { transaction, returning: true });
  return created;
};

/**
 * Settle a full-order cancellation on the ledger (partial cancellation no
 * longer exists — customers cancel the whole order or nothing).
 *   Prepaid → reverse the order value, refund what was paid (balance stays 0).
 *   COD     → zero the uncollected balance (nothing to refund).
 * Wallet credit used on the order is reported via walletRefund; the caller
 * credits it back to the customer's wallet (applies to COD orders too).
 * Returns { refundAmount, walletRefund }.
 */
const settleCancellation = async ({ orderId, isCod, transaction }) => {
  const totals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: orderId }, transaction }));

  if (isCod) {
    if (totals.balance_due > 0) {
      await appendEntry(orderId, { type: T.PRODUCT_CHARGE, amount: totals.balance_due, direction: D.CREDIT, referenceType: R.ORDER, note: 'Order cancelled — COD not collected' }, transaction);
    }
    return { refundAmount: 0, walletRefund: totals.wallet_amount };
  }
  const refundAmount = round(totals.amount_paid);
  if (refundAmount > 0) {
    await appendEntry(orderId, { type: T.PRODUCT_CHARGE, amount: refundAmount, direction: D.CREDIT, referenceType: R.ORDER, note: 'Order cancelled — value reversed' }, transaction);
    const refLedger = await appendEntry(orderId, { type: T.REFUND, amount: refundAmount, direction: D.DEBIT, referenceType: R.ORDER, note: 'Cancellation refund' }, transaction);
    await RefundTransaction.create({ order_id: orderId, ledger_entry_id: refLedger?.id || null, gateway: 'original_gateway', amount: refundAmount, status: 'Pending' }, { transaction });
  }
  return { refundAmount, walletRefund: totals.wallet_amount };
};

module.exports = {
  seedPlacementLedger,
  getOrderBalance,
  deriveOrderTotals,
  appendEntry,
  settleCancellation,
  round,
};
