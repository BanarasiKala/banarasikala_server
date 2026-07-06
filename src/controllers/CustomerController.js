const Customer = require("../models/Customer");
const { uploadBufferToCloudinary, destroyCloudinaryImage } = require("../config/cloudinary");

const generateReferralCode = () =>
  `VNS${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

class CustomerController {
  async me(req, res) {
    try {
      let customer = await Customer.findByPk(req.user.id, {
        attributes: [
          "id",
          "name",
          "email",
          "phone",
          "wallet_balance",
          "referral_code",
          "referred_by_id",
          "avatar_url",
          "is_cod_blocked",
          "createdAt",
        ],
      });
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      // Backfill referral_code for older accounts.
      if (!customer.referral_code) {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await Customer.update(
              { referral_code: generateReferralCode() },
              { where: { id: customer.id } },
            );
            break;
          } catch (err) {
            if (err?.name === "SequelizeUniqueConstraintError") continue;
            throw err;
          }
        }

        customer = await Customer.findByPk(req.user.id, {
          attributes: [
            "id",
            "name",
            "email",
            "phone",
            "wallet_balance",
            "referral_code",
            "referred_by_id",
            "avatar_url",
            "createdAt",
          ],
        });
      }

      return res.status(200).json(customer);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }

  async updateMe(req, res) {
    try {
      const { name, email } = req.body || {};
      const customer = await Customer.findByPk(req.user.id);
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      const payload = {};
      if (typeof name === "string" && name.trim()) payload.name = name.trim();
      if (typeof email === "string" && email.trim()) payload.email = email.trim().toLowerCase();

      await customer.update(payload);
      return res.status(200).json({ message: "Profile updated", customer });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }

  async uploadAvatar(req, res) {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({ message: "avatar file is required" });
      }

      const customer = await Customer.findByPk(req.user.id);
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      const previousAvatarUrl = customer.avatar_url;

      const uploadResult = await uploadBufferToCloudinary(
        req.file.buffer,
        "vns-saree/customers/avatars",
      );

      await customer.update({ avatar_url: uploadResult.secure_url });

      // Remove the old avatar from Cloudinary so they don't pile up (fire-and-forget).
      if (previousAvatarUrl && previousAvatarUrl !== uploadResult.secure_url) {
        destroyCloudinaryImage(previousAvatarUrl);
      }

      return res.status(200).json({
        message: "Avatar updated",
        avatar_url: customer.avatar_url,
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }

}

module.exports = new CustomerController();
