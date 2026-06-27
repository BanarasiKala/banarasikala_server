const Coupon = require('../models/Coupon');
const { Op, fn, col } = require('sequelize');
const Product = require('../models/Product');
const Variety = require('../models/Variety');
const Color = require('../models/Color');
const Occasion = require('../models/Occasion');

class CouponService {
  // Build a Sequelize where-fragment that identifies a single shopper across
  // both logged-in (customer_id) and guest (customer_email) orders. Returns
  // null when we have no way to identify the user (so callers skip per-user logic).
  _identityWhere({ customerId, email } = {}) {
    const clauses = [];
    if (customerId) clauses.push({ customer_id: customerId });
    if (email) clauses.push({ customer_email: email });
    if (clauses.length === 0) return null;
    return clauses.length === 1 ? clauses[0] : { [Op.or]: clauses };
  }

  // How many times this shopper has *actively* used a coupon. We derive it from
  // the orders table (no separate redemption table) and exclude cancelled orders,
  // mirroring how the global usage_count is incremented on order / decremented on cancel.
  async getUserCouponUsage(code, identity = {}, options = {}) {
    if (!code) return 0;
    const where = this._identityWhere(identity);
    if (!where) return 0;
    const Order = require('../models/Order');
    return await Order.count({
      where: {
        coupon_code: code,
        status: { [Op.ne]: 'Cancelled' },
        ...where,
      },
      transaction: options.transaction,
    });
  }

  // Returns all coupons. When a shopper identity is supplied, each coupon is
  // annotated with `user_usage_count` and `user_eligible` so the storefront can
  // hide coupons the shopper has exhausted (per-user or global limit). The extra
  // fields are additive — callers that don't pass a customer (e.g. admin) get the
  // plain rows unchanged.
  async getAllCoupons(customer = null) {
    const coupons = await Coupon.findAll();
    const where = customer ? this._identityWhere(customer) : null;
    if (!where) return coupons;

    const Order = require('../models/Order');
    const usageRows = await Order.findAll({
      attributes: ['coupon_code', [fn('COUNT', col('id')), 'cnt']],
      where: {
        coupon_code: { [Op.ne]: null },
        status: { [Op.ne]: 'Cancelled' },
        ...where,
      },
      group: ['coupon_code'],
      raw: true,
    });
    const usageByCode = {};
    usageRows.forEach((row) => {
      if (row.coupon_code) usageByCode[row.coupon_code] = Number(row.cnt) || 0;
    });

    return coupons.map((coupon) => {
      const json = coupon.toJSON();
      const used = usageByCode[json.code] || 0;
      const perUserLimit = Number(json.usage_limit_per_user || 0);
      const perUserReached = perUserLimit > 0 && used >= perUserLimit;
      const globalReached = json.usage_limit != null
        && Number(json.usage_count || 0) >= Number(json.usage_limit);
      return {
        ...json,
        user_usage_count: used,
        user_eligible: !perUserReached && !globalReached,
      };
    });
  }

  async getHomepageCoupons() {
    const now = new Date();

    return await Coupon.findAll({
      where: {
        is_active: true,
        display_on_homepage: true,
        [Op.and]: [
          {
            [Op.or]: [
              { valid_from: null },
              { valid_from: { [Op.lte]: now } }
            ]
          },
          {
            [Op.or]: [
              { valid_until: null },
              { valid_until: { [Op.gte]: now } }
            ]
          }
        ]
      },
      attributes: ['code', 'discount_percent', 'banner_text'],
      order: [['valid_until', 'ASC'], ['id', 'ASC']],
      raw: true
    });
  }

  async getCouponById(id) {
    return await Coupon.findByPk(id);
  }

  async getCouponByCode(code) {
    return await Coupon.findOne({ where: { code, is_active: true } });
  }

  async createCoupon(data) {
    return await Coupon.create(data);
  }

  async updateCoupon(id, data) {
    const coupon = await Coupon.findByPk(id);
    if (!coupon) throw new Error('Coupon not found');
    return await coupon.update(data);
  }

  async deleteCoupon(id) {
    const coupon = await Coupon.findByPk(id);
    if (!coupon) throw new Error('Coupon not found');
    return await coupon.destroy();
  }

  async validateCoupon(code, amount, customer = {}) {
    // Accept a legacy email string or a { customerId, email } identity object.
    const identity = typeof customer === 'string' ? { email: customer } : (customer || {});

    const coupon = await Coupon.findOne({ where: { code, is_active: true } });
    if (!coupon) throw new Error('Invalid coupon code');

    // Check expiry
    const now = new Date();
    if (coupon.valid_from && new Date(coupon.valid_from) > now) throw new Error('Coupon not yet active');
    if (coupon.valid_until && new Date(coupon.valid_until) < now) throw new Error('Coupon expired');

    // Check global usage limit
    if (coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit) {
      throw new Error('Coupon usage limit reached');
    }

    // Check per-user usage limit
    const perUserLimit = Number(coupon.usage_limit_per_user || 0);
    if (perUserLimit > 0) {
      const used = await this.getUserCouponUsage(code, identity);
      if (used >= perUserLimit) {
        throw new Error('You have already used this coupon.');
      }
    }

    // Check minimum purchase
    if (amount < coupon.min_purchase_amount) {
      throw new Error(`Minimum purchase amount of ₹${coupon.min_purchase_amount} required`);
    }

    // Calculate discount. DECIMAL columns come back from the DB as strings, so
    // coerce every operand to Number before doing any math / .toFixed.
    const numAmount = Number(amount) || 0;
    let discount = 0;
    if (coupon.discount_type === 'percentage') {
      discount = (numAmount * Number(coupon.discount_percent || 0)) / 100;
      if (coupon.max_discount_amount) {
        discount = Math.min(discount, Number(coupon.max_discount_amount) || 0);
      }
    } else {
      discount = Number(coupon.discount_amount) || 0;
    }
    discount = Number(discount) || 0;

    return {
      couponId: coupon.id,
      code: coupon.code,
      discount: parseFloat(discount.toFixed(2)),
      discount_type: coupon.discount_type
    };
  }
}

module.exports = new CouponService();
