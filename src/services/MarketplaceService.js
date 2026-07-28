const { Op } = require("sequelize");
const { sequelize } = require("../config/db");
const Marketplace = require("../models/Marketplace");
const ProductMarketplaceLink = require("../models/ProductMarketplaceLink");
const Product = require("../models/Product");

// What a product card on a storefront page needs. Deliberately narrow: these cards link
// OUT to the marketplace, so nothing that drives an on-site add-to-cart is fetched.
const PRODUCT_CARD_ATTRIBUTES = [
  "id",
  "name",
  "slug",
  "selling_price",
  "mrp_price",
  "discount_percent",
  "images",
  "status",
];

const serializeMarketplace = (row) => {
  const plain = typeof row.get === "function" ? row.get({ plain: true }) : row;
  return {
    id: plain.id,
    slug: plain.slug,
    name: plain.name,
    tagline: plain.tagline,
    icon: plain.icon,
    accent_color: plain.accent_color,
    storefront_url: plain.storefront_url,
    storefront_note: plain.storefront_note,
    status: plain.status,
    display_order: plain.display_order,
  };
};

const serializeCard = (link) => {
  const plain = typeof link.get === "function" ? link.get({ plain: true }) : link;
  const product = plain.Product || {};
  const images = Array.isArray(product.images) ? product.images : [];
  const cover = images.find((img) => img.is_cover) || images[0] || null;
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    selling_price: product.selling_price,
    mrp_price: product.mrp_price,
    discount_percent: product.discount_percent,
    image: cover?.url || null,
    // Where the card actually goes: the listing on that marketplace, not our own page.
    url: plain.url,
  };
};

// ─── Public ─────────────────────────────────────────────────────────────────

/**
 * Channels for the footer and nav. Hidden ones are omitted; coming_soon ones are
 * included, because announcing where you are about to appear is the point of that state.
 */
const listPublicMarketplaces = async () => {
  const rows = await Marketplace.findAll({
    where: { status: { [Op.in]: ["live", "coming_soon"] } },
    order: [["display_order", "ASC"], ["name", "ASC"]],
  });
  return rows.map(serializeMarketplace);
};

/**
 * One channel's page: the channel itself plus the products listed on it.
 *
 * A coming_soon channel returns an empty product list without querying for one — there
 * is nothing there yet by definition, and the page renders its announcement instead.
 * Inactive products are filtered out: a listing whose product we have retired should not
 * be advertised, even though the link still resolves on the marketplace.
 */
const getMarketplacePage = async (slug, { limit = 60, offset = 0 } = {}) => {
  const marketplace = await Marketplace.findOne({ where: { slug: String(slug || "").toLowerCase() } });
  if (!marketplace || marketplace.status === "hidden") return null;

  if (marketplace.status === "coming_soon") {
    return { marketplace: serializeMarketplace(marketplace), products: [], total: 0, hasMore: false };
  }

  const { rows, count } = await ProductMarketplaceLink.findAndCountAll({
    where: { marketplace_id: marketplace.id, is_active: true },
    include: [
      {
        model: Product,
        attributes: PRODUCT_CARD_ATTRIBUTES,
        where: { status: "active" },
        required: true,
      },
    ],
    order: [["created_at", "DESC"]],
    limit,
    offset,
  });

  return {
    marketplace: serializeMarketplace(marketplace),
    products: rows.map(serializeCard),
    total: count,
    hasMore: offset + rows.length < count,
  };
};

// Channels a single product is listed on — powers "also available on" wherever it is
// wanted. Only live channels, since a coming_soon one has no listing to point at.
const listLinksForProduct = async (productId) => {
  const rows = await ProductMarketplaceLink.findAll({
    where: { product_id: productId, is_active: true },
    include: [{ model: Marketplace, where: { status: "live" }, required: true }],
  });
  return rows.map((row) => {
    const plain = row.get({ plain: true });
    return {
      marketplace_id: plain.marketplace_id,
      slug: plain.Marketplace.slug,
      name: plain.Marketplace.name,
      icon: plain.Marketplace.icon,
      accent_color: plain.Marketplace.accent_color,
      url: plain.url,
    };
  });
};

// ─── Admin: channels ────────────────────────────────────────────────────────

const listAllMarketplaces = async () => {
  const rows = await Marketplace.findAll({
    order: [["display_order", "ASC"], ["name", "ASC"]],
  });
  // The link count is what tells the admin whether a channel is actually populated.
  const counts = await ProductMarketplaceLink.findAll({
    attributes: ["marketplace_id", [sequelize.fn("COUNT", sequelize.col("id")), "count"]],
    group: ["marketplace_id"],
    raw: true,
  });
  const byId = new Map(counts.map((c) => [Number(c.marketplace_id), Number(c.count)]));
  return rows.map((row) => ({ ...serializeMarketplace(row), link_count: byId.get(row.id) || 0 }));
};

const normalizeSlug = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const normalizePayload = (data = {}) => {
  const payload = {
    name: String(data.name || "").trim().slice(0, 80),
    tagline: data.tagline ? String(data.tagline).trim().slice(0, 200) : null,
    icon: data.icon ? String(data.icon).trim().slice(0, 255) : null,
    accent_color: data.accent_color ? String(data.accent_color).trim().slice(0, 20) : null,
    storefront_url: data.storefront_url ? String(data.storefront_url).trim().slice(0, 500) : null,
    storefront_note: data.storefront_note ? String(data.storefront_note).trim() : null,
    url_pattern: data.url_pattern ? String(data.url_pattern).trim().toLowerCase().slice(0, 120) : null,
    status: ["live", "coming_soon", "hidden"].includes(data.status) ? data.status : "live",
    display_order: Number.isFinite(Number(data.display_order)) ? Number(data.display_order) : 0,
  };
  const slug = normalizeSlug(data.slug || data.name);
  if (slug) payload.slug = slug;
  return payload;
};

const createMarketplace = async (data) => {
  const payload = normalizePayload(data);
  if (!payload.name) throw new Error("A name is required");
  if (!payload.slug) throw new Error("A slug is required");

  const clash = await Marketplace.findOne({ where: { slug: payload.slug } });
  if (clash) throw new Error(`The slug "${payload.slug}" is already used by ${clash.name}`);

  const row = await Marketplace.create(payload);
  return serializeMarketplace(row);
};

const updateMarketplace = async (id, data) => {
  const row = await Marketplace.findByPk(id);
  if (!row) throw new Error("Marketplace not found");
  const payload = normalizePayload(data);

  if (payload.slug && payload.slug !== row.slug) {
    const clash = await Marketplace.findOne({ where: { slug: payload.slug, id: { [Op.ne]: row.id } } });
    if (clash) throw new Error(`The slug "${payload.slug}" is already used by ${clash.name}`);
  }

  await row.update(payload);
  return serializeMarketplace(row);
};

// Deleting takes the product links with it (FK is ON DELETE CASCADE). Retiring a channel
// is usually what is wanted instead — status: "hidden" keeps every URL.
const deleteMarketplace = async (id) => {
  await Marketplace.destroy({ where: { id } });
};

// ─── Admin: product links ───────────────────────────────────────────────────

/**
 * Reject a URL that clearly belongs to a different marketplace.
 *
 * Pasting a Flipkart link into the Amazon row is an easy slip and an invisible one — the
 * page still renders, the card still clicks, and it takes a customer landing on a rival
 * shop for anyone to notice. Checked against the channel's own `url_pattern`, so a new
 * marketplace defines its own; a blank pattern means "do not check".
 */
const assertUrlMatches = (marketplace, url) => {
  const trimmed = String(url || "").trim();
  if (!trimmed) throw new Error("A URL is required");
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("The URL must start with http:// or https://");
  if (marketplace.url_pattern && !trimmed.toLowerCase().includes(marketplace.url_pattern)) {
    throw new Error(`That URL is not a ${marketplace.name} link — it should contain "${marketplace.url_pattern}"`);
  }
  return trimmed.slice(0, 1000);
};

/**
 * Replace a product's marketplace links with the set given.
 *
 * Whole-set rather than per-link so the admin form can send what it has and this works
 * out the difference: a row that arrives is upserted, one that is missing is removed.
 * Runs in the caller's transaction when there is one, so saving a product either takes
 * its links with it or leaves nothing behind.
 *
 * @param {number} productId
 * @param {Array<{marketplace_id:number, url:string, is_active?:boolean}>} links
 */
const setProductLinks = async (productId, links = [], { transaction } = {}) => {
  if (!Array.isArray(links)) return;

  const marketplaces = await Marketplace.findAll({ transaction });
  const byId = new Map(marketplaces.map((m) => [m.id, m]));

  const wanted = [];
  for (const link of links) {
    const marketplaceId = Number(link?.marketplace_id);
    const marketplace = byId.get(marketplaceId);
    if (!marketplace) continue;
    // A cleared field means "remove this listing", not "save an empty URL".
    if (!String(link.url || "").trim()) continue;
    wanted.push({
      product_id: productId,
      marketplace_id: marketplaceId,
      url: assertUrlMatches(marketplace, link.url),
      is_active: link.is_active === undefined ? true : Boolean(link.is_active),
    });
  }

  const keepIds = wanted.map((w) => w.marketplace_id);
  await ProductMarketplaceLink.destroy({
    where: {
      product_id: productId,
      ...(keepIds.length ? { marketplace_id: { [Op.notIn]: keepIds } } : {}),
    },
    transaction,
  });

  for (const row of wanted) {
    await ProductMarketplaceLink.upsert(row, {
      conflictFields: ["product_id", "marketplace_id"],
      transaction,
    });
  }
};

const getProductLinks = async (productId) => {
  const rows = await ProductMarketplaceLink.findAll({
    where: { product_id: productId },
    include: [{ model: Marketplace, attributes: ["id", "slug", "name"] }],
  });
  return rows.map((row) => {
    const plain = row.get({ plain: true });
    return {
      marketplace_id: plain.marketplace_id,
      slug: plain.Marketplace?.slug,
      url: plain.url,
      is_active: plain.is_active,
    };
  });
};

/**
 * Products for the admin's attach picker, with whatever is already linked to this channel.
 *
 * Searched server-side rather than shipping the whole catalogue to the browser and
 * filtering there — that stops working the moment the shop has a few thousand products,
 * and it is the same trade the products table already makes.
 *
 * `url` comes back on every row so the picker can show, before anything is typed, which
 * products are already on this channel — otherwise the admin re-pastes links that are
 * already there and cannot tell which are missing.
 */
const listProductsForPicker = async (marketplaceId, { search = "", limit = 1000 } = {}) => {
  const term = String(search || "").trim();
  const where = { status: "active" };
  if (term) {
    where[Op.or] = [
      { name: { [Op.iLike]: `%${term}%` } },
      { sku: { [Op.iLike]: `%${term}%` } },
    ];
  }

  const products = await Product.findAll({
    where,
    attributes: ["id", "name", "sku", "images"],
    order: [["id", "DESC"]],
    // The picker opens with the whole catalogue rather than a first page, so the admin
    // can scroll to a product they cannot name. Capped at 1000 as a backstop — that is
    // far above the current catalogue and stops a runaway payload if it ever grows.
    limit: Math.min(Math.max(Number(limit) || 1000, 1), 1000),
  });
  if (products.length === 0) return [];

  const links = await ProductMarketplaceLink.findAll({
    where: {
      marketplace_id: marketplaceId,
      product_id: { [Op.in]: products.map((p) => p.id) },
    },
    attributes: ["product_id", "url"],
    raw: true,
  });
  const urlByProduct = new Map(links.map((l) => [Number(l.product_id), l.url]));

  return products.map((product) => {
    const plain = product.get({ plain: true });
    const images = Array.isArray(plain.images) ? plain.images : [];
    const cover = images.find((img) => img.is_cover) || images[0] || null;
    return {
      id: plain.id,
      name: plain.name,
      sku: plain.sku,
      image: cover?.url || null,
      url: urlByProduct.get(plain.id) || "",
    };
  });
};

/**
 * Bulk attach: pairs of SKU (or slug, or id) and URL, for one channel.
 *
 * Built because the alternative is opening several hundred product modals to paste one
 * link each, which nobody finishes. Every row is reported back — matched, skipped or
 * rejected — rather than failing the batch on the first bad line, so one typo in row 200
 * does not throw away the other 199.
 *
 * @param {number} marketplaceId
 * @param {Array<{key:string, url:string}>} rows
 */
const bulkAttach = async (marketplaceId, rows = []) => {
  const marketplace = await Marketplace.findByPk(marketplaceId);
  if (!marketplace) throw new Error("Marketplace not found");

  const results = { attached: 0, updated: 0, failed: [] };

  for (const row of rows) {
    const key = String(row?.key || "").trim();
    if (!key) continue;

    try {
      const url = assertUrlMatches(marketplace, row.url);
      const numericId = /^\d+$/.test(key) ? Number(key) : null;
      const product = await Product.findOne({
        where: {
          [Op.or]: [
            { sku: key },
            { slug: key.toLowerCase() },
            ...(numericId ? [{ id: numericId }] : []),
          ],
        },
        attributes: ["id"],
      });
      if (!product) throw new Error("No product with that SKU, slug or id");

      const existing = await ProductMarketplaceLink.findOne({
        where: { product_id: product.id, marketplace_id: marketplace.id },
      });
      if (existing) {
        await existing.update({ url, is_active: true });
        results.updated += 1;
      } else {
        await ProductMarketplaceLink.create({
          product_id: product.id,
          marketplace_id: marketplace.id,
          url,
          is_active: true,
        });
        results.attached += 1;
      }
    } catch (error) {
      results.failed.push({ key, reason: error.message });
    }
  }

  return results;
};

module.exports = {
  listPublicMarketplaces,
  getMarketplacePage,
  listLinksForProduct,
  listAllMarketplaces,
  createMarketplace,
  updateMarketplace,
  deleteMarketplace,
  setProductLinks,
  getProductLinks,
  listProductsForPicker,
  bulkAttach,
};
