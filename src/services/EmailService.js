const nodemailer = require('nodemailer');
const dns = require('dns');
const { config } = require('../config/env');
const OrderItem = require('../models/OrderItem');
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
 * An email is opened outside our network, often months later, so the image URL has to be
 * absolute, public and permanent. `config.frontendUrl` is neither in development (localhost,
 * which resolves to the reader's own machine) nor reliably cached in production, and an
 * attachment would show as a paperclip on every receipt. Cloudinary is already the image
 * host for everything else here.
 */
const BRAND_LOGO_URL = 'https://res.cloudinary.com/drvmplgnr/image/upload/v1784809969/vns-saree/brand/email-logo.png';

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
    .m-h1    { font-size:19px !important; }
    .m-logo  { width:112px !important; height:auto !important; }
    .brand-name { font-size:19px !important; letter-spacing:0.1em !important; }
    .m-btn   { display:block !important; text-align:center !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f6f6f4;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4;">
  <tr>
    <td align="center" style="padding:24px 10px;">
      <table role="presentation" class="m-wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <tr>
          <td style="padding:30px 32px 0;">

            <!-- Brand block: monogram, wordmark beneath, centred. Stacked rather than side by
                 side so the mark can be given real size — beside text it shrinks to the cap
                 height of the name, which is what made it read as a favicon. -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding-bottom:6px;">
                  <img class="m-logo" src="${BRAND_LOGO_URL}" width="132" alt="Banarasi Kala" style="display:block;width:132px;max-width:132px;height:auto;border:0;margin:0 auto;" />
                </td>
              </tr>
              <tr>
                <td align="center" class="brand-name" style="font-family:'Cinzel',Georgia,'Times New Roman',serif;font-size:23px;font-weight:700;letter-spacing:0.14em;color:#800020;text-transform:uppercase;padding-bottom:14px;">
                  Banarasi&nbsp;Kala
                </td>
              </tr>
              ${orderNumber ? `<tr>
                <td align="center" style="border-top:1px solid #e8e8e6;padding-top:12px;font-size:11px;color:#6b7177;letter-spacing:0.05em;">
                  ORDER ${orderNumber}${placedLabel ? ` &middot; ${placedLabel}` : ''}
                </td>
              </tr>` : ''}
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="text-align:center;">
                  ${banner}
                  <div class="m-h1" style="font-size:22px;font-weight:700;color:#222;padding:${banner ? '6px' : '28px'} 0 8px;text-align:center;">${heading}</div>
                  <div style="font-size:14px;color:#6b7177;line-height:1.6;padding-bottom:24px;text-align:center;">${intro}</div>
                  ${ctaLabel ? `<a class="m-btn" href="${ctaUrl}" style="display:inline-block;background:#800020;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:14px 28px;border-radius:6px;">${ctaLabel}</a>` : ''}
                  <div style="font-size:13px;color:#6b7177;padding:12px 0 28px;text-align:center;">
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
      </div>
    </td>
  </tr>
</table>
</body>
</html>`;

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
        ${money(lineTotal)}
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
   * @param {object} order   The order row (order_number, customer_name/email, payment_method).
   * @param {Array}  items   [{ name, quantity, price, image, sku }]
   * @param {object} summary Every money line, already resolved.
   */
  async sendOrderConfirmation(order, items = [], summary = {}) {
    if (!order?.customer_email) return;

    const orderNumber = order.order_number || `#${order.id ?? ''}`;
    const storeUrl = (config.frontendUrl || '').replace(/\/$/, '');
    const supportEmail = config.supportEmail || config.emailUser;

    const {
      subtotal = 0, couponDiscount = 0, couponCode = '',
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
      totalsRow('Subtotal', money(subtotal)),
      couponDiscount > 0
        ? totalsRow(`Discount${couponCode ? ` (${esc(couponCode)})` : ''}`, `-${money(couponDiscount)}`, { credit: true })
        : '',
      shipping > 0
        ? totalsRow('Delivery', money(shipping))
        : totalsRow('Delivery', shippingWaived > 0
          ? `<span style="color:#0f7a5a;">FREE</span> <s style="color:#9aa0a6;font-weight:400;">${money(shippingWaived)}</s>`
          : '<span style="color:#0f7a5a;">FREE</span>'),
      platformFee > 0 ? totalsRow('Platform fee', money(platformFee)) : '',
      codFee > 0 ? totalsRow('Cash on Delivery fee', money(codFee)) : '',
      giftCharge > 0 ? totalsRow('Gift packaging', money(giftCharge)) : '',
      prepaidDiscount > 0 ? totalsRow('Prepaid discount', `-${money(prepaidDiscount)}`, { credit: true }) : '',
      tax > 0 ? totalsRow('Taxes', money(tax)) : '',
      walletUsed > 0 ? totalsRow('Wallet credit used', `-${money(walletUsed)}`, { credit: true }) : '',
    ].filter(Boolean).join('');

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
                ${infoColumn('Shipping address', addressLines(shippingAddress))}
                ${infoColumn('Billing address', addressLines(billingAddress || shippingAddress))}
              </tr>
              <tr>
                ${infoColumn('Payment', paymentLabel)}
                ${infoColumn('Shipping method', shippingMethod)}
              </tr>
            </table>`;

    const mailOptions = {
      from: `"Banarasi Kala" <${config.emailUser}>`,
      to: order.customer_email,
      replyTo: supportEmail,
      subject: `Order ${orderNumber} confirmed | Banarasi Kala`,
      html: emailShell({
        orderNumber: esc(orderNumber),
        placedLabel: placedAt
          ? esc(new Date(placedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }))
          : '',
        heading: 'Thank you for your purchase!',
        intro: `Hi ${esc(order.customer_name || 'there')}, we&rsquo;re getting your order ready to be shipped. We will notify you when it has been sent.`,
        ctaLabel: 'View your order',
        ctaUrl: `${storeUrl}/order-confirmation?orderId=${order.id ?? ''}`,
        body,
        supportEmail: esc(supportEmail),
        storeUrl: esc(storeUrl),
        preheader: `Order ${esc(orderNumber)} confirmed &middot; ${money(total)}`,
      }),
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Order confirmation email sent to ${order.customer_email}`);
    } catch (error) {
      console.error('Error sending order confirmation email:', error);
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
      if (!order?.customer_email) return;
      const normalizedStatus = String(status || order.status || 'Updated').trim();
      if (!EmailService.EMAILED_STATUSES.has(normalizedStatus)) return;

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

      const heading = isCancelled ? 'Your order has been cancelled' : 'Your order has been delivered';
      const intro = isCancelled
        ? `Hi ${esc(order.customer_name || 'there')}, order <strong>${esc(orderNumber)}</strong> has been cancelled.${
          isCod
            ? ' Nothing was charged for this order, so there is no refund to process.'
            : ' Your refund has been initiated and will reach the original payment method in 5&ndash;7 working days.'}`
        : `Hi ${esc(order.customer_name || 'there')}, order <strong>${esc(orderNumber)}</strong> has been delivered. We hope it brings a little Banaras into your day.`;

      /**
       * Cancelled lines are struck through and dimmed.
       *
       * The items still belong in the email — "which order was that?" is the first question a
       * cancellation raises — but showing them at full strength reads as a receipt for goods
       * that are on their way, which is the opposite of what happened.
       */
      const body = `
            <div style="border-top:1px solid #e8e8e6;padding-top:22px;font-size:15px;font-weight:700;color:#222;padding-bottom:18px;">${isCancelled ? 'Cancelled items' : 'Your order'}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRowsHtml(items, { struck: isCancelled })}</table>

            ${goodsTotal > 0 ? `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e8e8e6;">
              <tr><td style="padding-top:12px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  ${totalsRow(isCancelled ? 'Order value' : 'Order total', money(goodsTotal), { strong: true })}
                  ${isCancelled && !isCod
    ? totalsRow('Refund status', '<span style="color:#0f7a5a;">Initiated</span>', { muted: true })
    : ''}
                  ${isCancelled && isCod
    ? totalsRow('Amount charged', money(0), { muted: true })
    : ''}
                </table>
              </td></tr>
            </table>` : ''}

            ${isCancelled ? `
            <div style="margin-top:22px;padding:16px 18px;background:#faf8f6;border:1px solid #eee7e0;border-radius:8px;font-size:13px;color:#6b7177;line-height:1.7;">
              ${isCod
    ? 'This was a Cash on Delivery order, so no money changed hands. You can reorder any time from our store.'
    : 'Refunds are returned to the original payment method. Bank processing times vary, so allow up to 7 working days before raising it with us.'}
            </div>` : ''}`;

      const mailOptions = {
        from: `"Banarasi Kala" <${config.emailUser}>`,
        to: order.customer_email,
        replyTo: supportEmail,
        subject: isCancelled
          ? `Order ${orderNumber} cancelled | Banarasi Kala`
          : `Order ${orderNumber} delivered | Banarasi Kala`,
        html: emailShell({
          orderNumber: esc(orderNumber),
          placedLabel: order.createdAt
            ? esc(new Date(order.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }))
            : '',
          heading,
          intro,
          ctaLabel: 'View your order',
          ctaUrl: order.id ? `${storeUrl}/order-confirmation?orderId=${order.id}` : `${storeUrl}/my-orders`,
          banner,
          body,
          supportEmail: esc(supportEmail),
          storeUrl: esc(storeUrl),
          preheader: isCancelled
            ? `Order ${esc(orderNumber)} cancelled${isCod ? '' : ' &middot; refund initiated'}`
            : `Order ${esc(orderNumber)} delivered`,
        }),
      };

      await transporter.sendMail(mailOptions);
      console.log(`Order status update email sent to ${order.customer_email} for status: ${normalizedStatus}`);
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
        // The shell shows this line under the wordmark. On an order it is the order number;
        // here there is no order, so it names what the mail is instead of printing "ORDER".
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
}

module.exports = new EmailService();