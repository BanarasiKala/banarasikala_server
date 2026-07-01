const { Op } = require("sequelize");
const { sequelize } = require("../config/db");
const Reel = require("../models/Reel");
const ReelComment = require("../models/ReelComment");
const ReelLike = require("../models/ReelLike");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const { deleteS3Object } = require("../config/s3");

// Attributes needed to render a shoppable product chip (View Product / Add to Cart).
const PRODUCT_CARD_ATTRIBUTES = [
  "id",
  "name",
  "slug",
  "selling_price",
  "mrp_price",
  "discount_percent",
  "images",
  "color_stocks",
  "variant_skus",
  "stock_quantity",
  "low_stock_threshold",
  "status",
];

// Keep only the cover colour's images so the chip shows a single representative
// photo, and expose that colour id as the default for add-to-cart.
const toProductCard = (product) => {
  const plain = typeof product.get === "function" ? product.get({ plain: true }) : product;
  const images = Array.isArray(plain.images) ? plain.images : [];
  const coverColorId =
    images.find((img) => img.is_cover)?.color_id ?? images[0]?.color_id ?? null;
  const coverImages = coverColorId
    ? images.filter((img) => img.color_id === coverColorId)
    : images;

  return {
    id: plain.id,
    name: plain.name,
    slug: plain.slug,
    selling_price: plain.selling_price,
    mrp_price: plain.mrp_price,
    discount_percent: plain.discount_percent,
    images: coverImages,
    color_stocks: plain.color_stocks || {},
    variant_skus: plain.variant_skus || {},
    stock_quantity: plain.stock_quantity,
    low_stock_threshold: plain.low_stock_threshold,
    status: plain.status,
    default_color_id: coverColorId,
  };
};

// Fetch active products for a reel, preserving the admin-chosen order.
const resolveProducts = async (productIds = []) => {
  const ids = (Array.isArray(productIds) ? productIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return [];

  const products = await Product.findAll({
    where: { id: { [Op.in]: ids }, status: "active" },
    attributes: PRODUCT_CARD_ATTRIBUTES,
  });

  const byId = new Map(products.map((p) => [p.id, toProductCard(p)]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
};

// Approved-comment counts for a batch of reels, in one query (avoids N+1).
const approvedCommentCounts = async (reelIds = []) => {
  if (reelIds.length === 0) return new Map();
  const rows = await ReelComment.findAll({
    where: { reel_id: { [Op.in]: reelIds }, is_approved: true },
    attributes: ["reel_id", [sequelize.fn("COUNT", sequelize.col("id")), "count"]],
    group: ["reel_id"],
    raw: true,
  });
  return new Map(rows.map((r) => [Number(r.reel_id), Number(r.count)]));
};

// Reel ids the customer has liked, from a batch (avoids N+1).
const likedReelIds = async (reelIds = [], customerId = null) => {
  if (!customerId || reelIds.length === 0) return new Set();
  const rows = await ReelLike.findAll({
    where: { reel_id: { [Op.in]: reelIds }, customer_id: customerId },
    attributes: ["reel_id"],
    raw: true,
  });
  return new Set(rows.map((r) => Number(r.reel_id)));
};

const serializeReel = (reel, { products = [], commentCount = 0, isLiked = false } = {}) => {
  const plain = typeof reel.get === "function" ? reel.get({ plain: true }) : reel;
  return {
    id: plain.id,
    title: plain.title,
    description: plain.description,
    video_url: plain.video_url,
    thumbnail_url: plain.thumbnail_url,
    like_count: plain.like_count,
    view_count: plain.view_count,
    comment_count: commentCount,
    is_liked: isLiked,
    display_order: plain.display_order,
    is_published: plain.is_published,
    products,
    created_at: plain.created_at,
  };
};

// ─── Public feed ────────────────────────────────────────────────────────────

const listPublishedReels = async ({ customerId = null, limit = 20, offset = 0 } = {}) => {
  const { rows, count } = await Reel.findAndCountAll({
    where: { is_published: true },
    order: [["display_order", "ASC"], ["created_at", "DESC"]],
    limit,
    offset,
  });

  const ids = rows.map((r) => r.id);
  const [counts, liked] = await Promise.all([
    approvedCommentCounts(ids),
    likedReelIds(ids, customerId),
  ]);

  const reels = await Promise.all(
    rows.map(async (reel) =>
      serializeReel(reel, {
        products: await resolveProducts(reel.product_ids),
        commentCount: counts.get(reel.id) || 0,
        isLiked: liked.has(reel.id),
      })
    )
  );

  return { reels, total: count, hasMore: offset + rows.length < count };
};

const getReelById = async (id, { customerId = null } = {}) => {
  const reel = await Reel.findByPk(id);
  if (!reel || !reel.is_published) return null;
  const [counts, liked, products] = await Promise.all([
    approvedCommentCounts([reel.id]),
    likedReelIds([reel.id], customerId),
    resolveProducts(reel.product_ids),
  ]);
  return serializeReel(reel, {
    products,
    commentCount: counts.get(reel.id) || 0,
    isLiked: liked.has(reel.id),
  });
};

const incrementView = async (id) => {
  await Reel.increment("view_count", { where: { id } });
};

// ─── Likes (customer) ───────────────────────────────────────────────────────

const toggleLike = async (reelId, customerId) => {
  const reel = await Reel.findByPk(reelId);
  if (!reel) throw new Error("Reel not found");

  return sequelize.transaction(async (transaction) => {
    const existing = await ReelLike.findOne({
      where: { reel_id: reelId, customer_id: customerId },
      transaction,
    });

    if (existing) {
      await existing.destroy({ transaction });
      await reel.decrement("like_count", { by: 1, transaction });
      return { liked: false, like_count: Math.max(0, reel.like_count - 1) };
    }

    await ReelLike.create({ reel_id: reelId, customer_id: customerId }, { transaction });
    await reel.increment("like_count", { by: 1, transaction });
    return { liked: true, like_count: reel.like_count + 1 };
  });
};

// ─── Comments ───────────────────────────────────────────────────────────────

const addComment = async (reelId, customerId, text) => {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Comment cannot be empty");
  const reel = await Reel.findByPk(reelId);
  if (!reel) throw new Error("Reel not found");

  const comment = await ReelComment.create({
    reel_id: reelId,
    customer_id: customerId,
    comment: trimmed.slice(0, 1000),
    is_approved: false,
  });
  return { id: comment.id, pending: true };
};

const listApprovedComments = async (reelId) => {
  const comments = await ReelComment.findAll({
    where: { reel_id: reelId, is_approved: true },
    order: [["created_at", "DESC"]],
    include: [{ model: Customer, attributes: ["id", "name"] }],
  });
  return comments.map((c) => {
    const plain = c.get({ plain: true });
    return {
      id: plain.id,
      comment: plain.comment,
      created_at: plain.created_at,
      author: plain.Customer?.name || "Guest",
    };
  });
};

// ─── Admin ──────────────────────────────────────────────────────────────────

const listAllReels = async () => {
  const rows = await Reel.findAll({
    order: [["display_order", "ASC"], ["created_at", "DESC"]],
  });
  const ids = rows.map((r) => r.id);
  const counts = await approvedCommentCounts(ids);
  return Promise.all(
    rows.map(async (reel) =>
      serializeReel(reel, {
        products: await resolveProducts(reel.product_ids),
        commentCount: counts.get(reel.id) || 0,
      })
    )
  );
};

const normalizeReelPayload = (data = {}) => {
  const productIds = (Array.isArray(data.product_ids) ? data.product_ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  return {
    title: data.title ? String(data.title).trim().slice(0, 200) : null,
    description: data.description ? String(data.description).trim() : null,
    video_url: data.video_url ? String(data.video_url).trim() : undefined,
    thumbnail_url: data.thumbnail_url ? String(data.thumbnail_url).trim() : null,
    product_ids: productIds,
    display_order: Number.isFinite(Number(data.display_order)) ? Number(data.display_order) : 0,
    is_published: data.is_published === undefined ? true : Boolean(data.is_published),
  };
};

const createReel = async (data) => {
  const payload = normalizeReelPayload(data);
  if (!payload.video_url) throw new Error("A video is required to create a reel");
  const reel = await Reel.create(payload);
  return serializeReel(reel, { products: await resolveProducts(reel.product_ids) });
};

const updateReel = async (id, data) => {
  const reel = await Reel.findByPk(id);
  if (!reel) throw new Error("Reel not found");
  const payload = normalizeReelPayload(data);

  // If the video changed, remove the old S3 object.
  if (payload.video_url && payload.video_url !== reel.video_url) {
    await deleteS3Object(reel.video_url);
  } else {
    delete payload.video_url; // keep existing video
  }

  await reel.update(payload);
  return serializeReel(reel, { products: await resolveProducts(reel.product_ids) });
};

const deleteReel = async (id) => {
  const reel = await Reel.findByPk(id);
  if (!reel) return;
  await deleteS3Object(reel.video_url);
  await reel.destroy(); // cascades to comments + likes
};

const listPendingComments = async () => {
  const comments = await ReelComment.findAll({
    where: { is_approved: false },
    order: [["created_at", "DESC"]],
    include: [
      { model: Customer, attributes: ["id", "name", "email"] },
      { model: Reel, attributes: ["id", "title"] },
    ],
  });
  return comments.map((c) => {
    const plain = c.get({ plain: true });
    return {
      id: plain.id,
      comment: plain.comment,
      created_at: plain.created_at,
      author: plain.Customer?.name || "Guest",
      author_email: plain.Customer?.email || null,
      reel_id: plain.reel_id,
      reel_title: plain.Reel?.title || `Reel #${plain.reel_id}`,
    };
  });
};

const approveComment = async (commentId) => {
  const comment = await ReelComment.findByPk(commentId);
  if (!comment) throw new Error("Comment not found");
  await comment.update({ is_approved: true });
  return { id: comment.id, is_approved: true };
};

const deleteComment = async (commentId) => {
  await ReelComment.destroy({ where: { id: commentId } });
};

module.exports = {
  listPublishedReels,
  getReelById,
  incrementView,
  toggleLike,
  addComment,
  listApprovedComments,
  listAllReels,
  createReel,
  updateReel,
  deleteReel,
  listPendingComments,
  approveComment,
  deleteComment,
};
