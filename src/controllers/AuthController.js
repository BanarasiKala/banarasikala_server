const AuthService = require("../services/AuthService");

const toCustomerAuthMessage = (error, fallback) => {
  const message = String(error?.message || "");
  if (
    /sequelize|database|column|relation|syntax|internal|connect|timeout/i.test(message)
  ) {
    return fallback;
  }
  return message || fallback;
};

class AuthController {
  async register(req, res) {
    try {
      const result = await AuthService.register(req.body);
      res.status(201).json(result);
    } catch (error) {
      console.error("[AuthController:register]", error.message, error.code || "");
      res.status(error.code === "OTP_RATE_LIMITED" ? 429 : 400).json({
        message: toCustomerAuthMessage(error, "We could not create your account right now. Please try again."),
        code: error.code,
      });
    }
  }

  async login(req, res) {
    try {
      const { identifier, email, password } = req.body;
      const result = await AuthService.login(identifier || email, password);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:login]", error.message, error.code || "");
      res.status(401).json({
        message: toCustomerAuthMessage(error, "We could not log you in right now. Please try again."),
        code: error.code,
      });
    }
  }

  async googleLogin(req, res) {
    try {
      const { credential } = req.body;
      if (!credential) return res.status(400).json({ message: "Google credential is required." });
      const result = await AuthService.googleLogin(credential);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:googleLogin]", error.message);
      res.status(401).json({ message: error.message || "Google Sign-In failed. Please try again." });
    }
  }

  async sendPhoneOtp(req, res) {
    try {
      const { pendingToken, phone } = req.body;
      if (!pendingToken || !phone) return res.status(400).json({ message: "pendingToken and phone are required." });
      const result = await AuthService.sendPhoneOtp(pendingToken, phone);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:sendPhoneOtp]", error.message);
      res.status(400).json({ message: error.message || "Failed to send OTP." });
    }
  }

  async verifyPhoneOtp(req, res) {
    try {
      const { pendingToken, phone, otp, verificationId } = req.body;
      if (!pendingToken || !phone || !otp) return res.status(400).json({ message: "pendingToken, phone and otp are required." });
      const result = await AuthService.verifyPhoneOtp(pendingToken, phone, otp, verificationId);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:verifyPhoneOtp]", error.message);
      res.status(400).json({ message: error.message || "OTP verification failed." });
    }
  }

  async adminLogin(req, res) {
    try {
      const { email, password } = req.body;
      const result = await AuthService.adminLogin(email, password);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:adminLogin]", error.message);
      res.status(401).json({ message: error.message });
    }
  }

  async refreshToken(req, res) {
    try {
      const { token } = req.body;
      const result = await AuthService.refreshToken(token);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:refreshToken]", error.message);
      res.status(401).json({ message: error.message });
    }
  }

  async forgotPassword(req, res) {
    try {
      const { email } = req.body;
      const result = await AuthService.startPasswordReset(email);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:forgotPassword]", error.message, error.code || "");
      res.status(error.code === "OTP_RATE_LIMITED" ? 429 : 400).json({
        message: toCustomerAuthMessage(error, "We could not start password reset right now. Please try again."),
        code: error.code,
      });
    }
  }

  async resetPassword(req, res) {
    try {
      const { email, email_otp_token, newPassword } = req.body;
      const result = await AuthService.resetPasswordWithEmailOtp(email, email_otp_token, newPassword);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:resetPassword]", error.message, error.code || "");
      res.status(400).json({
        message: toCustomerAuthMessage(error, "We could not reset your password right now. Please try again."),
      });
    }
  }

  async sendEmailOtp(req, res) {
    try {
      const { email, purpose, name } = req.body;
      const result = await AuthService.sendEmailOtp(email, purpose, name);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:sendEmailOtp]", error.message, error.code || "");
      res.status(400).json({ message: "We could not send the OTP right now. Please try again in a few minutes." });
    }
  }

  async verifyEmailOtp(req, res) {
    try {
      const { token, otp, purpose } = req.body;
      const result = await AuthService.verifyEmailOtp(token, otp, purpose);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:verifyEmailOtp]", error.message, error.code || "");
      res.status(400).json({ message: "The OTP is incorrect or expired. Please try again." });
    }
  }

  async adminForgotPassword(req, res) {
    try {
      const { email } = req.body;
      const result = await AuthService.adminForgotPassword(email);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:adminForgotPassword]", error.message);
      res.status(400).json({ message: error.message });
    }
  }

  async adminResetPassword(req, res) {
    try {
      const { email, email_otp_token, newPassword } = req.body;
      const result = await AuthService.adminResetPassword(email, email_otp_token, newPassword);
      res.json(result);
    } catch (error) {
      console.error("[AuthController:adminResetPassword]", error.message);
      res.status(400).json({ message: error.message });
    }
  }

  async logout(req, res) {
    try {
      await AuthService.logout(req.user.id, req.userRole);
      res.json({ message: "Logged out successfully" });
    } catch (error) {
      console.error("[AuthController:logout]", error.message);
      res.status(500).json({ message: error.message });
    }
  }
}

module.exports = new AuthController();
