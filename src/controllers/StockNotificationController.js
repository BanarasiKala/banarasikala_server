const StockNotification = require('../models/StockNotification');
const Product = require('../models/Product');
const EmailService = require('../services/EmailService');

// Lazy CREATE TABLE IF NOT EXISTS on first use (global schema sync is off; see config/db.js).
let ensured = null;
const ensureTable = () => {
  if (!ensured) {
    ensured = StockNotification.sync({ force: false }).catch((error) => {
      ensured = null;
      throw error;
    });
  }
  return ensured;
};

const toInt = (value) => {
  const next = Number(value);
  return Number.isInteger(next) ? next : null;
};

// Customer: "notify me when this product is back in stock."
exports.register = async (req, res) => {
  try {
    await ensureTable();
    const productId = toInt(req.params.productId);
    if (!productId) return res.status(400).json({ success: false, message: 'Product is required.' });

    const product = await Product.findByPk(productId, { attributes: ['id', 'name'] });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

    const email = String(req.user?.email || '').trim();
    if (!email) return res.status(400).json({ success: false, message: 'Your account has no email to notify.' });

    const colorId = toInt(req.body?.colorId);

    // One PENDING request per customer+product — clicking again while still waiting is a no-op.
    const [row, created] = await StockNotification.findOrCreate({
      where: { product_id: productId, customer_id: req.user.id, notified_at: null },
      defaults: {
        product_id: productId,
        customer_id: req.user.id,
        email,
        name: req.user.name || null,
        color_id: colorId,
      },
    });
    if (!created) {
      // Keep the contact details fresh if anything changed since they first asked.
      row.email = email;
      row.name = req.user.name || row.name;
      if (colorId) row.color_id = colorId;
      await row.save();
    }

    return res.status(created ? 201 : 200).json({
      success: true,
      already: !created,
      message: created
        ? 'We’ll email you as soon as it’s back in stock.'
        : 'You’re already on the list — we’ll email you when it’s back.',
    });
  } catch (error) {
    console.error('StockNotification register error:', error);
    return res.status(500).json({ success: false, message: 'Could not register your request right now.' });
  }
};

// Admin: email everyone waiting for this product, then mark them notified.
exports.sendRestock = async (req, res) => {
  try {
    await ensureTable();
    const productId = toInt(req.params.productId);
    if (!productId) return res.status(400).json({ success: false, message: 'Product is required.' });

    const product = await Product.findByPk(productId, {
      attributes: ['id', 'name', 'slug', 'images', 'selling_price', 'mrp_price'],
    });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

    const pending = await StockNotification.findAll({ where: { product_id: productId, notified_at: null } });
    if (!pending.length) {
      return res.status(200).json({ success: true, emailed: 0, message: 'No one is waiting to be notified for this product.' });
    }

    // De-dupe by email so a customer with more than one waiting row only gets one mail.
    const plainProduct = product.get({ plain: true });
    const seen = new Set();
    const now = new Date();
    let emailed = 0;
    for (const row of pending) {
      const key = String(row.email || '').toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        await EmailService.sendBackInStock(row.email, row.name, plainProduct);
        emailed += 1;
      }
      row.notified_at = now;
      await row.save();
    }

    return res.status(200).json({
      success: true,
      emailed,
      message: `Back-in-stock email sent to ${emailed} customer${emailed === 1 ? '' : 's'}.`,
    });
  } catch (error) {
    console.error('StockNotification send error:', error);
    return res.status(500).json({ success: false, message: 'Could not send the emails right now.' });
  }
};

exports.ensureTable = ensureTable;
