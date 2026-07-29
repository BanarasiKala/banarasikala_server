const { Op } = require('sequelize');
const Feedback = require('../models/Feedback');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const OrderItemAction = require('../models/OrderItemAction');
const AdminReviewController = require('./AdminReviewController');
const { generateUploadSignature, uploadBufferToCloudinary } = require('../config/cloudinary');
const { ensureFeedbackColumns } = require('../utils/dbConstraints');
const { exchangeTargetsOf } = require('../utils/exchangeTargets');
const { getSiteReviewFallback } = require('../utils/siteReviewFallback');

const toInt = (value) => {
  const next = Number(value);
  return Number.isInteger(next) ? next : null;
};

// Delivery is a fact stamped on delivered_at — the order's *status* can legitimately move
// on afterwards (shipping an exchange replacement puts the order back into 'Processing',
// see ExchangeReplacementService), and that must never retract the right to review a
// product the customer has already received. Mirrors isDeliveredEnoughForPostDeliveryAction.
const isReviewAllowedForOrder = (order) => {
  const status = String(order?.status || '').toLowerCase();
  return status === 'delivered' || Boolean(order?.delivered_at);
};

// The replacement product(s) an exchange on this line swapped TO. Reviewable only once the
// replacement itself has been delivered — which is exactly when the line reaches
// 'Exchange Completed' (ShipRocketController flips it there on the replacement's delivery
// scan). Before that the customer is still waiting for the parcel and has nothing to judge.
// exchangeTargetsOf normalises every historical shape the targets have been stored in.
const exchangeReplacementProductIds = (item) => {
  if (String(item?.status || '').toLowerCase() !== 'exchange completed') return [];

  return (item?.OrderItemActions || [])
    .filter((action) => String(action.action_type || '').toLowerCase() === 'exchange'
      && !['rejected', 'cancelled'].includes(String(action.status || '').toLowerCase()))
    .flatMap((action) => exchangeTargetsOf(action, item).map((target) => Number(target.product_id)))
    .filter(Boolean);
};

const serializeSummary = (rows) => {
  const ratings = rows.map((item) => Number(item.rating || 0)).filter((value) => value > 0);
  const count = ratings.length;
  const average = count ? Math.round((ratings.reduce((sum, value) => sum + value, 0) / count) * 10) / 10 : 0;
  return { average, count };
};

const uploadFeedbackImages = async (files = []) => {
  if (!files.length) return [];
  const limitedFiles = files.slice(0, 5);
  const uploads = [];
  for (const file of limitedFiles) {
    const uploaded = await uploadBufferToCloudinary(file.buffer, 'vns-saree/reviews');
    uploads.push({
      url: uploaded.secure_url,
      public_id: uploaded.public_id,
    });
  }
  return uploads;
};

const parseImagePayload = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [value];
    }
  }
  return [value];
};

const normalizeReviewImages = (value) =>
  parseImagePayload(value)
    .map((image) => {
      if (typeof image === 'string') return { url: image };
      if (!image || typeof image !== 'object') return null;
      const url = image.url || image.secure_url;
      if (!url) return null;
      return {
        url,
        public_id: image.public_id || null,
      };
    })
    .filter(Boolean)
    .slice(0, 5);

exports.getUploadSignature = (req, res) => {
  const sigData = generateUploadSignature('vns-saree/reviews');
  res.json({ ...sigData, resourceType: 'image' });
};

exports.submitFeedback = async (req, res) => {
  try {

    const rating = toInt(req.body.rating);
    const orderId = toInt(req.body.orderId || req.body.order_id);
    const orderItemId = toInt(req.body.orderItemId || req.body.order_item_id);
    const productId = toInt(req.body.productId || req.body.product_id);
    const title = String(req.body.title || '').trim().slice(0, 120);
    const comment = String(req.body.comment || '').trim();
    const customerId = req.user.id;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Please select a rating.' });
    }
    if (!orderId || !orderItemId || !productId) {
      return res.status(400).json({ success: false, message: 'Order and product details are required.' });
    }
    if (comment.length < 8) {
      return res.status(400).json({ success: false, message: 'Please write a short review about the product.' });
    }

    // The line is matched by id only — the product is verified below, because a review may
    // legitimately be for the product the customer ORDERED, or for the one they were sent
    // INSTEAD after an exchange (a different product_id on the same line).
    const order = await Order.findOne({
      where: {
        id: orderId,
        customer_id: customerId,
      },
      include: [{
        model: OrderItem,
        where: { id: orderItemId },
        required: true,
        include: [{ model: OrderItemAction, required: false }],
      }],
    });

    if (!order || !isReviewAllowedForOrder(order)) {
      return res.status(403).json({
        success: false,
        message: 'Review is available only after this product is delivered to your account.',
      });
    }

    const orderItem = (order.OrderItems || [])[0];
    const reviewableProductIds = [
      Number(orderItem?.product_id),
      ...exchangeReplacementProductIds(orderItem),
    ].filter(Boolean);

    if (!reviewableProductIds.includes(productId)) {
      return res.status(403).json({
        success: false,
        message: 'Review is available only after this product is delivered to your account.',
      });
    }

    const existing = await Feedback.findOne({
      where: {
        customer_id: customerId,
        order_id: orderId,
        order_item_id: orderItemId,
        product_id: productId,
      },
    });

    const uploadedImages = await uploadFeedbackImages(req.files || []);
    const submittedImages = normalizeReviewImages(req.body.images);
    const images = [...submittedImages, ...uploadedImages].slice(0, 5);
    let feedback = existing;

    if (existing) {
      feedback.rating = rating;
      feedback.title = title || null;
      feedback.comment = comment;
      if (images.length) feedback.images = images;
      feedback.is_approved = false;
      await feedback.save();
    } else {
      feedback = await Feedback.create({
        customer_id: customerId,
        order_id: orderId,
        order_item_id: orderItemId,
        product_id: productId,
        rating,
        title: title || null,
        comment,
        images,
        is_approved: false,
      });
    }

    res.status(201).json({
      success: true,
      message: existing
        ? 'Review updated successfully. It will be visible after admin approval.'
        : 'Review submitted successfully. It will be visible after admin approval.',
      data: feedback,
    });
  } catch (error) {
    console.error('Submit feedback error:', error);
    res.status(500).json({ success: false, message: 'Could not submit your review right now.' });
  }
};

exports.submitGeneralFeedback = async (req, res) => {
  try {

    const rating = toInt(req.body.rating);
    const comment = String(req.body.comment || '').trim();
    const customerId = req.user.id;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Please select a rating.' });
    }
    if (comment.length < 8) {
      return res.status(400).json({ success: false, message: 'Please write a short review.' });
    }

    await Feedback.create({
      customer_id: customerId,
      rating,
      comment,
      is_approved: false,
    });

    res.status(201).json({ success: true, message: 'Feedback submitted.' });
  } catch (error) {
    console.error('Submit general feedback error:', error);
    res.status(500).json({ success: false, message: 'Could not submit your feedback right now.' });
  }
};

// `?fallback=1` opts into the curated site reviews when no real one has been approved yet.
// Opt-in rather than default because the admin panel reads this same endpoint to manage the
// approved list — seeded rows there would be undeletable noise.
const wantsFallback = (req) => ['1', 'true', 'yes'].includes(String(req.query.fallback || '').toLowerCase());

exports.getApprovedFeedback = async (req, res) => {
  try {
    await ensureFeedbackColumns();
    const feedbacks = await Feedback.findAll({
      where: { is_approved: true, product_id: { [Op.is]: null }, order_id: { [Op.is]: null } },
      include: [
        { model: Customer, attributes: ['name', 'avatar_url'] },
        { model: Product, attributes: ['id', 'name', 'slug'] },
      ],
      order: [['created_at', 'DESC']],
    });

    const general = feedbacks.filter((f) => f.product_id == null && f.order_id == null);

    // Real feedback always wins; the curated list only stands in while there is none at all.
    if (!general.length && wantsFallback(req)) {
      return res.status(200).json({ success: true, data: getSiteReviewFallback(), is_seed: true });
    }

    res.status(200).json({ success: true, data: general });
  } catch (error) {
    console.error('Get feedback error:', error);
    // The home page should still show something if the reviews table is unreachable.
    if (wantsFallback(req)) {
      return res.status(200).json({ success: true, data: getSiteReviewFallback(), is_seed: true });
    }
    res.status(500).json({ success: false, message: 'Failed to fetch feedback' });
  }
};

exports.getProductFeedback = async (req, res) => {
  try {
    await ensureFeedbackColumns();
    const productId = toInt(req.params.productId);
    if (!productId) {
      return res.status(400).json({ success: false, message: 'Product is required.' });
    }

    const feedbacks = await Feedback.findAll({
      where: { product_id: productId, is_approved: true },
      include: [{ model: Customer, attributes: ['name', 'avatar_url'] }],
      order: [['created_at', 'DESC']],
    });

    // Real customer reviews always win. Only when a product has none do the admin's seed
    // reviews stand in — and if there are no seed reviews either, the arrays are simply empty.
    if (feedbacks.length) {
      return res.status(200).json({
        success: true,
        data: { summary: serializeSummary(feedbacks), reviews: feedbacks },
      });
    }

    const seedRows = await AdminReviewController.getActiveForProduct(productId);
    const seedReviews = seedRows.map(AdminReviewController.toPublicReview);
    return res.status(200).json({
      success: true,
      data: {
        summary: serializeSummary(seedReviews),
        reviews: seedReviews,
        is_seed: seedReviews.length > 0,
      },
    });
  } catch (error) {
    console.error('Get product feedback error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch product reviews' });
  }
};

exports.getPendingFeedback = async (req, res) => {
  try {
    await ensureFeedbackColumns();
    const feedbacks = await Feedback.findAll({
      where: { is_approved: false },
      include: [
        { model: Customer, attributes: ['name', 'email'] },
        { model: Product, attributes: ['id', 'name', 'slug'] },
      ],
      order: [['created_at', 'ASC']],
    });

    res.status(200).json({ success: true, data: feedbacks });
  } catch (error) {
    console.error('Get pending feedback error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch pending feedback' });
  }
};

exports.approveFeedback = async (req, res) => {
  try {
    await ensureFeedbackColumns();
    const { id } = req.params;
    const feedback = await Feedback.findByPk(id);

    if (!feedback) {
      return res.status(404).json({ success: false, message: 'Feedback not found' });
    }

    feedback.is_approved = true;
    await feedback.save();

    res.status(200).json({ success: true, message: 'Feedback approved successfully' });
  } catch (error) {
    console.error('Approve feedback error:', error);
    res.status(500).json({ success: false, message: 'Failed to approve feedback' });
  }
};

/**
 * Turn the "Verified Buyer" badge on or off for one customer review.
 *
 * Every row here IS from a delivered order, so the flag starts true and this exists for the
 * exceptions — a review the admin has reason to show without vouching for it.
 */
exports.setFeedbackVerified = async (req, res) => {
  try {
    await ensureFeedbackColumns();
    const feedback = await Feedback.findByPk(req.params.id);
    if (!feedback) {
      return res.status(404).json({ success: false, message: 'Feedback not found' });
    }

    feedback.is_verified = Boolean(req.body.is_verified);
    await feedback.save();

    return res.status(200).json({ success: true, data: { id: feedback.id, is_verified: feedback.is_verified } });
  } catch (error) {
    console.error('Set feedback verified error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update the verified badge' });
  }
};

/**
 * Set the badge across every customer review at once, or every review of one product.
 *
 * The one-at-a-time route is unusable at catalogue scale, and a half-finished pass is worse
 * than either state: a shopper reading two badged reviews and one unbadged infers something
 * about the unbadged one that is not true.
 */
exports.setFeedbackVerifiedBulk = async (req, res) => {
  try {
    await ensureFeedbackColumns();
    const verified = Boolean(req.body.is_verified);
    const productId = toInt(req.body.product_id ?? req.body.productId);
    // Product reviews only — a general site testimonial has no purchase to be verified about.
    const where = productId ? { product_id: productId } : { product_id: { [Op.not]: null } };

    const [updated] = await Feedback.update({ is_verified: verified }, { where });
    return res.status(200).json({
      success: true,
      updated,
      message: `${updated} review${updated === 1 ? '' : 's'} marked ${verified ? 'verified' : 'unverified'}.`,
    });
  } catch (error) {
    console.error('Bulk feedback verified error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update the verified badges' });
  }
};

exports.deleteFeedback = async (req, res) => {
  try {
    await ensureFeedbackColumns();
    const { id } = req.params;
    const feedback = await Feedback.findByPk(id);

    if (!feedback) {
      return res.status(404).json({ success: false, message: 'Feedback not found' });
    }

    await feedback.destroy();

    res.status(200).json({ success: true, message: 'Feedback deleted successfully' });
  } catch (error) {
    console.error('Delete feedback error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete feedback' });
  }
};
