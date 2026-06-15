const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const AuthController = require("../controllers/AuthController");
const { authMiddleware } = require("../middleware/authMiddleware");

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Too many attempts. Please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { message: "Too many OTP requests. Please wait 10 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public customer auth
router.post("/register", authLimiter, AuthController.register);
router.post("/login", authLimiter, AuthController.login);
router.post("/google", authLimiter, AuthController.googleLogin);
router.post("/send-phone-otp", otpLimiter, AuthController.sendPhoneOtp);
router.post("/verify-phone-otp", authLimiter, AuthController.verifyPhoneOtp);

// New link-based registration flow
router.post("/initiate-registration", authLimiter, AuthController.initiateRegistration);
router.get("/verify-email-link", AuthController.verifyEmailLink);
router.post("/resend-verification-email", otpLimiter, AuthController.resendVerificationEmail);
router.post("/send-registration-phone-otp", otpLimiter, AuthController.sendRegistrationPhoneOtp);
router.post("/complete-registration", authLimiter, AuthController.completeRegistration);

// Public admin auth entrypoint
router.post("/admin-login", authLimiter, AuthController.adminLogin);
router.post("/admin-forgot-password", otpLimiter, AuthController.adminForgotPassword);
router.post("/admin-reset-password", authLimiter, AuthController.adminResetPassword);

// Public token/password helpers
router.post("/refresh-token", AuthController.refreshToken);
router.post("/forgot-password", otpLimiter, AuthController.forgotPassword);
router.post("/reset-password", authLimiter, AuthController.resetPassword);
router.post("/send-password-reset-phone-otp", otpLimiter, AuthController.sendPasswordResetPhoneOtp);
router.post("/verify-password-reset-phone-otp", authLimiter, AuthController.verifyPasswordResetPhoneOtp);
router.post("/reset-password-by-phone", authLimiter, AuthController.resetPasswordByPhone);
router.post("/send-email-otp", otpLimiter, AuthController.sendEmailOtp);
router.post("/verify-email-otp", authLimiter, AuthController.verifyEmailOtp);

// Protected
router.post("/logout", authMiddleware, AuthController.logout);

module.exports = router;
