const { Op, fn, col, literal } = require("sequelize");
const Customer = require("../models/Customer");
const Feedback = require("../models/Feedback");
const { uploadBufferToCloudinary, destroyCloudinaryImage } = require("../config/cloudinary");
const { ensureCustomerColumns } = require("../utils/dbConstraints");

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

  // ── Admin: User Directory ────────────────────────────────────────────────────────────

  /**
   * Customers for the admin directory, newest first, with how many reviews each has written.
   *
   * The review count is the reason this exists as its own query rather than a plain findAll:
   * the Verified Buyer switch is meaningless for someone who has never written a review, and
   * the count is what lets the admin see at a glance who it actually affects.
   */
  async adminList(req, res) {
    try {
      await ensureCustomerColumns();
      const search = String(req.query.search || "").trim();
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));

      const where = {};
      if (search) {
        where[Op.or] = [
          { name: { [Op.iLike]: `%${search}%` } },
          { email: { [Op.iLike]: `%${search}%` } },
          { phone: { [Op.iLike]: `%${search}%` } },
        ];
      }

      // "createdAt", not "created_at": this model is NOT underscored (see Customer.js), unlike
      // most others here. Feedback below IS, hence the two spellings a few lines apart.
      const customers = await Customer.findAll({
        where,
        attributes: [
          "id", "name", "email", "phone", "avatar_url",
          "is_verified", "email_verified", "phone_verified", "createdAt",
        ],
        order: [["createdAt", "DESC"]],
        limit,
      });

      // Counted in one grouped query rather than a subquery per row — a directory of a few
      // hundred customers would otherwise issue a few hundred COUNTs.
      const counts = await Feedback.findAll({
        attributes: ["customer_id", [fn("COUNT", col("id")), "review_count"]],
        where: { customer_id: { [Op.in]: customers.map((c) => c.id) } },
        group: ["customer_id"],
        raw: true,
      });
      const countByCustomer = new Map(counts.map((row) => [Number(row.customer_id), Number(row.review_count)]));

      return res.status(200).json({
        success: true,
        data: customers.map((customer) => ({
          ...customer.toJSON(),
          review_count: countByCustomer.get(Number(customer.id)) || 0,
        })),
      });
    } catch (error) {
      console.error("Admin customer list error:", error);
      return res.status(500).json({ success: false, message: "Failed to load customers." });
    }
  }

  /** Turn the Verified Buyer badge on or off for one customer, across all their reviews. */
  async setVerified(req, res) {
    try {
      await ensureCustomerColumns();
      const customer = await Customer.findByPk(req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });

      customer.is_verified = Boolean(req.body.is_verified);
      await customer.save();
      return res.status(200).json({
        success: true,
        data: { id: customer.id, is_verified: customer.is_verified },
      });
    } catch (error) {
      console.error("Set customer verified error:", error);
      return res.status(500).json({ success: false, message: "Failed to update the customer." });
    }
  }

  /** The same switch for everyone at once. */
  async setVerifiedBulk(req, res) {
    try {
      await ensureCustomerColumns();
      const verified = Boolean(req.body.is_verified);
      // `literal('TRUE')` rather than `{}`: Sequelize refuses a bulk update with an empty
      // where clause, which is a sensible guard in general and the thing being deliberately
      // opted out of here.
      const [updated] = await Customer.update({ is_verified: verified }, { where: literal("TRUE") });
      return res.status(200).json({
        success: true,
        updated,
        message: `${updated} customer${updated === 1 ? "" : "s"} marked ${verified ? "verified" : "unverified"}.`,
      });
    } catch (error) {
      console.error("Bulk customer verified error:", error);
      return res.status(500).json({ success: false, message: "Failed to update customers." });
    }
  }

}

module.exports = new CustomerController();
