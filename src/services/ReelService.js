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

// Comment counts for a batch of reels, in one query (avoids N+1). Replies count too:
// the number under the speech bubble is "how much conversation is in here", which is what
// the reader is deciding whether to open, and a thread of ten replies is not one comment.
const commentCounts = async (reelIds = []) => {
  if (reelIds.length === 0) return new Map();
  const rows = await ReelComment.findAll({
    where: { reel_id: { [Op.in]: reelIds } },
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

/**
 * The /reels feed, shuffled on every request.
 *
 * `display_order` still leads, so a reel the admin has pinned keeps its place; RANDOM()
 * only decides the order WITHIN a tier. Today every reel sits at the default 0, so the
 * whole feed comes back jumbled — and the moment someone does pin one, pinning still
 * means something instead of being silently overridden by the shuffle.
 *
 * `created_at DESC` is gone as the tiebreak: it was the thing making the feed identical
 * on every visit, so a viewer met the same reel first every time.
 *
 * Only this feed is randomised. The admin list and the product-page reels keep their
 * deterministic order — a grid you are administering must not move under you, and a
 * product's own reels are few enough that shuffling them says nothing.
 *
 * Note on paging: with RANDOM() an offset-based second page can repeat or miss rows,
 * since each query re-rolls the order. Harmless as things stand — the client fetches one
 * page and loops it — but a real "load more" would need a seeded ordering instead.
 */
const listPublishedReels = async ({ customerId = null, limit = 20, offset = 0 } = {}) => {
  const { rows, count } = await Reel.findAndCountAll({
    where: { is_published: true },
    order: [["display_order", "ASC"], sequelize.random()],
    limit,
    offset,
  });

  const ids = rows.map((r) => r.id);
  const [counts, liked] = await Promise.all([
    commentCounts(ids),
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
    commentCounts([reel.id]),
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

// Published reels whose featured products include this product id (JSONB @>).
const getReelsForProduct = async (productId) => {
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const rows = await Reel.findAll({
    where: { is_published: true, product_ids: { [Op.contains]: [id] } },
    order: [["display_order", "ASC"], ["created_at", "DESC"]],
  });
  return Promise.all(
    rows.map(async (reel) => serializeReel(reel, { products: await resolveProducts(reel.product_ids) }))
  );
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

    // Compute the response from the pre-update count: on Postgres,
    // increment()/decrement() refresh the instance in place (RETURNING), so
    // reading reel.like_count afterwards and adjusting it again would report
    // a double increment/decrement.
    const countBefore = Number(reel.like_count) || 0;

    if (existing) {
      await existing.destroy({ transaction });
      await reel.decrement("like_count", { by: 1, transaction });
      return { liked: false, like_count: Math.max(0, countBefore - 1) };
    }

    await ReelLike.create({ reel_id: reelId, customer_id: customerId }, { transaction });
    await reel.increment("like_count", { by: 1, transaction });
    return { liked: true, like_count: countBefore + 1 };
  });
};

// ─── Comments ───────────────────────────────────────────────────────────────

const COMMENT_MAX_LENGTH = 1000;

const serializeComment = (row) => {
  const plain = typeof row.get === "function" ? row.get({ plain: true }) : row;
  return {
    id: plain.id,
    comment: plain.comment,
    created_at: plain.created_at,
    parent_id: plain.parent_id ?? null,
    author: plain.Customer?.name || "Guest",
    // Null for the many customers who never set one — the client falls back to the
    // initial rather than shipping a stock silhouette for most of the thread.
    author_avatar: plain.Customer?.avatar_url || null,
    // The client marks the reader's own comments; it never renders the id itself.
    author_id: plain.customer_id,
  };
};

/**
 * Resolve the thread a reply belongs to.
 *
 * Threading is capped at one level, so a reply always hangs off a thread ROOT. Replying
 * to a reply therefore re-points at that reply's own parent — the conversation stays in
 * the thread it started in, and the list never indents twice. (Instagram does the same;
 * the "@name" that identifies who is being answered is written into the text by the
 * client, which is also what Instagram does.)
 *
 * Returns the id to store, or null for a top-level comment. Throws if the parent is
 * missing or belongs to a different reel — a reply that lands under someone else's video
 * would be worse than a rejected one.
 */
const normalizeParent = async (reelId, parentId) => {
  const id = Number(parentId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const parent = await ReelComment.findByPk(id, { attributes: ["id", "reel_id", "parent_id"] });
  if (!parent) throw new Error("The comment you replied to no longer exists");
  if (Number(parent.reel_id) !== Number(reelId)) throw new Error("That comment belongs to another reel");

  return parent.parent_id ?? parent.id;
};

const addComment = async (reelId, customerId, text, parentId = null) => {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Comment cannot be empty");
  const reel = await Reel.findByPk(reelId);
  if (!reel) throw new Error("Reel not found");

  const resolvedParent = await normalizeParent(reel.id, parentId);

  const created = await ReelComment.create({
    reel_id: reel.id,
    customer_id: customerId,
    parent_id: resolvedParent,
    comment: trimmed.slice(0, COMMENT_MAX_LENGTH),
  });

  // Returned in full so the client can drop it straight into the open thread. It is live
  // the moment it is written, so there is nothing to wait for and nothing to re-fetch.
  const withAuthor = await ReelComment.findByPk(created.id, {
    include: [{ model: Customer, attributes: ["id", "name", "avatar_url"] }],
  });
  return serializeComment(withAuthor);
};

/**
 * Every comment on a reel, as threads.
 *
 * Roots newest-first, so a reader opening the sheet sees the current conversation;
 * replies oldest-first within their thread, so each one reads in the order it was said.
 * One query for the lot — the replies are grouped in memory rather than per-thread.
 */
const listComments = async (reelId) => {
  const rows = await ReelComment.findAll({
    where: { reel_id: reelId },
    order: [["created_at", "ASC"]],
    include: [{ model: Customer, attributes: ["id", "name", "avatar_url"] }],
  });

  const roots = [];
  const repliesByParent = new Map();

  for (const row of rows) {
    const comment = serializeComment(row);
    if (comment.parent_id === null) {
      roots.push({ ...comment, replies: [] });
    } else {
      const bucket = repliesByParent.get(comment.parent_id);
      if (bucket) bucket.push(comment);
      else repliesByParent.set(comment.parent_id, [comment]);
    }
  }

  for (const root of roots) {
    root.replies = repliesByParent.get(root.id) || [];
  }

  roots.reverse(); // newest thread first; replies keep their ascending order
  return roots;
};

// ─── Admin ──────────────────────────────────────────────────────────────────

const listAllReels = async () => {
  const rows = await Reel.findAll({
    order: [["display_order", "ASC"], ["created_at", "DESC"]],
  });
  const ids = rows.map((r) => r.id);
  const counts = await commentCounts(ids);
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

/**
 * A customer removing something they wrote.
 *
 * Ownership is checked against the row rather than trusted from the request, so this
 * cannot be pointed at someone else's comment by editing the id. Deleting a thread root
 * takes its replies with it — the same cascade the admin's delete relies on — which is
 * why the count of what went is returned: the caller has a comment tally to correct.
 */
const deleteOwnComment = async (commentId, customerId) => {
  const comment = await ReelComment.findByPk(commentId, {
    attributes: ["id", "customer_id", "parent_id", "reel_id"],
  });
  if (!comment) throw new Error("That comment has already been removed");
  if (Number(comment.customer_id) !== Number(customerId)) {
    throw new Error("You can only delete your own comments");
  }

  // Count the replies before the cascade removes them, so the reel's comment tally can
  // be corrected by the right amount.
  const replyCount = comment.parent_id
    ? 0
    : await ReelComment.count({ where: { parent_id: comment.id } });

  await comment.destroy();
  return { id: Number(commentId), removed: replyCount + 1 };
};

/**
 * Every comment on the store, newest first, for the moderation table.
 *
 * Comments are live from the moment they are written, so this is not a queue to work
 * through — it is the record, and the admin's job here is to remove what should not
 * stand. `reply_to` names the thread a reply sits in, so a one-word "same!" can still be
 * judged against what it was answering.
 */
const listAllComments = async ({ limit = 200 } = {}) => {
  const comments = await ReelComment.findAll({
    order: [["created_at", "DESC"]],
    limit: Math.min(Math.max(Number(limit) || 200, 1), 500),
    include: [
      { model: Customer, attributes: ["id", "name", "email"] },
      { model: Reel, attributes: ["id", "title"] },
      {
        association: "parent",
        attributes: ["id", "comment"],
        include: [{ model: Customer, attributes: ["id", "name"] }],
      },
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
      is_reply: plain.parent_id !== null,
      reply_to: plain.parent
        ? { author: plain.parent.Customer?.name || "Guest", comment: plain.parent.comment }
        : null,
    };
  });
};

// Deleting a thread root takes its replies with it (parent_id is ON DELETE CASCADE), which
// is what the admin means by removing a comment — leaving the answers to a deleted remark
// stranded under a gap would read as a bug.
const deleteComment = async (commentId) => {
  await ReelComment.destroy({ where: { id: commentId } });
};

module.exports = {
  listPublishedReels,
  getReelById,
  getReelsForProduct,
  incrementView,
  toggleLike,
  addComment,
  listComments,
  deleteOwnComment,
  listAllReels,
  createReel,
  updateReel,
  deleteReel,
  listAllComments,
  deleteComment,
};
