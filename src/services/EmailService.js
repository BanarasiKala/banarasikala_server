const nodemailer = require('nodemailer');
const dns = require('dns');
const { config } = require('../config/env');
const { buildPreferenceUrl } = require('../utils/emailPreferenceToken');
const { normalizeEmail } = require('../utils/emailAddress');
const OrderItem = require('../models/OrderItem');
const OrderAddress = require('../models/OrderAddress');
const Customer = require('../models/Customer');
const Product = require('../models/Product');

// Resolve the same product thumbnail the storefront shows for an order line:
// prefer the ordered colour's image, else the cover image, else the first.
const sortProductImages = (images = []) => [...images].sort((a, b) => {
  const left = Number.isFinite(Number(a.display_order)) ? Number(a.display_order) : 999;
  const right = Number.isFinite(Number(b.display_order)) ? Number(b.display_order) : 999;
  return left - right;
});
const pickOrderItemImage = (product, colorId) => {
  const images = Array.isArray(product?.images) ? sortProductImages(product.images) : [];
  if (!images.length) return "";
  const numericColorId = Number(colorId);
  const colorImages = Number.isFinite(numericColorId)
    ? images.filter((image) => Number(image.color_id) === numericColorId)
    : [];
  const coverImages = images.filter((image) => image.is_cover);
  const selected = colorImages[0] || coverImages[0] || images[0];
  return selected?.url || selected?.image_url || "";
};

/**
 * The logo, on the CDN rather than the storefront.
 *
 * This is the exact lockup the storefront header shows — the BK monogram, the BANARASI KALA
 * wordmark and the "handcrafted with love" line, all in one image. Because the name is baked
 * into the artwork, the header sets no separate wordmark beneath it.
 *
 * An email is opened outside our network, often months later, so the image URL has to be
 * absolute, public and permanent. `config.frontendUrl` is neither in development (localhost,
 * which resolves to the reader's own machine) nor reliably cached in production, and an
 * attachment would show as a paperclip on every receipt. Cloudinary is already the image
 * host for everything else here.
 */
const BRAND_LOGO_URL = 'https://res.cloudinary.com/drvmplgnr/image/upload/v1784972306/vns-saree/brand/header-logo.png';

// Interpolated straight into email HTML, so it has to be escaped: a support message is
// attacker-controlled text, and an unescaped </div><script> in one would run in whichever
// webmail client renders it.
const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const transporter = nodemailer.createTransport({
  host: config.emailHost,        // e.g. smtp.titan.email
  port: config.emailPort,        // 465 = SSL, 587 = STARTTLS
  secure: Number(config.emailPort) === 465, // true for 465, false for 587
  pool: true,
  maxConnections: 5,
  family: 4,
  auth: {
    user: String(config.emailUser || '').trim(),
    // Strip any whitespace (Gmail App Passwords are shown with spaces; harmless elsewhere).
    pass: String(config.emailPass || '').replace(/\s/g, ''),
  },
  tls: {
    // Lenient cert check for cloud hosts; modern default ciphers (no forced SSLv3).
    rejectUnauthorized: false,
  },
});

// Verification check on boot (App start hote hi pata chal jayega connect ho raha hai ya nahi)
transporter.verify((error, success) => {
  if (error) {
    console.error('[SMTP VERIFY ERROR] Connection failed:', error.message);
  } else {
    console.log('[SMTP VERIFY SUCCESS] Server is ready to take our messages! 🚀');
  }
});

/**
 * The shared shell every transactional email is built in.
 *
 * ── Why a shell rather than a template per email ────────────────────────────────────────
 * The confirmation and the cancellation differ in about six lines of copy and one banner;
 * everything else — the wrapper, the logo lockup, the centred hero, the footer, the mobile
 * rules — is identical. Kept as two templates they drift: the logo grows in one, the footer
 * address changes in the other, and a customer who has both in their inbox can see the seam.
 *
 * ── Why the markup looks like this ──────────────────────────────────────────────────────
 * Tables, inline styles, and one <style> block that only ADDS mobile overrides. Outlook
 * renders through Word's HTML engine — no flexbox, no media queries — so the desktop layout
 * has to stand up on tables and inline attributes alone. The <style> block is progressive
 * enhancement for clients that support it; where it is dropped the email is still correct,
 * just fixed-width. Centred blocks carry `align="center"` AND `text-align`, because Outlook
 * honours the attribute and ignores CSS on block children.
 *
 * @param {object}  opts
 * @param {string}  opts.orderNumber
 * @param {string}  opts.placedLabel  Date under the order number, may be ''.
 * @param {string}  opts.heading      The one-line headline.
 * @param {string}  opts.intro        Sentence under the headline. Pre-escaped by the caller.
 * @param {string}  opts.ctaLabel
 * @param {string}  opts.ctaUrl
 * @param {string}  opts.banner       Optional coloured strip above the headline.
 * @param {string}  opts.body         The middle of the email — already-built HTML.
 * @param {string}  opts.supportEmail
 * @param {string}  opts.storeUrl
 * @param {string}  opts.preheader    The grey line an inbox shows beside the subject.
 */
const emailShell = ({
  orderNumber = '', placedLabel = '', heading = '', intro = '',
  ctaLabel = '', ctaUrl = '', banner = '', body = '',
  supportEmail = '', storeUrl = '', preheader = '',
  // Set ONLY on optional mail — newsletters and back-in-stock alerts. Transactional mail
  // (order confirmations, verification, OTPs) deliberately omits it: those are part of a
  // purchase the customer asked for, and offering to switch them off would be a promise we
  // could not keep while an order is live.
  unsubscribeUrl = '',
}) => `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet" />
<style>
  /* Cinzel is the storefront's brand face and the one the BK monogram is drawn in, so the
     wordmark is set in it too. Gmail strips web fonts outright — hence the Georgia fallback,
     the closest high-contrast serif that ships everywhere. */
  .brand-name { font-family: 'Cinzel', Georgia, 'Times New Roman', serif !important; }

  /* Mobile only. The two-column blocks become full-width rows: 50% columns at 360px leave
     about 150px per address, which wraps a street line into four. */
  @media only screen and (max-width:600px) {
    .m-wrap  { width:100% !important; padding:0 16px !important; }
    .m-stack { display:block !important; width:100% !important; padding-right:0 !important; }
    .m-h1    { font-size:20px !important; }
    .m-logo  { width:130px !important; height:auto !important; }
    .brand-name { font-size:19px !important; letter-spacing:0.1em !important; }
    .m-btn   { display:block !important; text-align:center !important; }
  }
</style>
</head>
<!-- White page, not the grey #f6f6f4 it used to be. The card is separated from the page by a
     hairline instead of by a change of shade — the grey gutter read as a frame around the letter
     and, on the many clients that force their own white body, showed up as two mismatched
     backgrounds either side of it. Set on both <body> and the outer table because clients
     disagree about which one they honour. -->
<body style="margin:0;padding:0;background:#ffffff;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
  <tr>
    <td align="center" style="padding:24px 10px;">
      <table role="presentation" class="m-wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #ebebe8;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <tr>
          <td style="padding:30px 32px 0;">

            <!-- Brand block: the header lockup on the left, the order reference on the right,
                 on one row. The wordmark is part of the artwork, so no name is set beneath it. -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td valign="middle" style="padding-bottom:22px;">
                  <img class="m-logo" src="${BRAND_LOGO_URL}" width="160" alt="Banarasi Kala" style="display:block;width:160px;max-width:160px;height:auto;border:0;" />
                </td>
                ${orderNumber ? `<td valign="middle" align="right" style="padding-bottom:22px;text-align:right;font-size:12px;color:#9aa0a6;letter-spacing:0.08em;text-transform:uppercase;">
                  ORDER ${orderNumber}${placedLabel ? `<br /><span style="font-size:11px;letter-spacing:0.04em;">${placedLabel}</span>` : ''}
                </td>` : ''}
              </tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="left" style="text-align:left;">
                  ${banner}
                  <div class="m-h1" style="font-size:24px;font-weight:700;color:#222;padding:${banner ? '6px' : '18px'} 0 8px;text-align:left;">${heading}</div>
                  <div style="font-size:14px;color:#6b7177;line-height:1.6;padding-bottom:24px;text-align:left;">${intro}</div>
                  ${ctaLabel ? `<a class="m-btn" href="${ctaUrl}" style="display:inline-block;background:#800020;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:14px 28px;border-radius:6px;">${ctaLabel}</a>` : ''}
                  <div style="font-size:13px;color:#6b7177;padding:14px 0 28px;text-align:left;">
                    or <a href="${storeUrl}" style="color:#800020;">Visit our store</a>
                  </div>
                </td>
              </tr>
            </table>

            ${body}

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e8e8e6;margin-top:8px;">
              <tr>
                <td align="center" style="text-align:center;padding:20px 0 30px;font-size:12px;color:#6b7177;line-height:1.7;">
                  If you have any questions, reply to this email or contact us at<br />
                  <a href="mailto:${supportEmail}" style="color:#800020;">${supportEmail}</a>
                </td>
              </tr>
            </table>

          </td>
        </tr>
      </table>
      <div style="font-size:11px;color:#9aa0a6;padding:16px 10px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        &copy; ${new Date().getFullYear()} <span class="brand-name" style="font-family:'Cinzel',Georgia,serif;letter-spacing:0.04em;">Banarasi Kala</span> &middot; Handwoven in Varanasi
        ${unsubscribeUrl ? `<br /><span style="display:inline-block;padding-top:8px;">You are receiving this because you asked us to email you.<br />
        <a href="${unsubscribeUrl}" style="color:#6b7177;text-decoration:underline;">Unsubscribe or manage your email preferences</a></span>` : ''}
      </div>
    </td>
  </tr>
</table>
</body>
</html>`;

/**
 * RFC 8058 / RFC 2369 headers. Gmail and Outlook render their own "Unsubscribe" control next
 * to the sender when these are present, which is both what subscribers reach for first and
 * what the mailbox providers grade sender reputation on — a visible unsubscribe is what stops
 * people reporting the mail as spam instead.
 */
const listUnsubscribeHeaders = (toEmail) => {
  const url = buildPreferenceUrl(toEmail);
  if (!url) return undefined;
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
};

/** Rupees, always two decimals. A blank cell on a receipt reads as "we don't know". */
const money = (value) => `Rs. ${Number(value || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`;

/** One line of a totals block. `strong` is reserved for the figure being totalled. */
const totalsRow = (label, value, { strong = false, muted = false, credit = false } = {}) => `
  <tr>
    <td style="padding:${strong ? '13px 0 4px' : '5px 0'};font-size:${strong ? '15px' : '13px'};color:${muted ? '#6b7177' : '#333'};font-weight:${strong ? '700' : '400'};">${label}</td>
    <td style="padding:${strong ? '13px 0 4px' : '5px 0'};font-size:${strong ? '17px' : '13px'};color:${credit ? '#0f7a5a' : muted ? '#6b7177' : '#333'};font-weight:${strong ? '700' : '400'};text-align:right;white-space:nowrap;">${value}</td>
  </tr>`;

/** The product lines. `struck` greys them out — used when the order was cancelled. */
const itemRowsHtml = (items = [], { struck = false } = {}) => (items || []).map((item) => {
  const qty = Number(item.quantity || 1);
  const lineTotal = Number(item.price || 0) * qty;
  // Live product MRP, passed through from the controller; only shown when it is genuinely higher.
  const lineMrp = Number(item.mrp_price || 0) * qty;
  const image = item.image || item.image_url || '';
  const dim = struck ? 'opacity:0.6;' : '';
  return `
    <tr>
      <td style="padding:0 0 18px;vertical-align:top;width:72px;${dim}">
        ${image
    ? `<img src="${esc(image)}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #e3e3e3;" />`
    : '<div style="width:64px;height:64px;border-radius:8px;border:1px solid #e3e3e3;background:#f4f4f4;"></div>'}
      </td>
      <td style="padding:0 12px 18px;vertical-align:top;font-size:14px;color:#333;line-height:1.5;${dim}">
        ${struck ? `<s style="color:#9aa0a6;">${esc(item.name || 'Saree')}</s>` : esc(item.name || 'Saree')}
        <div style="font-size:12px;color:#6b7177;padding-top:3px;">
          Qty ${qty}${item.sku ? ` &middot; ${esc(item.sku)}` : ''}
        </div>
      </td>
      <td style="padding:0 0 18px;vertical-align:top;text-align:right;font-size:14px;color:#333;white-space:nowrap;${dim}">
        ${lineMrp > lineTotal ? `<span style="color:#9aa0a6;font-size:12px;font-weight:400;">MRP: <s>${money(lineMrp)}</s></span><br />` : ''}${money(lineTotal)}
      </td>
    </tr>`;
}).join('');

/** Two-up address / info column. Stacks full width on mobile via .m-stack. */
const infoColumn = (heading, lines) => {
  const body = (Array.isArray(lines) ? lines : [lines]).filter(Boolean).map((l) => esc(l)).join('<br />');
  if (!body) return '';
  return `
    <td class="m-stack" width="50%" style="vertical-align:top;padding:0 14px 14px 0;font-size:13px;color:#6b7177;line-height:1.6;">
      <div style="font-size:13px;font-weight:700;color:#333;margin-bottom:6px;">${heading}</div>
      ${body}
    </td>`;
};

const addressLines = (address) => (address ? [
  address.name, address.line, address.city,
  [address.pincode, address.state].filter(Boolean).join(' '),
  address.country || 'India',
  address.phone ? `Phone: ${address.phone}` : '',
] : []);

const sectionHeading = (text) => `<div style="border-top:1px solid #e8e8e6;margin-top:22px;padding-top:22px;font-size:15px;font-weight:700;color:#222;padding-bottom:16px;">${text}</div>`;

/**
 * Everyone who should hear about an order, in the order they are told.
 *
 * An order can be placed for somebody else — checkout captures a receiver email on the
 * delivery address, defaulted to the shopper's own. Both people need every update: the
 * buyer because they paid for it, the receiver because it is arriving at their door and
 * they are the one who will be asked to take delivery.
 *
 * The dedupe is the whole point of routing through here. On the overwhelming majority of
 * orders the receiver IS the buyer, and sending "your order" and "someone sent you an
 * order" to the same inbox, two minutes apart, about the same parcel, would be worse than
 * not having the feature. So: at most two entries, never the same mailbox twice, and the
 * buyer always first.
 *
 * @returns {Array<{email: string, isReceiver: boolean}>}
 */
const orderRecipients = (buyerEmail, receiverEmail) => {
  const buyer = normalizeEmail(buyerEmail);
  const receiver = normalizeEmail(receiverEmail);
  const recipients = [];
  if (buyer) recipients.push({ email: buyer, isReceiver: false });
  if (receiver && receiver !== buyer) recipients.push({ email: receiver, isReceiver: true });
  return recipients;
};

/**
 * Who to greet on each copy — the buyer and the receiver, told apart properly.
 *
 * `orders.customer_name` is NOT the buyer's name. It is whatever was typed into the
 * delivery address, which on an order sent to someone else is the RECEIVER. Greeting the
 * buyer with it produced two emails that both opened "Hi <receiver>", and a receiver copy
 * that read "<receiver> has sent you an order" — the buyer's own name never appeared on
 * either. The buyer's real name lives on their account row, so that is where it is read
 * from, with the address name as the fallback for a guest who has no account.
 *
 * sendOrderStatusUpdate is reached from five call sites across three controllers, none of
 * which has an address or a customer to hand — a cancellation fires from a controller
 * holding an order row and nothing else. Rather than make all five fetch and pass them (the
 * same queries written five times, and a sixth caller added later would silently stop
 * mailing the receiver), the email looks them up itself, as it already does for the items.
 */
const loadOrderContacts = async (order) => {
  const contacts = { receiverEmail: null, receiverName: '', buyerName: order?.customer_name || '' };
  if (!order?.id) return contacts;

  try {
    const address = await OrderAddress.findOne({
      where: { order_id: order.id, is_current: true },
      attributes: ['email', 'name'],
    });
    contacts.receiverEmail = normalizeEmail(address?.email);
    contacts.receiverName = address?.name || '';
  } catch (error) {
    // Never lose the buyer's notification over the receiver's copy.
    console.error('EmailService: could not load receiver address:', error.message);
  }

  try {
    const where = order.customer_id
      ? { id: order.customer_id }
      : (normalizeEmail(order.customer_email) ? { email: order.customer_email } : null);
    if (where) {
      const customer = await Customer.findOne({ where, attributes: ['name'] });
      if (customer?.name) contacts.buyerName = customer.name;
    }
  } catch (error) {
    // Falls back to the address name — a slightly-off greeting beats no email.
    console.error('EmailService: could not load buyer name:', error.message);
  }

  return contacts;
};

class EmailService {
  generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  /**
   * Order confirmation.
   *
   * Amounts are all resolved by the CALLER and passed in `summary`; this method formats and
   * never computes. Recomputing a total from the line items here would give the customer a
   * second, independently-derived figure, and the day the two disagree is the day someone is
   * looking at a receipt that contradicts what their card was charged.
   *
   * Sent to the buyer and, when the order was placed for someone else, to the receiver as
   * well — one build of the receipt, addressed twice. See orderRecipients.
   *
   * @param {object} order   The order row (order_number, customer_name/email, payment_method).
   * @param {Array}  items   [{ name, quantity, price, image, sku }]
   * @param {object} summary Every money line, already resolved, plus `receiverEmail`.
   */
  async sendOrderConfirmation(order, items = [], summary = {}) {
    const recipients = orderRecipients(order?.customer_email, summary?.receiverEmail);
    if (recipients.length === 0) return;

    const orderNumber = order.order_number || `#${order.id ?? ''}`;
    const storeUrl = (config.frontendUrl || '').replace(/\/$/, '');
    const supportEmail = config.supportEmail || config.emailUser;

    const {
      subtotal = 0, mrpTotal = 0, couponDiscount = 0, couponCode = '',
      shipping = 0, shippingWaived = 0,
      platformFee = 0, codFee = 0, giftCharge = 0,
      prepaidDiscount = 0, walletUsed = 0, tax = 0,
      total = order.total_amount ?? 0, paidToday = null, saved = 0,
      shippingAddress = null, billingAddress = null,
      paymentLabel = order.payment_method || '', shippingMethod = '',
      placedAt = order.createdAt || null,
    } = summary;

    const isCod = String(order.payment_method || '').toUpperCase() === 'COD';
    // COD pays nothing up front, so "Total paid today" is 0 — the line exists precisely to
    // make that unambiguous rather than leaving the customer to infer it.
    const paidNow = paidToday === null ? (isCod ? 0 : total) : paidToday;

    /**
     * The totals, mirroring what the ledger stores.
     *
     * A line appears only when non-zero, EXCEPT delivery — always shown, and saying "FREE"
     * rather than "0.00" when it was waived. A receipt that silently omits delivery leaves
     * the customer wondering whether a charge is still coming; saying FREE is the whole
     * point of having waived it.
     */
    const lines = [
      totalsRow('Subtotal', mrpTotal > subtotal
        ? `<span style="color:#9aa0a6;font-weight:400;">MRP: <s>${money(mrpTotal)}</s></span> ${money(subtotal)}`
        : money(subtotal)),
      couponDiscount > 0
        ? totalsRow(`Discount${couponCode ? ` (${esc(couponCode)})` : ''}`, `-${money(couponDiscount)}`, { credit: true })
        : '',
      shipping > 0
        ? totalsRow('Delivery', money(shipping))
        : totalsRow('Delivery', shippingWaived > 0
          ? `<s style="color:#9aa0a6;font-weight:400;">${money(shippingWaived)}</s> <span style="color:#0f7a5a;">FREE</span>`
          : '<span style="color:#0f7a5a;">FREE</span>'),
      platformFee > 0 ? totalsRow('Platform fee', money(platformFee)) : '',
      codFee > 0 ? totalsRow('Cash on Delivery fee', money(codFee)) : '',
      giftCharge > 0 ? totalsRow('Gift packaging', money(giftCharge)) : '',
      prepaidDiscount > 0 ? totalsRow('Prepaid discount', `-${money(prepaidDiscount)}`, { credit: true }) : '',
      tax > 0 ? totalsRow('Taxes', money(tax)) : '',
      walletUsed > 0 ? totalsRow('Wallet credit used', `-${money(walletUsed)}`, { credit: true }) : '',
    ].filter(Boolean).join('');

    /**
     * Two address columns only when there are genuinely two addresses.
     *
     * Nothing was ever passed for billing, so the template fell back to `billingAddress ||
     * shippingAddress` and printed the same lines under both headings on every receipt ever
     * sent. A pair of columns that always agree teaches the reader the pair means nothing,
     * which is worse than not showing it: on the one order where they DO differ, nobody
     * looks. So the columns collapse to a single "Delivery address" when the buyer is being
     * billed where the parcel is going, and split into "Delivery address" / "Billed to" only
     * when the order is being sent somewhere else.
     */
    const sameAddress = !billingAddress || (
      String(billingAddress.line || '').trim() === String(shippingAddress?.line || '').trim()
      && String(billingAddress.pincode || '') === String(shippingAddress?.pincode || '')
    );
    const addressColumns = sameAddress
      ? infoColumn('Delivery address', addressLines(shippingAddress))
      : `${infoColumn('Delivery address', addressLines(shippingAddress))}${infoColumn('Billed to', addressLines(billingAddress))}`;

    // Identical on both copies. The receiver's framing is carried entirely by the heading
    // and the opening line — a panel below them repeating it just said the same thing twice.
    const body = `
            <div style="border-top:1px solid #e8e8e6;padding-top:22px;font-size:15px;font-weight:700;color:#222;padding-bottom:18px;">Order summary</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRowsHtml(items)}</table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e8e8e6;">
              <tr><td style="padding-top:12px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${lines}</table>
              </td></tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e8e8e6;margin-top:8px;">
              <tr><td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  ${totalsRow(isCod ? 'Total (pay on delivery)' : 'Total', money(total), { strong: true })}
                  ${saved > 0 ? `<tr><td colspan="2" style="text-align:right;font-size:12px;color:#0f7a5a;font-weight:600;padding-bottom:8px;">You saved ${money(saved)}</td></tr>` : ''}
                  ${totalsRow('Total paid today', money(paidNow), { muted: true })}
                </table>
              </td></tr>
            </table>

            ${sectionHeading('Customer information')}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                ${addressColumns}
              </tr>
              <tr>
                ${infoColumn('Payment', paymentLabel)}
                ${infoColumn('Shipping method', shippingMethod)}
              </tr>
            </table>`;

    /**
     * The buyer, from `summary.buyerName` — their ACCOUNT name.
     *
     * Not `order.customer_name`: that field holds the delivery name, which on an order sent
     * to someone else is the receiver. Using it greeted the buyer with the receiver's name
     * and produced "<receiver> has sent you an order" on the receiver's own copy.
     */
    const buyerName = summary.buyerName || order.customer_name || 'A friend';
    const receiverName = shippingAddress?.name || '';
    const placedLabel = placedAt
      ? esc(new Date(placedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }))
      : '';

    /**
     * The receiver gets no "View your order" button.
     *
     * The order page is gated on the BUYER's login (OrderController checks the signed-in
     * email against the order's), so that button would take the receiver to a 403 — worse
     * than no button at all. Their updates arrive by email instead, which is the whole
     * arrangement. The shell still offers "Visit our store" beneath, as it does on the
     * OTP mail that likewise has no action to take.
     */
    const mailFor = ({ isReceiver }) => ({
      from: `"Banarasi Kala" <${config.emailUser}>`,
      replyTo: supportEmail,
      subject: isReceiver
        ? `${buyerName} has sent you an order | Banarasi Kala`
        : `Order ${orderNumber} confirmed | Banarasi Kala`,
      html: emailShell({
        orderNumber: esc(orderNumber),
        placedLabel,
        heading: isReceiver ? `${esc(buyerName)} has sent you an order` : 'Thank you for your purchase!',
        intro: isReceiver
          ? `Hi ${esc(receiverName || 'there')}, <strong>${esc(buyerName)}</strong> has placed an order for you at Banarasi Kala. We&rsquo;re getting it ready to be shipped to your address, and we will let you know the moment it is on its way.`
          : `Hi ${esc(buyerName)}, we&rsquo;re getting your order ready to be shipped. We will notify you when it has been sent.`,
        ctaLabel: isReceiver ? '' : 'View your order',
        ctaUrl: isReceiver ? '' : `${storeUrl}/order-confirmation?orderId=${order.id ?? ''}`,
        body,
        supportEmail: esc(supportEmail),
        storeUrl: esc(storeUrl),
        preheader: isReceiver
          ? `${esc(buyerName)} has sent you an order &middot; ${esc(orderNumber)}`
          : `Order ${esc(orderNumber)} confirmed &middot; ${money(total)}`,
      }),
    });

    // Sequential, and each send guarded on its own: a bounce at the receiver's address must
    // not cost the buyer the receipt for what they just paid for.
    for (const recipient of recipients) {
      try {
        await transporter.sendMail({ ...mailFor(recipient), to: recipient.email });
        console.log(`Order confirmation email sent to ${recipient.email}${recipient.isReceiver ? ' (receiver)' : ''}`);
      } catch (error) {
        console.error(`Error sending order confirmation email to ${recipient.email}:`, error);
      }
    }
  }

  /**
   * A status change the customer is emailed about.
   *
   * ── Why the allowlist lives here ────────────────────────────────────────────────────────
   * Five call sites across three controllers reach this method, and an order moves through a
   * dozen states on its way to the door — AWB assigned, picked up, in transit, out for
   * delivery, return initiated, RTO. Mailing each one buried the two that matter in a stream
   * of notifications nobody asked for, and the customer can see every one of them on the
   * order page whenever they care to look.
   *
   * Gating at the call sites would mean the rule was written out five times, and a sixth
   * caller added later would silently reintroduce the spam. Here it is one rule no caller can
   * bypass, so this list IS the policy.
   *
   * Cancellation and delivery stay because both are terminal and both need an action or a
   * reassurance: a cancellation carries refund consequences, and a delivery notice is what a
   * customer checks against when a parcel is marked delivered but is not on the doorstep.
   */
  static EMAILED_STATUSES = new Set(['Cancelled', 'Delivered']);

  async sendOrderStatusUpdate(order, status) {
    try {
      const normalizedStatus = String(status || order?.status || 'Updated').trim();
      if (!EmailService.EMAILED_STATUSES.has(normalizedStatus)) return;

      // Looked up here for the same reason the items below are — no caller has them.
      const contacts = await loadOrderContacts(order);
      const recipients = orderRecipients(order?.customer_email, contacts.receiverEmail);
      if (recipients.length === 0) return;

      const isCancelled = normalizedStatus === 'Cancelled';
      const orderNumber = order.order_number || `#${order.id ?? ''}`;
      const storeUrl = (config.frontendUrl || 'https://banarasikala.com').replace(/\/$/, '');
      const supportEmail = config.supportEmail || config.emailUser;
      const isCod = String(order.payment_method || '').toUpperCase() === 'COD';

      /**
       * The items, read here rather than passed in.
       *
       * This method is reached from five places, none of which has the line items to hand —
       * a cancellation fires from a controller holding an order row and nothing else. Making
       * every caller fetch and pass them would be the same query written five times, so the
       * email fetches what it needs and stays self-sufficient.
       */
      let items = [];
      if (order.id) {
        try {
          const rows = await OrderItem.findAll({
            where: { order_id: order.id },
            include: [{ model: Product, attributes: ['id', 'name', 'images'] }],
          });
          items = rows.map((row) => ({
            name: row.product_name || row.Product?.name || 'Saree',
            quantity: row.quantity,
            price: Number(row.price || 0),
            sku: row.sku,
            image: pickOrderItemImage(row.Product, row.colorId || row.color_id),
          }));
        } catch (error) {
          // A missing thumbnail is not worth losing the notification over.
          console.error('EmailService: could not load items for status email:', error.message);
        }
      }

      const goodsTotal = items.reduce((n, i) => n + Number(i.price || 0) * Number(i.quantity || 1), 0);

      /**
       * The banner. Colour carries the outcome before a word is read — green for delivered,
       * a muted red for cancelled — which is the whole reason a status mail differs from a
       * receipt at a glance.
       */
      const tone = isCancelled
        ? { bg: '#fdecef', border: '#f3c4cd', text: '#93233c', label: 'Order cancelled' }
        : { bg: '#e9f7ef', border: '#b7e2c8', text: '#12673a', label: 'Order delivered' };

      const banner = `<div style="display:inline-block;background:${tone.bg};border:1px solid ${tone.border};color:${tone.text};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;padding:7px 16px;border-radius:999px;margin-top:24px;">${tone.label}</div>`;

      // Account name, not the delivery name — see loadOrderContacts.
      const buyerName = contacts.buyerName || 'A friend';
      const receiverName = contacts.receiverName || '';

      /**
       * The same event, told from each side.
       *
       * The refund sentences only ever go to the buyer: they are the one who paid and the
       * one the money is going back to. Telling the receiver their refund is on its way
       * would be wrong twice over — it is not their refund, and it invites them to go
       * looking for money in their bank account that was never theirs.
       */
      const headingFor = (isReceiver) => {
        if (isCancelled) {
          return isReceiver
            ? `The order ${esc(buyerName)} sent you has been cancelled`
            : 'Your order has been cancelled';
        }
        return isReceiver
          ? `The order ${esc(buyerName)} sent you has been delivered`
          : 'Your order has been delivered';
      };

      const introFor = (isReceiver) => {
        if (isCancelled) {
          return isReceiver
            ? `Hi ${esc(receiverName || 'there')}, order <strong>${esc(orderNumber)}</strong>, which <strong>${esc(buyerName)}</strong> placed for you, has been cancelled. Nothing will now be delivered to your address.`
            : `Hi ${esc(buyerName)}, order <strong>${esc(orderNumber)}</strong> has been cancelled.${
              isCod
                ? ' Nothing was charged for this order, so there is no refund to process.'
                : ' Your refund has been initiated and will reach the original payment method in 5&ndash;7 working days.'}`;
        }
        return isReceiver
          ? `Hi ${esc(receiverName || 'there')}, order <strong>${esc(orderNumber)}</strong> from <strong>${esc(buyerName)}</strong> has been delivered to your address. We hope it brings a little Banaras into your day.`
          : `Hi ${esc(buyerName)}, order <strong>${esc(orderNumber)}</strong> has been delivered. We hope it brings a little Banaras into your day.`;
      };

      /**
       * Cancelled lines are struck through and dimmed.
       *
       * The items still belong in the email — "which order was that?" is the first question a
       * cancellation raises — but showing them at full strength reads as a receipt for goods
       * that are on their way, which is the opposite of what happened.
       */
      const body = (isReceiver) => `
            <div style="border-top:1px solid #e8e8e6;padding-top:22px;font-size:15px;font-weight:700;color:#222;padding-bottom:18px;">${isCancelled ? 'Cancelled items' : 'Your order'}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRowsHtml(items, { struck: isCancelled })}</table>

            ${goodsTotal > 0 ? `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e8e8e6;">
              <tr><td style="padding-top:12px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  ${totalsRow(isCancelled ? 'Order value' : 'Order total', money(goodsTotal), { strong: true })}
                  ${isCancelled && !isCod && !isReceiver
    ? totalsRow('Refund status', '<span style="color:#0f7a5a;">Initiated</span>', { muted: true })
    : ''}
                  ${isCancelled && isCod && !isReceiver
    ? totalsRow('Amount charged', money(0), { muted: true })
    : ''}
                </table>
              </td></tr>
            </table>` : ''}

            ${isCancelled ? `
            <div style="margin-top:22px;padding:16px 18px;background:#faf8f6;border:1px solid #eee7e0;border-radius:8px;font-size:13px;color:#6b7177;line-height:1.7;">
              ${isReceiver
    ? `Nothing was charged to you for this order &mdash; ${esc(buyerName)} arranged it, and anything owed goes back to them. Do reply to this email if you were expecting the parcel and would like our help.`
    : isCod
      ? 'This was a Cash on Delivery order, so no money changed hands. You can reorder any time from our store.'
      : 'Refunds are returned to the original payment method. Bank processing times vary, so allow up to 7 working days before raising it with us.'}
            </div>` : ''}`;

      // As on the confirmation: no order-page button for the receiver, whose email address
      // does not open the buyer's order.
      const mailFor = ({ isReceiver }) => ({
        from: `"Banarasi Kala" <${config.emailUser}>`,
        replyTo: supportEmail,
        subject: isCancelled
          ? `Order ${orderNumber} cancelled | Banarasi Kala`
          : `Order ${orderNumber} delivered | Banarasi Kala`,
        html: emailShell({
          orderNumber: esc(orderNumber),
          placedLabel: order.createdAt
            ? esc(new Date(order.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }))
            : '',
          heading: headingFor(isReceiver),
          intro: introFor(isReceiver),
          ctaLabel: isReceiver ? '' : 'View your order',
          ctaUrl: isReceiver
            ? ''
            : (order.id ? `${storeUrl}/order-confirmation?orderId=${order.id}` : `${storeUrl}/my-orders`),
          banner,
          body: body(isReceiver),
          supportEmail: esc(supportEmail),
          storeUrl: esc(storeUrl),
          preheader: isCancelled
            ? `Order ${esc(orderNumber)} cancelled${isCod || isReceiver ? '' : ' &middot; refund initiated'}`
            : `Order ${esc(orderNumber)} delivered`,
        }),
      });

      for (const recipient of recipients) {
        try {
          await transporter.sendMail({ ...mailFor(recipient), to: recipient.email });
          console.log(`Order status update email sent to ${recipient.email}${recipient.isReceiver ? ' (receiver)' : ''} for status: ${normalizedStatus}`);
        } catch (error) {
          console.error(`Error sending order status email to ${recipient.email}:`, error);
        }
      }
    } catch (error) {
      console.error('Error sending order status email:', error);
    }
  }

  async sendEmailVerification(email, name, verificationUrl) {
    const supportEmail = config.supportEmail || config.emailUser;
    const storeUrl = (config.frontendUrl || 'https://banarasikala.com').replace(/\/$/, '');

    const mailOptions = {
      from: `"Banarasi Kala" <${config.emailUser}>`,
      to: email,
      replyTo: supportEmail,
      subject: 'Verify your email address | Banarasi Kala',
      html: emailShell({
        // The shell prints this as the order reference to the right of the logo. There is no
        // order here, so it is left empty and that corner simply stays blank.
        orderNumber: '',
        heading: 'Verify your email address',
        intro: `Hi ${esc(name || 'there')}, thank you for registering with us. Confirm your address to finish setting up your account.`,
        ctaLabel: 'Verify my email',
        ctaUrl: esc(verificationUrl),
        body: `
            <div style="border-top:1px solid #e8e8e6;padding:20px 0 4px;font-size:13px;color:#6b7177;line-height:1.7;text-align:center;">
              This link is valid for 30 minutes.<br />
              If you did not create an account with us, you can safely ignore this email.
            </div>`,
        supportEmail: esc(supportEmail),
        storeUrl: esc(storeUrl),
        preheader: 'Confirm your email address to finish setting up your Banarasi Kala account.',
      }),
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Verification email sent to ${email}`);
    } catch (error) {
      console.error('Error sending verification email:', error);
    }
  }

  async sendOTP(email, otp, name) {
    const supportEmail = config.supportEmail || config.emailUser;
    const storeUrl = (config.frontendUrl || 'https://banarasikala.com').replace(/\/$/, '');

    const mailOptions = {
      from: `"Banarasi Kala" <${config.emailUser}>`,
      to: email,
      replyTo: supportEmail,
      subject: 'Your verification code | Banarasi Kala',
      html: emailShell({
        orderNumber: '',
        heading: 'Your verification code',
        intro: `Hi ${esc(name || 'there')}, use the code below to verify your email address.`,
        // No CTA: the action is typing the code into the tab they already have open, and a
        // button here would send them somewhere they do not need to go.
        ctaLabel: '',
        body: `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="text-align:center;padding-bottom:20px;">
                  <div style="display:inline-block;font-size:32px;font-weight:700;letter-spacing:0.34em;color:#800020;background:#faf8f6;border:1px dashed #d9c9a3;border-radius:8px;padding:16px 14px 16px 24px;">${esc(otp)}</div>
                </td>
              </tr>
            </table>
            <div style="border-top:1px solid #e8e8e6;padding:20px 0 4px;font-size:13px;color:#6b7177;line-height:1.7;text-align:center;">
              This code is valid for 10 minutes.<br />
              If you did not request it, you can safely ignore this email.
            </div>`,
        supportEmail: esc(supportEmail),
        storeUrl: esc(storeUrl),
        preheader: `Your Banarasi Kala verification code is ${esc(otp)}`,
      }),
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`OTP email sent to ${email}`);
    } catch (error) {
      console.error('Error sending OTP email:', error);
    }
  }

  /**
   * "It's back in stock" — sent to a customer who asked to be notified, when the admin restocks
   * the product and triggers the send from the Products screen.
   */
  async sendBackInStock(toEmail, name, product) {
    if (!toEmail) return;
    const supportEmail = config.supportEmail || config.emailUser;
    const storeUrl = (config.frontendUrl || 'https://banarasikala.com').replace(/\/$/, '');
    const productUrl = product?.slug ? `${storeUrl}/product/${product.slug}` : `${storeUrl}/collection`;

    const images = Array.isArray(product?.images) ? product.images : [];
    const cover = images.find((i) => i.is_cover) || images[0] || null;
    const imageUrl = cover?.url || cover?.image_url || '';
    const sell = Number(product?.selling_price || 0);
    const mrp = Number(product?.mrp_price || 0);

    const body = `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e8e8e6;margin-top:8px;">
              <tr><td style="padding-top:22px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    ${imageUrl ? `<td width="96" valign="top" style="padding-right:16px;">
                      <img src="${esc(imageUrl)}" width="96" alt="${esc(product?.name || '')}" style="display:block;width:96px;height:auto;border-radius:8px;border:1px solid #eee;" />
                    </td>` : ''}
                    <td valign="top">
                      <div style="font-size:15px;font-weight:700;color:#222;line-height:1.4;">${esc(product?.name || 'Your saree')}</div>
                      ${sell > 0 ? `<div style="font-size:14px;color:#800020;font-weight:700;padding-top:6px;">${money(sell)}${mrp > sell ? ` <span style="color:#9aa0a6;font-weight:400;text-decoration:line-through;">${money(mrp)}</span>` : ''}</div>` : ''}
                    </td>
                  </tr>
                </table>
              </td></tr>
            </table>`;

    const mailOptions = {
      from: `"Banarasi Kala" <${config.emailUser}>`,
      to: toEmail,
      replyTo: supportEmail,
      subject: `Back in stock: ${product?.name || 'the saree you wanted'} | Banarasi Kala`,
      html: emailShell({
        orderNumber: '',
        heading: 'It’s back in stock!',
        intro: `Hi ${esc(name || 'there')}, good news — <strong>${esc(product?.name || 'the piece you wanted')}</strong> is available again. Our handwoven pieces are limited, so we’d hate for you to miss it a second time.`,
        ctaLabel: 'Shop it now',
        ctaUrl: esc(productUrl),
        body,
        supportEmail: esc(supportEmail),
        storeUrl: esc(storeUrl),
        preheader: `${product?.name || 'The saree you wanted'} is back in stock.`,
        unsubscribeUrl: esc(buildPreferenceUrl(toEmail) || ''),
      }),
      headers: listUnsubscribeHeaders(toEmail),
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Back-in-stock email sent to ${toEmail}`);
    } catch (error) {
      console.error('Error sending back-in-stock email:', error);
    }
  }

  /**
   * One campaign email to one subscriber. Throws on failure rather than swallowing it, because
   * the caller counts successes and failures across the batch — a silent catch here would
   * report every send as delivered.
   */
  async sendNewsletterCampaign(toEmail, campaign) {
    if (!toEmail) throw new Error('No recipient');
    const supportEmail = config.supportEmail || config.emailUser;
    const storeUrl = (config.frontendUrl || 'https://banarasikala.com').replace(/\/$/, '');

    // Author-written copy, so newlines become paragraphs and everything is escaped — a stray
    // angle bracket in the intro must never be able to break the surrounding markup.
    const paragraphs = String(campaign.body || '')
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => `<p style="margin:0 0 14px;font-size:14px;color:#3a241b;line-height:1.7;">${esc(block).replace(/\n/g, '<br />')}</p>`)
      .join('');

    // A feature mail (exclusive pick / new arrival) carries the saree's photograph; a coupon
    // or manual campaign has none and simply omits the block.
    const hero = campaign.image_url
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
           <tr><td style="padding-top:22px;">
             <img src="${esc(campaign.image_url)}" width="536" alt="${esc(campaign.heading || '')}" style="display:block;width:100%;max-width:536px;height:auto;border-radius:10px;border:1px solid #eee;" />
           </td></tr>
         </table>`
      : '';

    const body = (hero || paragraphs)
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e8e8e6;margin-top:8px;">
           <tr><td style="padding-top:${hero ? '0' : '22px'};">${hero}${paragraphs ? `<div style="padding-top:22px;">${paragraphs}</div>` : ''}</td></tr>
         </table>`
      : '';

    await transporter.sendMail({
      from: `"Banarasi Kala" <${config.emailUser}>`,
      to: toEmail,
      replyTo: supportEmail,
      subject: campaign.subject,
      html: emailShell({
        heading: esc(campaign.heading),
        intro: esc(campaign.intro).replace(/\n/g, '<br />'),
        ctaLabel: campaign.cta_label ? esc(campaign.cta_label) : '',
        ctaUrl: campaign.cta_url ? esc(campaign.cta_url) : '',
        body,
        supportEmail: esc(supportEmail),
        storeUrl: esc(storeUrl),
        preheader: esc(campaign.intro).slice(0, 140),
        unsubscribeUrl: esc(buildPreferenceUrl(toEmail) || ''),
      }),
      headers: listUnsubscribeHeaders(toEmail),
    });
  }

  /**
   * Confirms a newsletter signup — and is the vehicle that puts a working unsubscribe link in
   * the subscriber's hands immediately, rather than making them wait for the first campaign.
   */
  async sendNewsletterWelcome(toEmail) {
    if (!toEmail) return;
    const supportEmail = config.supportEmail || config.emailUser;
    const storeUrl = (config.frontendUrl || 'https://banarasikala.com').replace(/\/$/, '');

    const mailOptions = {
      from: `"Banarasi Kala" <${config.emailUser}>`,
      to: toEmail,
      replyTo: supportEmail,
      subject: 'You are on the list | Banarasi Kala',
      html: emailShell({
        heading: 'Welcome to Banarasi Kala',
        intro: 'Thank you for subscribing. You will be among the first to hear about new arrivals, exclusive pieces and offers — and we will only write when there is something worth your time.',
        ctaLabel: 'Explore the collection',
        ctaUrl: esc(`${storeUrl}/collection`),
        supportEmail: esc(supportEmail),
        storeUrl: esc(storeUrl),
        preheader: 'You are subscribed to Banarasi Kala.',
        unsubscribeUrl: esc(buildPreferenceUrl(toEmail) || ''),
      }),
      headers: listUnsubscribeHeaders(toEmail),
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Newsletter welcome email sent to ${toEmail}`);
    } catch (error) {
      console.error('Error sending newsletter welcome email:', error);
    }
  }
}

module.exports = new EmailService();