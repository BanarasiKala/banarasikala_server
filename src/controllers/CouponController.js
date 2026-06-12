const CouponService = require('../services/CouponService');

class CouponController {
  async getAll(req, res) {
    try {
      const coupons = await CouponService.getAllCoupons();
      res.status(200).json(coupons);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getHomepageCoupons(req, res) {
    try {
      const coupons = await CouponService.getHomepageCoupons();
      res.status(200).json(coupons);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getById(req, res) {
    try {
      const coupon = await CouponService.getCouponById(req.params.id);
      if (!coupon) return res.status(404).json({ message: 'Coupon not found' });
      res.status(200).json(coupon);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async create(req, res) {
    try {
      const coupon = await CouponService.createCoupon(req.body);
      res.status(201).json(coupon);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async update(req, res) {
    try {
      const coupon = await CouponService.updateCoupon(req.params.id, req.body);
      res.status(200).json(coupon);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async delete(req, res) {
    try {
      await CouponService.deleteCoupon(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async validate(req, res) {
    try {
      const { code, amount, email } = req.body;
      const result = await CouponService.validateCoupon(code, amount, email);
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }
}

module.exports = new CouponController();
