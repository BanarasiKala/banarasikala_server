const Customer = require("../models/Customer");
const WalletService = require("../services/WalletService");
const { config } = require("../config/env");

class ReferralController {
  async me(req, res) {
    try {
      const customerId = req.user?.id;
      const customer = await Customer.findByPk(customerId, {
        attributes: ["id", "referral_code", "referred_by_id", "wallet_balance"],
      });
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      return res.status(200).json({
        referral_code: customer.referral_code,
        referred_by_id: customer.referred_by_id,
        wallet_balance: customer.wallet_balance,
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }

  async apply(req, res) {
    try {
      const customerId = req.user?.id;
      const { referral_code } = req.body || {};
      if (!referral_code) return res.status(400).json({ message: "referral_code is required" });

      const customer = await Customer.findByPk(customerId);
      if (!customer) return res.status(404).json({ message: "Customer not found" });
      if (customer.referred_by_id) {
        return res.status(400).json({ message: "Referral code already applied" });
      }

      const referrer = await Customer.findOne({ where: { referral_code } });
      if (!referrer) return res.status(400).json({ message: "Invalid referral code" });
      if (referrer.id === customer.id) {
        return res.status(400).json({ message: "You cannot refer yourself" });
      }

      await customer.update({ referred_by_id: referrer.id });
      await WalletService.creditNow({
        customerId: customer.id,
        amount: config.referralSignupBonus,
        type: "REFERRAL_SIGNUP_BONUS",
        dedupeKey: `ref_signup:${customer.id}`,
        meta: { referrer_id: referrer.id },
      });

      return res.status(200).json({ message: "Referral applied successfully" });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }
}

module.exports = new ReferralController();
