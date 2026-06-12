const WalletTransaction = require("../models/WalletTransaction");
const Customer = require("../models/Customer");

class WalletController {
  async getWallet(req, res) {
    try {
      const customerId = req.user?.id;
      const customer = await Customer.findByPk(customerId, {
        attributes: ["id", "wallet_balance", "referral_code", "referred_by_id"],
      });

      if (!customer) return res.status(404).json({ message: "Customer not found" });

      const transactions = await WalletTransaction.findAll({
        where: { customer_id: customerId },
        order: [["created_at", "DESC"]],
        limit: 100,
      });

      return res.status(200).json({
        wallet_balance: customer.wallet_balance,
        referral_code: customer.referral_code,
        referred_by_id: customer.referred_by_id,
        transactions,
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }
}

module.exports = new WalletController();

