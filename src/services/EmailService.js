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

class EmailService {
  generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  async sendOrderConfirmation(order, items) {
    const orderNumber = order.order_number;
    const itemList = items.map(item => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.name || 'Saree'}</td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.sku || ''}</td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.quantity}</td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">₹${item.price}</td>
      </tr>
    `).join('');

    const mailOptions = {
      from: `"Banarasi Kala" <${config.emailUser}>`,
      to: order.customer_email,
      subject: `Order Confirmed - ${orderNumber} | Banarasi Kala`,
      html: `
        <div style="font-family: 'Playfair Display', serif; color: #3D2817; max-width: 600px; margin: auto; border: 1px solid #D4AF37; padding: 40px; background-color: #FDFCFB;">
          <h1 style="color: #800020; text-align: center; border-bottom: 2px solid #D4AF37; padding-bottom: 20px;">Banarasi Kala</h1>
          <p>Dear ${order.customer_name},</p>
          <p>Thank you for choosing Banarasi Kala. Your order for our handcrafted masterpiece has been confirmed.</p>
          
          <h3 style="color: #800020; margin-top: 30px;">Order Summary (${orderNumber})</h3>
          <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
            <thead style="background-color: #FAF8F6;">
              <tr>
                <th style="text-align: left; padding: 10px;">Item</th>
                <th style="text-align: left; padding: 10px;">SKU</th>
                <th style="text-align: left; padding: 10px;">Qty</th>
                <th style="text-align: left; padding: 10px;">Price</th>
              </tr>
            </thead>
            <tbody>
              ${itemList}
            </tbody>
            <tfoot>
              <tr>
                <td colspan="3" style="padding: 20px 10px 10px; font-weight: bold; text-align: right;">Total Amount:</td>
                <td style="padding: 20px 10px 10px; font-weight: bold; color: #800020;">₹${order.total_amount ?? order.payable_amount ?? ''}</td>
              </tr>
            </tfoot>
          </table>
          
          <div style="margin-top: 40px; padding: 20px; background-color: #FAF8F6; border-radius: 8px;">
            <h4 style="margin: 0; color: #800020;">Shipping Address:</h4>
            <p style="margin: 5px 0; font-size: 14px;">
              ${order.address}, ${order.city} - ${order.pincode}<br/>
              Phone: ${order.phone}
            </p>
          </div>
          
          <p style="margin-top: 40px; font-style: italic; text-align: center; color: #D4AF37;">A new heritage begins with you.</p>
          <p style="text-align: center; font-size: 12px; color: #999; margin-top: 20px;">&copy; 2024 Banarasi Kala. All rights reserved.</p>
        </div>
      `,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Order confirmation email sent to ${order.customer_email}`);
    } catch (error) {
      console.error('Error sending email:', error);
    }
  }

  async sendOrderStatusUpdate(order, status) {
    try {
      if (!order?.customer_email) return;
      const normalizedStatus = String(status || order.status || "Updated").trim();
      const statusCopy = {
        Shipped: "Your order has been shipped. Tracking will keep updating as the courier scans the shipment.",
        "Out For Delivery": "Your order is out for delivery today.",
        Delivered: "Your order has been delivered. We hope it brings a little Banaras into your day.",
        Cancelled: "Your order has been cancelled.",
        "Partially Cancelled": "One or more items in your order have been successfully cancelled. The remaining items are active and the total billing has been adjusted.",
        Processing: "Your order is being prepared with care.",
        "AWB Assigned": "Your shipment tracking number has been assigned.",
        Undelivered: "The courier could not complete the delivery attempt. We will keep you updated.",
        "RTO Initiated": "Your shipment is being returned to seller after an unsuccessful delivery attempt.",
        "RTO In Transit": "Your shipment is on its way back to seller.",
        "RTO Delivered": "Your order has returned to seller. Please check My Orders for refund or re-dispatch details.",
        "Seller Cancelled": "Your order has been cancelled due to unsuccessful delivery. Please place a new order if you still wish to purchase the product.",
        "Return Completed": "Your return has been successfully received and inspected. We have approved the return request and initiated your refund process. The refund will be credited shortly.",
        "Return Picked Up": "Your return parcel has been successfully picked up by our courier partner and is on its way to our facility.",
        "Return Initiated": "Your return request has been successfully registered. Our courier partner will schedule the return pickup soon.",
        // "Received" is the halfway point of an exchange — we have the old saree, the
        // replacement has NOT shipped yet. Do not promise it has.
        "Exchange Received": "We have received and inspected the product you sent back. Your replacement will be dispatched shortly and you will get tracking details as soon as it ships.",
        // Reached only once the replacement has actually been delivered.
        "Exchange Completed": "Your exchange is complete — your replacement has been delivered. We hope you love it!",
        "Exchange Picked Up": "Your exchange product has been successfully picked up and is on its way back to us for verification.",
        "Exchange Initiated": "Your exchange request has been successfully registered. We will schedule the pickup for the exchange product soon.",
      };
      const message = statusCopy[normalizedStatus] || `Your order status is now ${normalizedStatus}.`;
      const orderNumber = order.order_number;
      const customerName = order.customer_name || "Customer";
      const awb = order.shiprocket_awb || order.awb_number || order.awb || null;

      // Deep-link the CTA to the customer's live order page (falls back to the
      // orders list if we somehow don't have an id).
      const siteBase = (config.frontendUrl || "https://banarasikala.com").replace(/\/$/, "");
      const orderUrl = order.id
        ? `${siteBase}/order-confirmation?orderId=${order.id}`
        : `${siteBase}/my-orders`;

      // Tone the status chip / accent by outcome: green = good news,
      // red = needs attention, maroon = default brand progress.
      const GREEN = { accent: "#1a7f4b", chipBg: "#e9f7ef", chipText: "#12673a" };
      const RED = { accent: "#b0324b", chipBg: "#fdecef", chipText: "#93233c" };
      const BRAND = { accent: "#800020", chipBg: "#f6ead2", chipText: "#8a6a2a" };
      const tone = ["Delivered", "Return Completed", "Exchange Received", "Exchange Completed", "Exchange Delivered", "Return Delivered"].includes(normalizedStatus)
        ? GREEN
        : ["Cancelled", "Partially Cancelled", "Seller Cancelled", "Undelivered", "RTO Initiated", "RTO In Transit", "RTO Delivered", "Return Cancelled", "Exchange Cancelled"].includes(normalizedStatus)
          ? RED
          : BRAND;

      // ── Order summary + Gmail order card: only for non-cancelled updates ──
      // (The email itself only fires on a real status change.) Items are
      // fetched here so the email is self-sufficient no matter which flow
      // triggered it.
      const isCancelled = /cancel/i.test(normalizedStatus);
      const rupee = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

      let displayItems = [];
      if (!isCancelled && order.id) {
        try {
          const rows = await OrderItem.findAll({
            where: { order_id: order.id },
            include: [{ model: Product, attributes: ["id", "name", "images"] }],
          });
          displayItems = rows
            .filter((it) => !["REMOVED", "Cancelled"].includes(String(it.status)))
            .map((it) => ({
              name: it.product_name || it.Product?.name || "Saree",
              sku: it.sku || "",
              qty: Number(it.quantity) || 1,
              price: Number(it.price) || 0,
              image: pickOrderItemImage(it.Product, it.colorId),
            }));
        } catch (itemErr) {
          console.error("[Email] Could not load items for status email:", itemErr.message);
        }
      }
      const subtotal = displayItems.reduce((sum, it) => sum + it.price * it.qty, 0);

      const itemRows = displayItems.map((it) => `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #f0e7d5;width:64px;vertical-align:top;">
            ${it.image
              ? `<img src="${it.image}" width="56" height="72" alt="" style="display:block;width:56px;height:72px;object-fit:cover;border-radius:8px;border:1px solid #ece0c6;" />`
              : `<div style="width:56px;height:72px;border-radius:8px;background:#f2e9d8;"></div>`}
          </td>
          <td style="padding:12px 14px;border-bottom:1px solid #f0e7d5;vertical-align:top;">
            <div style="font-size:14px;font-weight:600;color:#3D2817;line-height:1.4;">${it.name}</div>
            ${it.sku ? `<div style="font-size:12px;color:#9a8a76;margin-top:3px;">SKU: ${it.sku}</div>` : ""}
            <div style="font-size:12px;color:#9a8a76;margin-top:3px;">Qty: ${it.qty}</div>
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #f0e7d5;text-align:right;vertical-align:top;font-size:14px;font-weight:700;color:#800020;white-space:nowrap;">${rupee(it.price * it.qty)}</td>
        </tr>`).join("");

      const itemsSection = displayItems.length ? `
        <p style="margin:26px 0 10px;color:#8a6a2a;font-size:12px;letter-spacing:1px;text-transform:uppercase;font-weight:700;">Order Summary</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#ffffff;border:1px solid #ece0c6;border-radius:10px;">
          <tr><td style="padding:4px 18px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              ${itemRows}
              <tr>
                <td colspan="2" style="padding:14px 0 6px;text-align:right;font-size:13px;color:#6f6355;">Subtotal</td>
                <td style="padding:14px 0 6px;text-align:right;font-size:16px;font-weight:800;color:#800020;white-space:nowrap;">${rupee(subtotal)}</td>
              </tr>
            </table>
          </td></tr>
        </table>` : "";

      // Gmail order annotation (schema.org) — the "View order" highlight card
      // Gmail draws above the message body for registered senders.
      const schemaStatusMap = {
        Processing: "OrderProcessing",
        "AWB Assigned": "OrderProcessing",
        "Pickup Scheduled": "OrderProcessing",
        Shipped: "OrderInTransit",
        "Out For Delivery": "OrderInTransit",
        Delivered: "OrderDelivered",
        Undelivered: "OrderProblem",
        "RTO Initiated": "OrderReturned",
        "RTO In Transit": "OrderReturned",
        "RTO Delivered": "OrderReturned",
        "Return Initiated": "OrderReturned",
        "Return Picked Up": "OrderReturned",
        "Return Completed": "OrderReturned",
      };
      const orderMarkup = isCancelled ? "" : `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Order",
        merchant: { "@type": "Organization", name: "Banarasi Kala" },
        orderNumber: String(orderNumber || ""),
        orderStatus: `https://schema.org/${schemaStatusMap[normalizedStatus] || "OrderProcessing"}`,
        priceCurrency: "INR",
        url: orderUrl,
        ...(displayItems.length ? {
          acceptedOffer: displayItems.map((it) => ({
            "@type": "Offer",
            itemOffered: { "@type": "Product", name: it.name, ...(it.image ? { image: it.image } : {}) },
            price: String(it.price),
            priceCurrency: "INR",
            eligibleQuantity: { "@type": "QuantitativeValue", value: it.qty },
          })),
        } : {}),
        potentialAction: { "@type": "ViewAction", name: "View Order", target: orderUrl, url: orderUrl },
      })}</script>`;

      const mailOptions = {
        from: `"Banarasi Kala" <${config.emailUser}>`,
        to: order.customer_email,
        subject: `Order ${orderNumber} ${normalizedStatus} | Banarasi Kala`,
        html: `
          ${orderMarkup}
          <!-- preheader: shown as the inbox snippet, hidden in the body -->
          <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">
            ${message}
          </div>
          <div style="background-color:#f4efe6;padding:24px 0;font-family:'Segoe UI',Arial,sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr>
                <td align="center">
                  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;border-collapse:collapse;background-color:#fffdf8;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(61,40,23,0.10);">

                    <!-- Header -->
                    <tr>
                      <td style="background:linear-gradient(135deg,#800020 0%,#a0152d 100%);padding:28px 40px;text-align:center;">
                        <div style="color:#f6d98a;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-bottom:6px;">Handwoven in Banaras</div>
                        <div style="color:#ffffff;font-size:26px;font-weight:700;letter-spacing:1px;font-family:Georgia,'Times New Roman',serif;">Banarasi Kala</div>
                      </td>
                    </tr>

                    <!-- Gold divider -->
                    <tr><td style="height:4px;background:linear-gradient(90deg,#D4AF37,#f3e3b3,#D4AF37);font-size:0;line-height:0;">&nbsp;</td></tr>

                    <!-- Body -->
                    <tr>
                      <td style="padding:36px 40px 8px;">
                        <p style="margin:0 0 18px;font-size:16px;color:#3D2817;">Dear ${customerName},</p>

                        <!-- Status chip -->
                        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;">
                          <tr>
                            <td style="background-color:${tone.chipBg};color:${tone.chipText};border-radius:999px;padding:8px 18px;font-size:13px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;">
                              ${normalizedStatus}
                            </td>
                          </tr>
                        </table>

                        <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#4a3a2b;">${message}</p>

                        <!-- Order number card -->
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:#faf5ea;border:1px solid #ece0c6;border-radius:10px;">
                          <tr>
                            <td style="padding:18px 22px;">
                              <span style="display:block;color:#8a6a2a;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Order Number</span>
                              <span style="display:block;color:#800020;font-size:18px;font-weight:700;">${orderNumber}</span>
                              ${awb ? `<span style="display:block;margin-top:12px;color:#8a6a2a;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Tracking (AWB)</span><span style="display:block;color:#3D2817;font-size:15px;font-weight:600;">${awb}</span>` : ""}
                            </td>
                          </tr>
                        </table>

                        <!-- Order summary — item photos, titles, qty, price (non-cancelled only) -->
                        ${itemsSection}

                        <!-- CTA button (bulletproof padded anchor) -->
                        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:28px auto 8px;">
                          <tr>
                            <td align="center" style="border-radius:8px;background-color:${tone.accent};">
                              <a href="${orderUrl}" target="_blank"
                                 style="display:inline-block;padding:15px 44px;color:#ffffff;font-size:16px;font-weight:700;letter-spacing:0.5px;text-decoration:none;border-radius:8px;">
                                View Order
                              </a>
                            </td>
                          </tr>
                        </table>
                        <p style="margin:0;text-align:center;font-size:12px;color:#9a8a76;">
                          or copy this link: <a href="${orderUrl}" target="_blank" style="color:#800020;">${orderUrl}</a>
                        </p>
                      </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                      <td style="padding:28px 40px 32px;text-align:center;border-top:1px solid #f0e7d5;margin-top:20px;">
                        <p style="margin:16px 0 6px;font-style:italic;color:#D4AF37;font-size:14px;font-family:Georgia,serif;">A new heritage begins with you.</p>
                        <p style="margin:0;font-size:12px;color:#a89b88;">Need help? Just reply to this email &mdash; we're happy to assist.</p>
                        <p style="margin:10px 0 0;font-size:11px;color:#bcae9a;">&copy; ${new Date().getFullYear()} Banarasi Kala. All rights reserved.</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </div>
        `,
      };

      await transporter.sendMail(mailOptions);
      console.log(`Order status update email sent to ${order.customer_email} for status: ${normalizedStatus}`);
    } catch (error) {
      console.error('Error sending order status update email:', error);
    }
  }

  async sendEmailVerification(email, name, verificationUrl) {
    const mailOptions = {
      from: `"Banarasi Kala" <${config.emailUser}>`,
      to: email,
      subject: `Verify your email address | Banarasi Kala`,
      html: `
        <div style="font-family: 'Playfair Display', serif; color: #3D2817; max-width: 600px; margin: auto; border: 1px solid #D4AF37; padding: 40px; background-color: #FDFCFB;">
          <h1 style="color: #800020; text-align: center; border-bottom: 2px solid #D4AF37; padding-bottom: 20px;">Banarasi Kala</h1>
          <p>Dear ${name || 'Customer'},</p>
          <p>Thank you for registering with Banarasi Kala. Please verify your email address to complete your registration.</p>
          <div style="text-align: center; margin: 40px 0;">
            <a href="${verificationUrl}"
               style="display: inline-block; padding: 14px 36px; background-color: #800020; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: bold; letter-spacing: 0.5px;">
              Verify My Email
            </a>
          </div>
          <p style="font-size: 13px; color: #888; text-align: center;">This link is valid for 30 minutes. If you did not register with us, please ignore this email.</p>
          <p style="margin-top: 40px; font-style: italic; text-align: center; color: #D4AF37;">A new heritage begins with you.</p>
          <p style="text-align: center; font-size: 12px; color: #999; margin-top: 20px;">&copy; 2024 Banarasi Kala. All rights reserved.</p>
        </div>
      `,
    };
    try {
      await transporter.sendMail(mailOptions);
    } catch (error) {
      console.error('Error sending verification email:', error);
      if (error.code === 'EAUTH') throw new Error('Email authentication failed. Please check your App Password.');
      throw new Error(`Failed to send verification email: ${error.message}`);
    }
  }

  async sendOTP(email, otp, name) {
    const mailOptions = {
      from: `"Banarasi Kala" <${config.emailUser}>`,
      to: email,
      subject: `Your verification code | Banarasi Kala`,
      html: `
        <div style="font-family: 'Playfair Display', serif; color: #3D2817; max-width: 600px; margin: auto; border: 1px solid #D4AF37; padding: 40px; background-color: #FDFCFB;">
          <h1 style="color: #800020; text-align: center; border-bottom: 2px solid #D4AF37; padding-bottom: 20px;">Banarasi Kala</h1>
          <p>Dear ${name || 'Customer'},</p>
          <p>Please use this 6-digit OTP to verify your email:</p>
          
          <div style="text-align: center; margin: 40px 0;">
            <span style="font-size: 32px; font-weight: bold; color: #800020; letter-spacing: 10px; border: 2px dashed #D4AF37; padding: 10px 20px; background-color: #FAF8F6;">${otp}</span>
          </div>
          
          <p style="font-size: 14px; color: #666; text-align: center;">This OTP is valid for 10 minutes. If you did not request this, please ignore this email.</p>
          
          <p style="margin-top: 40px; font-style: italic; text-align: center; color: #D4AF37;">A new heritage begins with you.</p>
          <p style="text-align: center; font-size: 12px; color: #999; margin-top: 20px;">&copy; 2024 Banarasi Kala. All rights reserved.</p>
        </div>
      `,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Password reset OTP sent to ${email}`);
    } catch (error) {
      console.error('CRITICAL EMAIL ERROR:', error);
      if (error.code === 'EAUTH') {
        throw new Error("Email authentication failed. Please check your App Password.");
      }
      throw new Error(`Failed to send OTP email: ${error.message}`);
    }
  }
}

module.exports = new EmailService();
