const { config } = require('../config/env');

/**
 * Renders a print-ready A4 tax invoice for a delivered order.
 *
 * Server-rendered HTML rather than a PDF on purpose: no PDF toolchain ships with
 * this server, and the browser's own "Save as PDF" from the print dialog produces
 * the same A4 page. The client fetches this with its auth header and opens it in
 * a new tab, where it auto-prints.
 */

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const toNumber = (value) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
};

const round2 = (value) => Math.round(toNumber(value) * 100) / 100;

const rupees = (value) => `Rs. ${round2(value).toLocaleString('en-IN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})}`;

const formatDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
};

// A cancelled line was never sold — it must not appear on the tax invoice, and
// the money for it was reversed in the ledger.
const isBilledItem = (item) => String(item?.status || '').toLowerCase() !== 'cancelled';

const renderItemRows = (items) => items.map((item, index) => {
  const quantity = Math.max(1, toNumber(item.quantity) || 1);
  const unitPrice = toNumber(item.price);
  const meta = [
    item.color_name && `Colour: ${escapeHtml(item.color_name)}`,
    item.sku && `SKU: ${escapeHtml(item.sku)}`,
  ].filter(Boolean).join(' &nbsp;|&nbsp; ');

  return `
          <tr>
            <td style="color:#9a6030; font-weight:600">${index + 1}</td>
            <td>
              <div class="item-name">${escapeHtml(item.product_name || `Product #${item.product_id}`)}</div>
              ${meta ? `<div class="item-meta">${meta}</div>` : ''}
            </td>
            <td style="text-align:right">${quantity}</td>
            <td style="text-align:right">${rupees(unitPrice)}</td>
            <td>${rupees(unitPrice * quantity)}</td>
          </tr>`;
}).join('');

const renderChargeRow = (label, value, variant = 'light') => (
  toNumber(value) > 0
    ? `
          <tr class="tf-row-${variant}">
            <td colspan="4">${escapeHtml(label)}</td>
            <td>${variant === 'discount' ? `– ${rupees(value)}` : rupees(value)}</td>
          </tr>`
    : ''
);

/**
 * @param {object} order A serialized order (OrderController.serializeOrder shape):
 *   money fields derived from the ledger, address flattened, OrderItems attached.
 */
const renderInvoiceHtml = (order) => {
  const seller = config.invoiceSeller;
  const items = (order.OrderItems || []).filter(isBilledItem);
  const isCod = String(order.payment_method || '').toUpperCase() === 'COD';

  const subtotal = toNumber(order.subtotal_amount);
  const total = toNumber(order.total_amount);
  // The listed price is GST-inclusive, so the tax is carved out of the goods
  // value rather than added on top — the total below is unaffected by it.
  const gstPercent = config.invoiceGstPercent;
  const gstAmount = round2(subtotal - (subtotal / (1 + gstPercent / 100)));

  const invoiceNumber = `INV-${order.order_number || order.id}`;
  const invoiceDate = order.delivered_at || order.createdAt;
  const paymentLabel = isCod ? 'Paid (Cash on Delivery)' : 'Paid (Online)';
  const sellerGstLine = seller.gstin ? `GSTIN: ${escapeHtml(seller.gstin)}<br />` : '';
  const bandGst = seller.gstin ? ` · GSTIN: ${escapeHtml(seller.gstin)}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invoice ${escapeHtml(invoiceNumber)} – Banarasi Kala</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500;600;700&display=swap');

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      font-family: 'Inter', sans-serif;
      background: #f4ede0;
      color: #2a1008;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }

    .page {
      width: 794px;
      min-height: 1123px;
      margin: 24px auto;
      background: #fff;
      box-shadow: 0 4px 40px rgba(80, 20, 5, 0.14);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .inv-header {
      background: linear-gradient(135deg, #6b0018 0%, #a50028 60%, #c4002f 100%);
      padding: 22px 40px 18px;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      flex-shrink: 0;
    }

    .inv-brand-name {
      font-family: 'Cinzel', serif;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 0.06em;
      line-height: 1;
      color: #ffe8b0;
      text-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }

    .inv-brand-tagline {
      font-size: 10px;
      color: rgba(255,232,176,0.72);
      letter-spacing: 0.22em;
      text-transform: uppercase;
      margin-top: 4px;
    }

    .inv-badge { text-align: right; }

    .inv-badge-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.25em;
      text-transform: uppercase;
      color: rgba(255,232,176,0.7);
    }

    .inv-badge-number {
      font-size: 20px;
      font-weight: 700;
      color: #ffe8b0;
      letter-spacing: 0.04em;
      margin-top: 2px;
    }

    .inv-divider {
      height: 3px;
      background: linear-gradient(90deg, #c8892a, #f2c96d, #c8892a);
      flex-shrink: 0;
    }

    .inv-meta {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      border-bottom: 1px solid #f0e0cc;
      flex-shrink: 0;
    }

    .inv-meta-cell {
      padding: 12px 24px;
      border-right: 1px solid #f0e0cc;
    }

    .inv-meta-cell:last-child { border-right: none; }

    .inv-meta-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #b47a40;
      margin-bottom: 4px;
    }

    .inv-meta-value {
      font-size: 12.5px;
      font-weight: 600;
      color: #2a1008;
    }

    .inv-meta-value.paid {
      color: #14703a;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .inv-meta-value.paid::before {
      content: '';
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #14703a;
    }

    .inv-body {
      padding: 20px 40px 16px;
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    .inv-address-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 20px;
    }

    .inv-address-card {
      background: #fdf7ef;
      border: 1px solid #f0e0cc;
      border-radius: 8px;
      padding: 12px 16px;
    }

    .inv-address-card-title {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: #b47a40;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid #f0e0cc;
    }

    .inv-address-card p {
      font-size: 11.5px;
      line-height: 1.65;
      color: #3a1a0a;
    }

    .inv-address-card strong {
      font-size: 12.5px;
      font-weight: 700;
      color: #1e0c04;
      display: block;
      margin-bottom: 2px;
    }

    .inv-table-title {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: #b47a40;
      margin-bottom: 8px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 0;
    }

    thead tr { background: linear-gradient(135deg, #6b0018, #900020); }

    thead th {
      padding: 9px 14px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #ffe8b0;
      text-align: left;
    }

    thead th:last-child { text-align: right; }

    tbody tr { border-bottom: 1px solid #f0e0cc; }
    tbody tr:last-child { border-bottom: none; }

    tbody td {
      padding: 11px 14px;
      font-size: 12px;
      color: #2a1008;
      vertical-align: top;
    }

    tbody td:last-child { text-align: right; font-weight: 600; }

    .item-name { font-weight: 700; font-size: 12.5px; color: #1e0c04; }
    .item-meta { font-size: 10.5px; color: #9a6030; margin-top: 2px; }

    tfoot td {
      padding: 7px 14px;
      font-size: 12px;
    }

    tfoot tr.tf-row-light td { color: #7a4822; }
    tfoot tr.tf-row-discount td { color: #14703a; font-weight: 600; }

    tfoot tr.tf-total {
      border-top: 2px solid #c8892a;
      background: #fdf7ef;
    }

    tfoot tr.tf-total td {
      font-size: 14px;
      font-weight: 700;
      color: #6b0018;
      padding-top: 10px;
      padding-bottom: 10px;
    }

    tfoot td:last-child { text-align: right; }

    .inv-footer {
      margin-top: auto;
      padding-top: 14px;
      border-top: 1px solid #f0e0cc;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      align-items: end;
    }

    .inv-note {
      background: #fdf7ef;
      border-left: 3px solid #c8892a;
      border-radius: 0 6px 6px 0;
      padding: 10px 14px;
      font-size: 10.5px;
      line-height: 1.6;
      color: #5a2a10;
    }

    .inv-note strong { font-weight: 700; color: #2a1008; display: block; margin-bottom: 3px; }

    .inv-thank {
      text-align: right;
      font-family: 'Cinzel', serif;
      color: #6b0018;
    }

    .inv-thank-text { font-size: 13px; font-weight: 600; }
    .inv-thank-sub { font-size: 10px; color: #b47a40; margin-top: 3px; }

    .inv-seal {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: 2px solid #c8892a;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      margin-left: auto;
      margin-top: 6px;
      font-size: 7px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #6b0018;
      line-height: 1.4;
      text-align: center;
    }

    .inv-bottom-band {
      background: linear-gradient(135deg, #6b0018 0%, #a50028 100%);
      padding: 10px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }

    .inv-bottom-band span {
      font-size: 10px;
      color: rgba(255,232,176,0.75);
      letter-spacing: 0.1em;
    }

    .inv-bottom-band a {
      font-size: 10px;
      color: #ffe8b0;
      font-weight: 600;
      text-decoration: none;
    }

    .inv-print-bar {
      width: 794px;
      margin: 16px auto 0;
      display: flex;
      justify-content: flex-end;
    }

    .inv-print-bar button {
      padding: 10px 22px;
      border: 0;
      border-radius: 8px;
      background: #6b0018;
      color: #ffe8b0;
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    @media print {
      html, body { background: #fff; height: auto; }
      .page { margin: 0; box-shadow: none; width: 100%; }
      .inv-print-bar { display: none; }
    }
  </style>
</head>
<body>

  <div class="inv-print-bar">
    <button type="button" onclick="window.print()">Download / Print invoice</button>
  </div>

  <div class="page">

    <div class="inv-header">
      <div class="inv-brand">
        <div class="inv-brand-name">${escapeHtml(seller.name)}</div>
        <div class="inv-brand-tagline">The Art of Banarasi Weaving</div>
      </div>
      <div class="inv-badge">
        <div class="inv-badge-label">Tax Invoice</div>
        <div class="inv-badge-number">#${escapeHtml(invoiceNumber)}</div>
      </div>
    </div>

    <div class="inv-divider"></div>

    <div class="inv-meta">
      <div class="inv-meta-cell">
        <div class="inv-meta-label">Invoice Date</div>
        <div class="inv-meta-value">${escapeHtml(formatDate(invoiceDate))}</div>
      </div>
      <div class="inv-meta-cell">
        <div class="inv-meta-label">Order ID</div>
        <div class="inv-meta-value">${escapeHtml(order.order_number || `#${order.id}`)}</div>
      </div>
      <div class="inv-meta-cell">
        <div class="inv-meta-label">Payment Status</div>
        <div class="inv-meta-value paid">${escapeHtml(paymentLabel)}</div>
      </div>
    </div>

    <div class="inv-body">

      <div class="inv-address-grid">
        <div class="inv-address-card">
          <div class="inv-address-card-title">Sold By</div>
          <p>
            <strong>${escapeHtml(seller.name)}</strong>
            ${escapeHtml(seller.address)}<br />
            ${escapeHtml(seller.cityState)}<br />
            ${sellerGstLine}${escapeHtml(seller.email)}
          </p>
        </div>
        <div class="inv-address-card">
          <div class="inv-address-card-title">Shipped To</div>
          <p>
            <strong>${escapeHtml(order.customer_name || 'Customer')}</strong>
            ${escapeHtml(order.address || '')}<br />
            ${escapeHtml([order.city, order.state].filter(Boolean).join(', '))}${order.pincode ? ` – ${escapeHtml(order.pincode)}` : ''}<br />
            ${order.phone ? `Phone: ${escapeHtml(order.phone)}` : ''}
          </p>
        </div>
      </div>

      <div class="inv-table-title">Order Items</div>
      <table>
        <thead>
          <tr>
            <th style="width:36px">#</th>
            <th>Product Description</th>
            <th style="width:70px; text-align:right">Qty</th>
            <th style="width:100px; text-align:right">Unit Price</th>
            <th style="width:100px">Amount</th>
          </tr>
        </thead>
        <tbody>${renderItemRows(items)}
        </tbody>
        <tfoot>
          <tr class="tf-row-light">
            <td colspan="4">Subtotal</td>
            <td>${rupees(subtotal)}</td>
          </tr>${renderChargeRow('Delivery Charge', order.shipping_charge)}${renderChargeRow('Platform Fee', order.platform_fee)}${renderChargeRow('Cash on Delivery Fee', order.cod_fee)}${renderChargeRow('Gift Packaging', order.gift_charge)}${renderChargeRow('Re-dispatch Charges', order.redispatch_charge)}${renderChargeRow(`Coupon Discount${order.coupon_code ? ` (${order.coupon_code})` : ''}`, order.discount_amount, 'discount')}${renderChargeRow('Online Payment Discount', order.payment_discount, 'discount')}${renderChargeRow('Paid from Wallet', order.wallet_amount, 'discount')}
          <tr class="tf-row-light">
            <td colspan="4">GST (${gstPercent}% incl.)</td>
            <td>${rupees(gstAmount)}</td>
          </tr>
          <tr class="tf-total">
            <td colspan="4" style="font-family:'Cinzel',serif; letter-spacing:0.06em">Total Payable</td>
            <td>${rupees(total)}</td>
          </tr>
        </tfoot>
      </table>

      <div class="inv-footer">
        <div class="inv-note">
          <strong>Terms &amp; Conditions</strong>
          Returns accepted within 7 days of delivery as per our return policy.<br />
          This is a computer-generated invoice and does not require a physical signature.<br />
          For queries: ${escapeHtml(seller.email)}
        </div>
        <div class="inv-thank">
          <div class="inv-thank-text">Thank you for your purchase!</div>
          <div class="inv-thank-sub">Banarasi Kala — Weaving Heritage Since 2020</div>
          <div class="inv-seal">Auth<br/>Sign</div>
        </div>
      </div>

    </div>

    <div class="inv-bottom-band">
      <span>${escapeHtml(seller.name)} · Varanasi, UP${bandGst}</span>
      <a href="https://${escapeHtml(seller.website)}">${escapeHtml(seller.website)}</a>
    </div>

  </div>

</body>
</html>`;
};

module.exports = { renderInvoiceHtml };
