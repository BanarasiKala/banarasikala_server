const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const Customer = require("../models/Customer");
const Admin = require("../models/Admin");
const { Op } = require("sequelize");
const WalletService = require("./WalletService");
const { config } = require("../config/env");
const EmailService = require("./EmailService");

const generateReferralCode = () =>
  `VNS${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits.replace(/^0+/, "");
};
const possiblePhoneValues = (phone) => {
  const normalized = normalizePhone(phone);
  return [...new Set([normalized, `0${normalized}`, `91${normalized}`, `+91${normalized}`].filter(Boolean))];
};
const otpStore = new Map();
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_PURPOSES = new Set(["signup", "forgot_password"]);

// ── MessageCentral helpers ────────────────────────────────────────────────────
const phoneOtpStore = new Map();
const PHONE_OTP_TTL_MS = 10 * 60 * 1000;

const normalizeMobileForMC = (mobile) => {
  const digits = String(mobile).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
};

const sendOtpMessageCentral = async (mobile) => {
  try {
    if (!config.msgCentralAuthToken) {
      console.warn("MSG_CENTRAL_AUTH_TOKEN not configured");
      return { ok: false, reason: "no_auth_token" };
    }
    const mobileNumber = normalizeMobileForMC(mobile);
    const url = `https://cpaas.messagecentral.com/verification/v3/send?countryCode=91&customerId=${config.msgCentralCustomerId}&flowType=SMS&mobileNumber=${mobileNumber}&otpLength=6`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { authToken: config.msgCentralAuthToken, "Content-Type": "application/json" },
      body: JSON.stringify({ codeLength: 6, otpLength: 6 }),
    });
    const json = await resp.json().catch(() => null);
    return { ok: resp.ok, status: resp.status, body: json };
  } catch (err) {
    console.error("MessageCentral send error", err);
    return { ok: false, reason: err.message };
  }
};

const verifyOtpMessageCentral = async (mobile, otp, verificationId) => {
  try {
    if (!config.msgCentralAuthToken) return { ok: false, reason: "no_auth_token" };
    const mobileNumber = normalizeMobileForMC(mobile);
    const url = `https://cpaas.messagecentral.com/verification/v3/validateOtp?countryCode=91&mobileNumber=${mobileNumber}&verificationId=${verificationId}&customerId=${config.msgCentralCustomerId}&code=${otp}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { authToken: config.msgCentralAuthToken },
    });
    const json = await resp.json().catch(() => null);
    const ok = resp.ok && (json?.responseCode === 200 || json?.data?.verificationStatus === "VERIFICATION_COMPLETED");
    return { ok, status: resp.status, body: json };
  } catch (err) {
    console.error("MessageCentral verify error", err);
    return { ok: false, reason: err.message };
  }
};

class AuthService {
  async createOtpSession({ email, purpose, name }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) throw new Error("Email is required.");
    if (!OTP_PURPOSES.has(purpose)) throw new Error("Invalid OTP purpose.");
    const otp = EmailService.generateOtp();
    const token = jwt.sign({ email: normalizedEmail, purpose, nonce: Date.now() }, config.jwtSecret, { expiresIn: "15m" });
    otpStore.set(token, { email: normalizedEmail, purpose, otp, expiresAt: Date.now() + OTP_TTL_MS, verified: false });
    await EmailService.sendOTP(normalizedEmail, otp, name || "Customer");
    return { token, email: normalizedEmail, expiresInSeconds: 600 };
  }

  verifyOtpSession({ token, otp, purpose }) {
    const record = otpStore.get(token);
    if (!record) throw new Error("OTP session expired. Please request OTP again.");
    if (record.purpose !== purpose) throw new Error("Invalid OTP session purpose.");
    if (record.expiresAt < Date.now()) {
      otpStore.delete(token);
      throw new Error("OTP expired. Please request OTP again.");
    }
    if (String(record.otp) !== String(otp || "")) throw new Error("Invalid OTP.");
    record.verified = true;
    otpStore.set(token, record);
    return record;
  }
  async register(userData) {
    const { name, phone, email, password, referral_code, email_otp_token } = userData;
    const cleanName = String(name || "").trim();
    const cleanEmail = normalizeEmail(email);
    const cleanPhone = normalizePhone(phone);

    if (!cleanName) throw new Error("Name is required.");
    if (!cleanEmail) throw new Error("Email is required for registration.");
    if (!cleanPhone || cleanPhone.length !== 10) throw new Error("Please enter a valid 10 digit mobile number.");
    if (!password || String(password).length < 8) throw new Error("Password must be at least 8 characters.");
    if (!/[A-Z]/.test(password)) throw new Error("Password must contain at least one uppercase letter.");
    if (!/[0-9]/.test(password)) throw new Error("Password must contain at least one number.");
    if (!/[^A-Za-z0-9]/.test(password)) throw new Error("Password must contain at least one special character.");

    const otpRecord = otpStore.get(email_otp_token);
    if (!otpRecord || !otpRecord.verified || otpRecord.purpose !== "signup" || otpRecord.email !== cleanEmail) {
      throw new Error("Email OTP verification is required for signup.");
    }

    const existingPhone = await Customer.findOne({ where: { phone: { [Op.in]: possiblePhoneValues(cleanPhone) } } });
    if (existingPhone) {
      throw new Error("Phone number already registered");
    }

    const existingEmail = await Customer.findOne({ where: { email: cleanEmail } });
    if (existingEmail) {
      throw new Error("Email already registered");
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    let customer = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        customer = await Customer.create({
          name: cleanName,
          phone: cleanPhone,
          email: cleanEmail,
          password: hashedPassword,
          referral_code: generateReferralCode(),
          phone_verified: true,
        });
        break;
      } catch (err) {
        // Retry only on referral_code collisions (rare).
        if (err?.name === "SequelizeUniqueConstraintError") continue;
        throw err;
      }
    }
    if (!customer) {
      throw new Error("Failed to generate referral code. Please try again.");
    }

    // Welcome bonus for every first-time signup.
    await WalletService.creditNow({
      customerId: customer.id,
      amount: config.welcomeBonus,
      type: "WELCOME_BONUS",
      dedupeKey: `welcome:${customer.id}`,
      meta: null,
    });

    // Optional referral flow:
    // - If referral_code is valid, credit ₹100 to the new user's wallet immediately.
    // - Referrer earns ₹50 only after referred user's delivered order + 7 days (handled elsewhere).
    if (referral_code) {
      const referrer = await Customer.findOne({ where: { referral_code } });
      if (referrer && referrer.id !== customer.id) {
        await customer.update({ referred_by_id: referrer.id });
        await WalletService.creditNow({
          customerId: customer.id,
          amount: config.referralSignupBonus,
          type: "REFERRAL_SIGNUP_BONUS",
          dedupeKey: `ref_signup:${customer.id}`,
          meta: { referrer_id: referrer.id },
        });
      }
    }
    otpStore.delete(email_otp_token);

    return this.generateTokens(customer);
  }

  async login(email, password) {
    const identifier = String(email || "").trim();
    const normalizedPhone = normalizePhone(identifier);
    const where = identifier.includes("@")
      ? { email: normalizeEmail(identifier) }
      : { phone: { [Op.in]: possiblePhoneValues(normalizedPhone) } };
    const customer = await Customer.findOne({ where });
    if (!customer) {
      throw new Error("Invalid email or password");
    }

    if (!customer.password) {
      throw new Error("This account uses Google Sign-In. Please log in with Google.");
    }

    const isMatch = await bcrypt.compare(password, customer.password);
    if (!isMatch) {
      throw new Error("Invalid email or password");
    }

    return this.generateTokens(customer, "customer");
  }

  async googleLogin(credential) {
    if (!config.googleClientId) throw new Error("Google Sign-In is not configured.");

    const client = new OAuth2Client(config.googleClientId);
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: config.googleClientId,
      });
      payload = ticket.getPayload();
    } catch {
      throw new Error("Invalid Google credential. Please try again.");
    }

    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name || email.split("@")[0];
    const avatar_url = payload.picture || null;

    // Try to find by google_id first, then by email
    let customer = await Customer.findOne({ where: { google_id: googleId } });

    if (!customer) {
      customer = await Customer.findOne({ where: { email } });
      if (customer) {
        // Link Google to an existing email+password account
        customer.google_id = googleId;
        if (!customer.avatar_url) customer.avatar_url = avatar_url;
        await customer.save();
      }
    }

    if (!customer) {
      // New customer via Google — create account
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          customer = await Customer.create({
            name,
            email,
            google_id: googleId,
            auth_provider: "google",
            avatar_url,
            phone: null,
            password: null,
            referral_code: generateReferralCode(),
            phone_verified: false,
          });
          break;
        } catch (err) {
          if (err?.name === "SequelizeUniqueConstraintError") continue;
          throw err;
        }
      }
      if (!customer) throw new Error("Could not create account. Please try again.");

      await WalletService.creditNow({
        customerId: customer.id,
        amount: config.welcomeBonus,
        type: "WELCOME_BONUS",
        dedupeKey: `welcome:${customer.id}`,
        meta: null,
      });
    }

    // If no phone yet, require phone verification before issuing full tokens
    if (!customer.phone) {
      const pendingToken = jwt.sign(
        { customerId: customer.id, purpose: "phone_verification" },
        config.jwtSecret,
        { expiresIn: "30m" }
      );
      return { requiresPhoneVerification: true, pendingToken };
    }

    return this.generateTokens(customer, "customer");
  }

  async sendPhoneOtp(pendingToken, phone) {
    let decoded;
    try {
      decoded = jwt.verify(pendingToken, config.jwtSecret);
    } catch {
      throw new Error("Session expired. Please sign in with Google again.");
    }
    if (decoded.purpose !== "phone_verification") throw new Error("Invalid session token.");

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || cleanPhone.length !== 10) throw new Error("Please enter a valid 10-digit mobile number.");

    const existing = await Customer.findOne({ where: { phone: { [Op.in]: possiblePhoneValues(cleanPhone) } } });
    if (existing && existing.id !== decoded.customerId) throw new Error("This phone number is already registered.");

    const result = await sendOtpMessageCentral(cleanPhone);
    if (!result.ok) throw new Error("Failed to send OTP. Please try again.");

    const verificationId = result.body?.data?.verificationId || result.body?.verificationId;
    phoneOtpStore.set(`${decoded.customerId}:${cleanPhone}`, {
      verificationId,
      expiresAt: Date.now() + PHONE_OTP_TTL_MS,
    });

    return { message: "OTP sent successfully.", verificationId };
  }

  async verifyPhoneOtp(pendingToken, phone, otp, verificationId) {
    let decoded;
    try {
      decoded = jwt.verify(pendingToken, config.jwtSecret);
    } catch {
      throw new Error("Session expired. Please sign in with Google again.");
    }
    if (decoded.purpose !== "phone_verification") throw new Error("Invalid session token.");

    const cleanPhone = normalizePhone(phone);
    const stored = phoneOtpStore.get(`${decoded.customerId}:${cleanPhone}`);
    const effectiveVerificationId = verificationId || stored?.verificationId;
    if (!effectiveVerificationId) throw new Error("OTP session not found. Please request a new OTP.");
    if (stored?.expiresAt < Date.now()) {
      phoneOtpStore.delete(`${decoded.customerId}:${cleanPhone}`);
      throw new Error("OTP expired. Please request a new OTP.");
    }

    const result = await verifyOtpMessageCentral(cleanPhone, otp, effectiveVerificationId);
    if (!result.ok) throw new Error("Invalid or expired OTP. Please try again.");

    phoneOtpStore.delete(`${decoded.customerId}:${cleanPhone}`);

    const customer = await Customer.findByPk(decoded.customerId);
    if (!customer) throw new Error("Account not found.");

    customer.phone = cleanPhone;
    customer.phone_verified = true;
    await customer.save();

    return this.generateTokens(customer, "customer");
  }

  async adminLogin(email, password) {
    const admin = await Admin.findOne({ where: { email } });
    if (!admin) {
      throw new Error("Invalid email or password");
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      throw new Error("Invalid email or password");
    }

    return this.generateTokens(admin, "admin");
  }

  async refreshToken(token) {
    if (!token) throw new Error("No token provided");

    try {
      const decoded = jwt.verify(token, config.refreshTokenSecret);
      const role = decoded.role || "customer";
      const user = role === "admin"
        ? await Admin.findByPk(decoded.id)
        : await Customer.findByPk(decoded.id);

      if (!user || user.refresh_token !== token) {
        throw new Error("Invalid refresh token");
      }

      return this.generateTokens(user, role);
    } catch (err) {
      throw new Error("Invalid refresh token");
    }
  }

  async generateTokens(user, role = "customer") {
    const accessToken = jwt.sign(
      { id: user.id, role: role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    const refreshToken = jwt.sign(
      { id: user.id, role: role },
      config.refreshTokenSecret,
      { expiresIn: config.refreshTokenExpiresIn }
    );

    user.refresh_token = refreshToken;
    await user.save();

    const userPayload = {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: role,
      avatar_url: user.avatar_url || null,
      wallet_balance: user.wallet_balance ?? null,
      referral_code: user.referral_code || null,
    };

    return {
      customer: role === "customer" ? userPayload : null,
      admin: role === "admin" ? userPayload : null,
      user: userPayload,
      accessToken,
      refreshToken,
    };
  }

  async adminForgotPassword(email) {
    const cleanEmail = normalizeEmail(email);
    const admin = await Admin.findOne({ where: { email: cleanEmail } });
    if (!admin) throw new Error("No admin account found with this email.");
    return this.createOtpSession({ email: cleanEmail, purpose: "forgot_password", name: admin.name });
  }

  async adminResetPassword(email, emailOtpToken, newPassword) {
    const cleanEmail = normalizeEmail(email);
    const admin = await Admin.findOne({ where: { email: cleanEmail } });
    if (!admin) throw new Error("No admin account found with this email.");
    if (!newPassword || String(newPassword).length < 8) throw new Error("Password must be at least 8 characters.");
    const otpRecord = otpStore.get(emailOtpToken);
    if (!otpRecord || !otpRecord.verified || otpRecord.purpose !== "forgot_password" || otpRecord.email !== cleanEmail) {
      throw new Error("OTP verification is required.");
    }
    const salt = await bcrypt.genSalt(10);
    admin.password = await bcrypt.hash(newPassword, salt);
    await admin.save();
    otpStore.delete(emailOtpToken);
    return { message: "Password reset successfully" };
  }

  async startPasswordReset(email) {
    const cleanEmail = normalizeEmail(email);
    const user = await Customer.findOne({ where: { email: cleanEmail } });
    if (!user) throw new Error("No account found with this email.");
    return {
      message: "Account found. Please verify email OTP to reset password.",
      email: cleanEmail,
    };
  }

  async sendEmailOtp(email, purpose, name) {
    return await this.createOtpSession({ email, purpose, name });
  }

  async verifyEmailOtp(token, otp, purpose) {
    const record = this.verifyOtpSession({ token, otp, purpose });
    return { message: "OTP verified successfully.", email: record.email };
  }

  async resetPasswordWithEmailOtp(email, emailOtpToken, newPassword) {
    const cleanEmail = normalizeEmail(email);
    const user = await Customer.findOne({ where: { email: cleanEmail } });
    if (!user) throw new Error("No account found with this email.");
    if (!newPassword || String(newPassword).length < 6) throw new Error("Password must be at least 6 characters.");
    const otpRecord = otpStore.get(emailOtpToken);
    if (!otpRecord || !otpRecord.verified || otpRecord.purpose !== "forgot_password" || otpRecord.email !== cleanEmail) {
      throw new Error("Email OTP verification is required for password reset.");
    }
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();
    otpStore.delete(emailOtpToken);
    return { message: "Password reset successfully" };
  }

  async logout(userId, role = "customer") {
    const Model = role === "admin" ? Admin : Customer;
    const user = await Model.findByPk(userId);
    if (user) {
      user.refresh_token = null;
      await user.save();
    }
  }
}

module.exports = new AuthService();
