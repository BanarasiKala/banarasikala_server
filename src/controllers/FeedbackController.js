const Feedback = require('../models/Feedback');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const { generateUploadSignature, uploadBufferToCloudinary } = require('../config/cloudinary');
const { ensureFeedbackColumns } = require('../utils/feedbackSchema');

const toInt = (value) => {
  const next = Number(value);
  return Number.isInteger(next) ? next : null;
};

const PRE_DELIVERY_STATUSES = new Set([
  'pending',
  'order placed',
  'order_placed',
  'processing',
  'picked up',
  'picked_up',
  'awb assigned',
  'awb_assigned',
  'shipped',
  'out for delivery',
  'out_for_delivery',
  'undelivered',
  'rto initiated',
  'rto_initiated',
  'rto in transit',
  'rto_in_transit',
]);

const isReviewAllowedForOrder = (order) => {
  const status = String(order?.status || '').toLowerCase();
  if (PRE_DELIVERY_STATUSES.has(status)) return false;
  return status === 'delivered' || Boolean(order?.delivered_at);
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
    await ensureFeedbackColumns();

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

    const order = await Order.findOne({
      where: {
        id: orderId,
        customer_id: customerId,
      },
      include: [{
        model: OrderItem,
        where: { id: orderItemId, product_id: productId },
        required: true,
      }],
    });

    if (!order || !isReviewAllowedForOrder(order)) {
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
    await ensureFeedbackColumns();

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

exports.getApprovedFeedback = async (req, res) => {
  try {
    await ensureFeedbackColumns();
    const feedbacks = await Feedback.findAll({
      where: { is_approved: true },
      include: [
        { model: Customer, attributes: ['name'] },
        { model: Product, attributes: ['id', 'name', 'slug'] },
      ],
      order: [['created_at', 'DESC']],
    });

    res.status(200).json({ success: true, data: feedbacks });
  } catch (error) {
    console.error('Get feedback error:', error);
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
      include: [{ model: Customer, attributes: ['name'] }],
      order: [['created_at', 'DESC']],
    });

    res.status(200).json({
      success: true,
      data: {
        summary: serializeSummary(feedbacks),
        reviews: feedbacks,
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
