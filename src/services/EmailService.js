const nodemailer = require('nodemailer');
const dns = require('dns');
const { config } = require('../config/env');

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
        "Exchange Completed": "Your exchange request is complete. Your new exchange order has been created and will be dispatched shortly.",
        "Exchange Picked Up": "Your exchange product has been successfully picked up and is on its way back to us for verification.",
        "Exchange Initiated": "Your exchange request has been successfully registered. We will schedule the pickup for the exchange product soon.",
      };
      const message = statusCopy[normalizedStatus] || `Your order status is now ${normalizedStatus}.`;
      const orderNumber = order.order_number;

      const mailOptions = {
        from: `"Banarasi Kala" <${config.emailUser}>`,
        to: order.customer_email,
        subject: `Order ${orderNumber} ${normalizedStatus} | Banarasi Kala`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #3D2817; max-width: 600px; margin: auto; border: 1px solid #ead8b2; padding: 32px; background-color: #fffaf0;">
            <h1 style="color: #800020; margin: 0 0 12px;">Banarasi Kala</h1>
            <p style="font-size: 16px;">Dear ${order.customer_name || "Customer"},</p>
            <p style="font-size: 15px; line-height: 1.6;">${message}</p>
            <div style="margin: 24px 0; padding: 18px; border-radius: 10px; background: #ffffff; border: 1px solid #ead8b2;">
              <p style="margin: 0 0 8px; color: #8a6a2a; font-size: 12px; letter-spacing: 1px; text-transform: uppercase;">Order status</p>
              <p style="margin: 0; color: #800020; font-size: 22px; font-weight: 700;">${normalizedStatus}</p>
              ${order.shiprocket_awb ? `<p style="margin: 12px 0 0; font-size: 14px;">AWB: <strong>${order.shiprocket_awb}</strong></p>` : ""}
            </div>
            <p style="font-size: 13px; color: #7b6d5d;">You can see live updates from your My Orders page.</p>
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
