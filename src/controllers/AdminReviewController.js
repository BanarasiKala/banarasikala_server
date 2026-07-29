const AdminReview = require('../models/AdminReview');
const { sequelize } = require('../config/db');

// The table is created lazily the first time this controller (or the storefront fallback) runs
// — CREATE TABLE IF NOT EXISTS, never altering an existing one, matching how other bolt-on
// tables self-create in this codebase (global schema sync is off; see config/db.js). Memoised
// so it runs once per process; on failure the promise is cleared so a later call can retry.
//
// Columns added AFTER the table first shipped need their own ALTER: sync({ force: false }) is
// CREATE TABLE IF NOT EXISTS and does nothing at all to a table that already exists, so a new
// model attribute would be missing on every deployment that ran the old code. The ALTER is
// IF NOT EXISTS, so it is a no-op on a fresh table sync just created.
let ensured = null;
const ensureTable = () => {
  if (!ensured) {
    ensured = AdminReview.sync({ force: false })
      .then(() => sequelize.query(
        `ALTER TABLE "${AdminReview.options.schema}"."${AdminReview.options.tableName}" `
        + `ADD COLUMN IF NOT EXISTS "is_verified" BOOLEAN NOT NULL DEFAULT FALSE`,
      ))
      .catch((error) => {
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

const clampRating = (value) => {
  const n = toInt(value);
  if (n == null) return null;
  return Math.min(5, Math.max(1, n));
};

// Accept an array of URL strings or { url } objects; store a clean [{ url }] list (max 6), the
// same shape a real review's images use so the storefront renders them identically.
const normalizeImages = (value) => {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((image) => {
      if (typeof image === 'string') return image.trim() ? { url: image.trim() } : null;
      const url = image?.url || image?.secure_url;
      return url ? { url: String(url).trim() } : null;
    })
    .filter(Boolean)
    .slice(0, 6);
};

// An admin (seed) review row → the public review shape the storefront already renders, so no
// client change is needed. A synthetic string id keeps React keys unique and can never collide
// with a real feedback's numeric id.
const toPublicReview = (row) => ({
  id: `seed-${row.id}`,
  rating: row.rating,
  title: row.title || null,
  comment: row.comment,
  images: Array.isArray(row.images) ? row.images : [],
  Customer: { name: row.reviewer_name },
  created_at: row.review_date || row.created_at,
  is_verified: Boolean(row.is_verified),
  is_seed: true,
});

const summarize = (rows) => {
  const ratings = rows.map((r) => Number(r.rating || 0)).filter((v) => v > 0);
  const count = ratings.length;
  const average = count ? Math.round((ratings.reduce((s, v) => s + v, 0) / count) * 10) / 10 : 0;
  return { average, count };
};

// Active seed reviews for a product, newest-first within the admin's chosen order. Used by the
// storefront fallback (FeedbackController) and the listing-summary fallback (ProductService).
const getActiveForProduct = async (productId) => {
  await ensureTable();
  return AdminReview.findAll({
    where: { product_id: productId, is_active: true },
    order: [['display_order', 'ASC'], ['created_at', 'DESC']],
  });
};

// ── Admin CRUD ────────────────────────────────────────────────────────────────────────────

// Every seed review for a product, active or not, for the management screen.
exports.listForProduct = async (req, res) => {
  try {
    await ensureTable();
    const productId = toInt(req.params.productId || req.query.productId);
    if (!productId) return res.status(400).json({ success: false, message: 'Product is required.' });

    const rows = await AdminReview.findAll({
      where: { product_id: productId },
      order: [['display_order', 'ASC'], ['created_at', 'DESC']],
    });
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('AdminReview list error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load reviews.' });
  }
};

exports.create = async (req, res) => {
  try {
    await ensureTable();
    const productId = toInt(req.body.product_id || req.body.productId);
    const reviewerName = String(req.body.reviewer_name || req.body.reviewerName || '').trim().slice(0, 120);
    const rating = clampRating(req.body.rating);
    const comment = String(req.body.comment || '').trim();
    const title = String(req.body.title || '').trim().slice(0, 160) || null;

    if (!productId) return res.status(400).json({ success: false, message: 'Product is required.' });
    if (!reviewerName) return res.status(400).json({ success: false, message: 'Reviewer name is required.' });
    if (!rating) return res.status(400).json({ success: false, message: 'Please choose a rating from 1 to 5.' });
    if (comment.length < 3) return res.status(400).json({ success: false, message: 'Please write the review text.' });

    const row = await AdminReview.create({
      product_id: productId,
      reviewer_name: reviewerName,
      rating,
      title,
      comment,
      images: normalizeImages(req.body.images),
      review_date: req.body.review_date ? new Date(req.body.review_date) : null,
      display_order: toInt(req.body.display_order) ?? 0,
      is_active: req.body.is_active === undefined ? true : Boolean(req.body.is_active),
      is_verified: Boolean(req.body.is_verified),
    });
    return res.status(201).json({ success: true, data: row });
  } catch (error) {
    console.error('AdminReview create error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save review.' });
  }
};

exports.update = async (req, res) => {
  try {
    await ensureTable();
    const row = await AdminReview.findByPk(toInt(req.params.id));
    if (!row) return res.status(404).json({ success: false, message: 'Review not found.' });

    if (req.body.reviewer_name !== undefined || req.body.reviewerName !== undefined) {
      const name = String(req.body.reviewer_name ?? req.body.reviewerName ?? '').trim().slice(0, 120);
      if (!name) return res.status(400).json({ success: false, message: 'Reviewer name is required.' });
      row.reviewer_name = name;
    }
    if (req.body.rating !== undefined) {
      const rating = clampRating(req.body.rating);
      if (!rating) return res.status(400).json({ success: false, message: 'Please choose a rating from 1 to 5.' });
      row.rating = rating;
    }
    if (req.body.comment !== undefined) {
      const comment = String(req.body.comment || '').trim();
      if (comment.length < 3) return res.status(400).json({ success: false, message: 'Please write the review text.' });
      row.comment = comment;
    }
    if (req.body.title !== undefined) row.title = String(req.body.title || '').trim().slice(0, 160) || null;
    if (req.body.images !== undefined) row.images = normalizeImages(req.body.images);
    if (req.body.review_date !== undefined) row.review_date = req.body.review_date ? new Date(req.body.review_date) : null;
    if (req.body.display_order !== undefined) row.display_order = toInt(req.body.display_order) ?? 0;
    if (req.body.is_active !== undefined) row.is_active = Boolean(req.body.is_active);
    if (req.body.is_verified !== undefined) row.is_verified = Boolean(req.body.is_verified);

    await row.save();
    return res.status(200).json({ success: true, data: row });
  } catch (error) {
    console.error('AdminReview update error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update review.' });
  }
};

exports.remove = async (req, res) => {
  try {
    await ensureTable();
    const row = await AdminReview.findByPk(toInt(req.params.id));
    if (!row) return res.status(404).json({ success: false, message: 'Review not found.' });
    await row.destroy();
    return res.status(200).json({ success: true, message: 'Review deleted.' });
  } catch (error) {
    console.error('AdminReview delete error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete review.' });
  }
};

/**
 * Set the Verified Buyer badge on every seed review at once — for one product when a
 * `productId` is given, otherwise across the catalogue.
 *
 * Toggling thirty seed reviews one at a time is the kind of task that gets abandoned halfway,
 * which leaves a product showing some badged reviews and some not for no reason a shopper
 * could infer.
 */
exports.setVerifiedBulk = async (req, res) => {
  try {
    await ensureTable();
    const verified = Boolean(req.body.is_verified);
    const productId = toInt(req.body.product_id ?? req.body.productId);

    const [updated] = await AdminReview.update(
      { is_verified: verified },
      { where: productId ? { product_id: productId } : {} },
    );
    return res.status(200).json({
      success: true,
      updated,
      message: `${updated} seed review${updated === 1 ? '' : 's'} marked ${verified ? 'verified' : 'unverified'}.`,
    });
  } catch (error) {
    console.error('AdminReview bulk verify error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update reviews.' });
  }
};

// Exposed for the storefront read fallbacks.
exports.getActiveForProduct = getActiveForProduct;
exports.toPublicReview = toPublicReview;
exports.summarize = summarize;
exports.ensureTable = ensureTable;
