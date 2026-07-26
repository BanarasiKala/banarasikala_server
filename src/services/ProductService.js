const Product = require("../models/Product");
const Material = require("../models/Material");
const Variety = require("../models/Variety");
const Occasion = require("../models/Occasion");
const Color = require("../models/Color");
const Feedback = require("../models/Feedback");
const AdminReview = require("../models/AdminReview");
const OrderItem = require("../models/OrderItem");
const Cart = require("../models/Cart");
const { Op, fn, col, literal } = require("sequelize");
const { sequelize } = require("../config/db");
const { formatProductCode, formatVariantItemCode } = require("../utils/codes");
const ProductOccasion = require("../models/ProductOccasion");
// Required for their belongsToMany associations to register — same reason ProductOccasion is
// imported here. Without this, `include: [{ model: Variety }]` would find no association.
require("../models/ProductVariety");
require("../models/ProductMaterial");
const { deleteS3Object } = require("../config/s3");
const { destroyCloudinaryImage } = require("../config/cloudinary");

// A clean, de-duped list of positive integer ids from an array.
const parseIdList = (value) => [...new Set(
  (Array.isArray(value) ? value : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0),
)];

/**
 * The ids for a many-to-many attribute, accepting both shapes.
 *
 * `variety_ids` is the array form the updated client sends. `variety_id` (singular) is the
 * legacy single value — a form or an API caller not yet migrated still works, its one value
 * becoming a one-element set. Passing both is fine; they merge.
 */
const parseAttributeIds = (arrayValue, singleValue) => {
  const ids = parseIdList(arrayValue);
  const single = Number(singleValue);
  if (Number.isInteger(single) && single > 0 && !ids.includes(single)) ids.push(single);
  return ids;
};

// Did this update payload say anything about `variety`/`material` at all? A partial update
// that mentions neither must not touch the existing links. Both the array and the legacy
// singular count as "mentioned".
const mentionsAttribute = (data, name) =>
  Object.hasOwn(data, `${name}_ids`) || Object.hasOwn(data, `${name}_id`);

// Pull the url strings out of a JSONB media array ([{ url, ... }]).
const mediaUrls = (arr) =>
  (Array.isArray(arr) ? arr : []).map((m) => m && m.url).filter(Boolean);

// Fire-and-forget cleanup of orphaned media. Never blocks the response.
const cleanupOrphanedMedia = ({ videos = [], images = [] }) => {
  videos.forEach((url) => { deleteS3Object(url); });
  images.forEach((url) => { destroyCloudinaryImage(url); });
};

// Material and Variety are many-to-many now, so they carry `through` just like Occasion —
// each yields an array (product.Materials, product.Varieties) that toClient flattens to
// material_ids / variety_ids.
const productIncludes = [
  { model: Material, attributes: ["id", "name", "slug"], through: { attributes: [] } },
  { model: Variety, attributes: ["id", "name", "slug"], through: { attributes: [] } },
  { model: Occasion, attributes: ["id", "name", "slug"], through: { attributes: [] } },
];
const HOME_PRODUCT_ATTRIBUTES = [
  "id",
  "sku",
  "variant_skus",
  "name",
  "slug",
  "short_description",
  "selling_price",
  "mrp_price",
  "discount_percent",
  "images",
  "is_new_arrival",
  "color_stocks",
  "stock_quantity",
  "low_stock_threshold",
  "status",
  "exclusive_order",
  "new_arrival_order",
  "collection_order",
  "processing_days",
];
const COLLECTION_PRODUCT_ATTRIBUTES = [
  "id",
  "sku",
  "variant_skus",
  "name",
  "slug",
  "short_description",
  "selling_price",
  "mrp_price",
  "discount_percent",
  "images",
  "is_new_arrival",
  "color_stocks",
  "stock_quantity",
  "low_stock_threshold",
  "status",
  "exclusive_order",
  "new_arrival_order",
  "collection_order",
  "processing_days",
];

// The storefront card prints MRP for anything out of stock and the selling price otherwise
// (see renderProductCard in Collection.jsx). Price filtering and the price sorts run off this
// same expression, so the grid can never show a card labelled above the shopper's cap —
// e.g. a ₹4,299 saree that renders as "MRP ₹5,999" must not survive a ₹5,300 filter.
const DISPLAY_PRICE_SQL = `(CASE
    WHEN COALESCE("Product"."stock_quantity", 0) <= 0 OR "Product"."status" <> 'active'
    THEN COALESCE(NULLIF("Product"."mrp_price", 0), "Product"."selling_price")
    ELSE "Product"."selling_price"
  END)`;

const toIntOrNull = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const num = parseInt(value, 10);
  return Number.isNaN(num) ? null : num;
};

const toIntOrZero = (value) => {
  const num = parseInt(value, 10);
  return Number.isNaN(num) ? 0 : num;
};

const toFloatOrNull = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const num = parseFloat(value);
  return Number.isNaN(num) ? null : num;
};

const normalizeStringArray = (value = [], allowed = []) => {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(
    raw
      .map((item) => String(item || "").trim().toLowerCase())
      .filter((item) => allowed.includes(item)),
  )];
};

const normalizeImages = (images = [], coverColorId = null) => {
  const cleanImages = (Array.isArray(images) ? images : [])
    .map((image, index) => ({
      color_id: toIntOrNull(image.color_id),
      url: image.url || image.image_url,
      display_order: toIntOrZero(image.display_order ?? index),
      is_cover: Boolean(image.is_cover),
    }))
    .filter((image) => image.color_id && (image.url || image.image_url));

  const grouped = cleanImages.reduce((acc, image) => {
    const key = String(image.color_id);
    if (!acc[key]) acc[key] = [];
    if (acc[key].length < 6) acc[key].push(image);
    return acc;
  }, {});

  Object.values(grouped).forEach((items) => {
    items.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
  });

  const finalImages = Object.values(grouped).flat();
  const requestedCoverColor = toIntOrNull(coverColorId);
  const coverColor =
    requestedCoverColor && finalImages.some((image) => image.color_id === requestedCoverColor)
      ? requestedCoverColor
      : finalImages.find((image) => image.is_cover)?.color_id || finalImages[0]?.color_id || null;

  return finalImages.map((image, index) => ({
    ...image,
    display_order: image.display_order ?? index,
    is_cover: Boolean(coverColor && image.color_id === coverColor),
  }));
};

const validateColorMedia = (colorStocks = {}, images = []) => {
  const selectedColorIds = Object.entries(colorStocks)
    .filter(([, qty]) => toIntOrZero(qty) > 0)
    .map(([colorId]) => parseInt(colorId, 10));

  if (selectedColorIds.length === 0) throw new Error("At least one product color is required");
  if (images.length === 0) throw new Error("At least one product image is required");

  selectedColorIds.forEach((colorId) => {
    const count = images.filter((image) => image.color_id === colorId).length;
    if (count < 1) throw new Error(`Color ${colorId} must have at least 1 image`);
    if (count > 8) throw new Error("Each color can have maximum 8 images");
  });
};

const buildVariantSkus = async (productId, colorStocks = {}) => {
  const productCode = formatProductCode(productId);
  const colorIds = Object.entries(colorStocks)
    .filter(([, qty]) => toIntOrZero(qty) > 0)
    .map(([colorId]) => toIntOrZero(colorId))
    .filter(Boolean);
  if (!colorIds.length) return {};

  const colors = await Color.findAll({
    where: { id: { [Op.in]: colorIds } },
    attributes: ["id", "name", "slug"],
  });
  const colorMap = Object.fromEntries(colors.map((color) => {
    const plain = typeof color.toJSON === "function" ? color.toJSON() : color;
    return [String(plain.id), plain];
  }));

  return Object.fromEntries(colorIds.map((colorId) => {
    const color = colorMap[String(colorId)];
    return [String(colorId), formatVariantItemCode(productCode, color?.slug || color?.name, colorId)];
  }));
};

const normalizeProduct = (product) => {
  const plain = typeof product?.toJSON === "function" ? product.toJSON() : product;
  if (!plain) return plain;
  const images = normalizeImages(plain.images || []);

  // The associations come back as arrays of rows; the client wants id arrays plus the named
  // list for display. `variety_ids` / `material_ids` mirror `occasion_ids`, and the singular
  // `variety_id` / `material_id` are kept populated with the FIRST of each so any consumer not
  // yet updated still reads a sensible value rather than null.
  const varieties = (plain.Varieties || []).map((v) => ({ id: v.id, name: v.name, slug: v.slug }));
  const materials = (plain.Materials || []).map((m) => ({ id: m.id, name: m.name, slug: m.slug }));
  const occasion_ids = (plain.Occasions || []).map((o) => o.id);

  const result = {
    ...plain,
    images,
    occasion_ids,
    varieties,
    materials,
    variety_ids: varieties.map((v) => v.id),
    material_ids: materials.map((m) => m.id),
    variety_id: varieties[0]?.id ?? plain.variety_id ?? null,
    material_id: materials[0]?.id ?? plain.material_id ?? null,
  };
  delete result.Occasions;
  delete result.Varieties;
  delete result.Materials;
  return result;
};

const attachReviewSummaries = async (products = []) => {
  const ids = products.map((product) => product.id).filter(Boolean);
  if (!ids.length) return products;

  try {
    const rows = await Feedback.findAll({
      attributes: [
        "product_id",
        [fn("COUNT", col("id")), "review_count"],
        [fn("AVG", col("rating")), "average_rating"],
      ],
      where: {
        product_id: { [Op.in]: ids },
        is_approved: true,
      },
      group: ["product_id"],
      raw: true,
    });

    const summaries = new Map(rows.map((row) => {
      const count = Number(row.review_count || 0);
      const average = count ? Math.round(Number(row.average_rating || 0) * 10) / 10 : 0;
      return [Number(row.product_id), { average, count }];
    }));

    // Same fallback as the product page: a product with no real reviews borrows its rating
    // badge from the admin's seed reviews, so the card and the detail page agree. Only queried
    // for the products that actually have zero real reviews.
    const zeroIds = ids.filter((id) => !(summaries.get(Number(id))?.count));
    let seedSummaries = new Map();
    if (zeroIds.length) {
      try {
        await AdminReview.sync({ force: false });
        const seedRows = await AdminReview.findAll({
          attributes: [
            "product_id",
            [fn("COUNT", col("id")), "review_count"],
            [fn("AVG", col("rating")), "average_rating"],
          ],
          where: { product_id: { [Op.in]: zeroIds }, is_active: true },
          group: ["product_id"],
          raw: true,
        });
        seedSummaries = new Map(seedRows.map((row) => {
          const count = Number(row.review_count || 0);
          const average = count ? Math.round(Number(row.average_rating || 0) * 10) / 10 : 0;
          return [Number(row.product_id), { average, count }];
        }));
      } catch (seedError) {
        console.error("[ProductService] seed review summary warning:", seedError.message);
      }
    }

    return products.map((product) => {
      const real = summaries.get(Number(product.id));
      const summary = real?.count
        ? real
        : (seedSummaries.get(Number(product.id)) || { average: 0, count: 0 });
      return {
        ...product,
        review_summary: summary,
        rating: summary.average,
        review_count: summary.count,
      };
    });
  } catch (error) {
    console.error("[ProductService] review summary warning:", error.message);
    return products;
  }
};

const getStockStatus = (quantity, threshold = 5) => {
  const stock = toIntOrZero(quantity);
  const low = toIntOrZero(threshold || 5);
  if (stock <= 0) return "out_of_stock";
  if (stock < low) return "low_stock";
  return "in_stock";
};

const keepOnlyCoverColorImages = (product) => {
  const coverColorId = product.images.find((image) => image.is_cover)?.color_id || product.images[0]?.color_id;
  if (!coverColorId) return product;

  const images = product.images.filter((image) => image.color_id === coverColorId);
  return {
    ...product,
    images,
  };
};

const toHomeProduct = (product) => {
  const coverProduct = keepOnlyCoverColorImages(product);
  return {
    id: coverProduct.id,
    name: coverProduct.name,
    slug: coverProduct.slug,
    short_description: coverProduct.short_description,
    selling_price: coverProduct.selling_price,
    mrp_price: coverProduct.mrp_price,
    discount_percent: coverProduct.discount_percent,
    images: coverProduct.images,
    is_new_arrival: Boolean(coverProduct.is_new_arrival),
    stock_quantity: coverProduct.stock_quantity,
    variant_skus: coverProduct.variant_skus || {},
    low_stock_threshold: coverProduct.low_stock_threshold,
    status: coverProduct.status,
    processing_days: coverProduct.processing_days ?? null,
    stock_status: getStockStatus(coverProduct.stock_quantity, coverProduct.low_stock_threshold),
    review_summary: coverProduct.review_summary || { average: 0, count: 0 },
    rating: coverProduct.rating || 0,
    review_count: coverProduct.review_count || 0,
  };
};

const toCollectionProduct = (product) => {
  const coverProduct = keepOnlyCoverColorImages(product);
  return {
    id: coverProduct.id,
    name: coverProduct.name,
    slug: coverProduct.slug,
    short_description: coverProduct.short_description,
    selling_price: coverProduct.selling_price,
    mrp_price: coverProduct.mrp_price,
    discount_percent: coverProduct.discount_percent,
    images: coverProduct.images,
    is_new_arrival: Boolean(coverProduct.is_new_arrival),
    stock_quantity: coverProduct.stock_quantity,
    variant_skus: coverProduct.variant_skus || {},
    low_stock_threshold: coverProduct.low_stock_threshold,
    status: coverProduct.status,
    processing_days: coverProduct.processing_days ?? null,
    stock_status: getStockStatus(coverProduct.stock_quantity, coverProduct.low_stock_threshold),
    review_summary: coverProduct.review_summary || { average: 0, count: 0 },
    rating: coverProduct.rating || 0,
    review_count: coverProduct.review_count || 0,
  };
};

const getPositiveColorIds = (colorStocks = {}) =>
  Object.entries(colorStocks || {})
    .filter(([, qty]) => toIntOrZero(qty) > 0)
    .map(([colorId]) => String(colorId));

// Any shared variety/material/occasion counts — a Silk+Zari saree relates to another Silk one
// even if the rest differs. `source` and `candidate` are both normalized, so each carries
// variety_ids / material_ids / occasion_ids arrays.
const sharesAny = (a = [], b = []) => {
  const set = new Set(a);
  return b.some((id) => set.has(id));
};

const scoreRelatedProduct = (source, candidate) => {
  let score = 0;
  if (sharesAny(source.variety_ids, candidate.variety_ids)) score += 5;
  if (sharesAny(source.material_ids, candidate.material_ids)) score += 4;
  if (sharesAny(source.occasion_ids, candidate.occasion_ids)) score += 3;
  if (source.special_collection && source.special_collection === candidate.special_collection) score += 1;

  const sourceColors = new Set(getPositiveColorIds(source.color_stocks));
  const colorMatches = getPositiveColorIds(candidate.color_stocks).filter((colorId) => sourceColors.has(colorId)).length;
  score += Math.min(colorMatches, 3) * 2;

  return score;
};

const sanitizeProductPayload = (data = {}) => {
  const selling_price = toFloatOrNull(data.selling_price || data.price) ?? 0;
  const mrp_price = toFloatOrNull(data.mrp_price || data.old_price);
  const cost_price = toFloatOrNull(data.cost_price);

  let discount_percent = null;
  if (mrp_price && selling_price < mrp_price) {
    discount_percent = Math.round(((mrp_price - selling_price) / mrp_price) * 100);
  }

  const color_stocks = data.color_stocks && typeof data.color_stocks === "object" ? data.color_stocks : {};
  const images = normalizeImages(data.images || [], data.cover_color_id);
  const totalStock = Object.values(color_stocks).reduce((sum, qty) => sum + toIntOrZero(qty), 0);
  const payment_options = normalizeStringArray(data.payment_options, ["prepaid", "cod"]);
  const service_options = normalizeStringArray(data.service_options, ["return", "exchange"]);

  validateColorMedia(color_stocks, images);
  if (payment_options.length === 0) throw new Error("Choose at least one payment option");
  if (service_options.length === 0) throw new Error("Choose at least one return/exchange option");

  // A product can be a Special Collection (Exclusive Picks) item or a New Arrival,
  // but never both. Special Collection takes precedence if both are sent.
  const special_collection = Boolean(data.special_collection);
  const is_new_arrival = special_collection ? false : Boolean(data.is_new_arrival);

  const sanitized = {
    ...data,
    selling_price,
    mrp_price,
    cost_price,
    discount_percent: discount_percent ?? toIntOrNull(data.discount_percent),
    weight: toFloatOrNull(data.weight),
    length: toFloatOrNull(data.length),
    width: toFloatOrNull(data.width),
    height: toFloatOrNull(data.height),
    stock_quantity: totalStock,
    low_stock_threshold: toIntOrZero(data.low_stock_threshold),
    processing_days: toIntOrNull(data.processing_days),
    // variety_id / material_id are NOT written here any more — they are many-to-many, set via
    // product.setVarieties/setMaterials in create/update. The read path derives the singular
    // fallback from the join table, so the physical columns can simply go stale.
    color_stocks,
    variant_skus: data.variant_skus && typeof data.variant_skus === "object" ? data.variant_skus : {},
    images,
    special_collection,
    is_new_arrival,
    status: ["active", "inactive"].includes(String(data.status)) ? String(data.status) : "active",
    payment_options,
    service_options,
    care_instructions: String(data.care_instructions || "").trim() || null,
    key_highlights: Array.isArray(data.key_highlights)
      ? data.key_highlights.map((h) => String(h || "").trim()).filter(Boolean)
      : [],
  };

  if (!sanitized.slug || String(sanitized.slug).trim() === "") {
    sanitized.slug = `${sanitized.name || "product"}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "") + `-${Date.now()}`;
  }

  sanitized.sku = null;

  delete sanitized.price;
  delete sanitized.old_price;
  delete sanitized.cover_color_id;
  delete sanitized.cover_image_selection;
  delete sanitized.image_url;
  delete sanitized.cover_image_url;
  delete sanitized.productColors;
  delete sanitized.id;
  delete sanitized.Material;
  delete sanitized.Variety;
  delete sanitized.Materials;
  delete sanitized.Varieties;
  delete sanitized.Occasions;
  delete sanitized.occasion_id;
  delete sanitized.occasion_ids;
  // Association ids arrive on the same payload but are applied via set*(); they are not
  // columns and must not reach Product.update, or Sequelize throws on an unknown field.
  delete sanitized.variety_ids;
  delete sanitized.material_ids;
  delete sanitized.varieties;
  delete sanitized.materials;
  delete sanitized.productImages;
  delete sanitized.product_images;
  delete sanitized.createdAt;
  delete sanitized.updatedAt;

  return sanitized;
};

class ProductService {
  parseCommaSeparated(value) {
    if (!value) return null;
    const values = String(value)
      .split(",")
      .map((item) => parseInt(item.trim(), 10))
      .filter((item) => !Number.isNaN(item));
    return values.length ? values : null;
  }

  async getAllProducts(filters = {}) {
    const {
      color,
      material,
      variety,
      occasion,
      status,
      stockStatus,
      page = 1,
      pageSize = 10,
      paginated = false,
      search = "",
      minPrice,
      maxPrice,
      limit: rawLimit,
      sortBy = "newest",
      specialCollection,
      coverImagesOnly,
      view,
      newArrival,
    } = filters;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(pageSize, 10) || 10));
    const offset = (pageNum - 1) * limit;

    const needsSearchIncludes = Boolean(search && String(search).trim());
    const queryOptions = {
      include: view === "home" || (view === "collection" && !needsSearchIncludes) ? [] : productIncludes,
      where: {},
      order: [],
    };

    if (view === "home") queryOptions.attributes = HOME_PRODUCT_ATTRIBUTES;
    if (view === "collection") queryOptions.attributes = COLLECTION_PRODUCT_ATTRIBUTES;

    // Manual storefront arrangement takes precedence on the surfaces that support it.
    // New Arrivals -> new_arrival_order, Exclusive Picks -> exclusive_order,
    // Collection default sort -> collection_order. The collection page sends an empty
    // sortBy by default, which resolves to "newest" here; explicit price/special sorts
    // chosen by the shopper bypass the manual order. Null positions fall back to the
    // default ordering applied below.
    //
    // Both curated sets key off the FILTER, not the view, so the collection page reached from
    // a home rail's "View All" repeats that rail's arrangement instead of falling through to
    // collection_order and reshuffling the same sarees.
    const manualOrderColumn =
      newArrival === "true"
        ? "new_arrival_order"
        : specialCollection === "true" || view === "home"
          ? "exclusive_order"
          : view === "collection" && sortBy === "newest"
            ? "collection_order"
            : null;
    if (manualOrderColumn) {
      queryOptions.order.push(literal(`"Product"."${manualOrderColumn}" ASC NULLS LAST`));
    }

    if (sortBy === "price_asc") {
      queryOptions.order.push(literal(`${DISPLAY_PRICE_SQL} ASC`));
      queryOptions.order.push(["id", "DESC"]);
    } else if (sortBy === "price_desc") {
      queryOptions.order.push(literal(`${DISPLAY_PRICE_SQL} DESC`));
      queryOptions.order.push(["id", "DESC"]);
    } else if (sortBy === "special") {
      queryOptions.order.push(["special_collection", "DESC"]);
      queryOptions.order.push(["id", "DESC"]);
    } else if (sortBy === "newest") {
      queryOptions.order.push(["is_new_arrival", "DESC"]);
      queryOptions.order.push(["id", "DESC"]);
    } else queryOptions.order.push(["id", "DESC"]);

    // Variety, material and occasion are all many-to-many, so each filters with an EXISTS
    // subquery against its join table rather than a column comparison. A product matches if
    // ANY of its links is in the requested set — the intuitive "show me Silk sarees" even for
    // a Silk+Zari blend. Factored into one helper so the three read identically.
    const schemaPrefix = sequelize.options?.define?.schema
      ? `"${sequelize.options.define.schema}".` : '';
    const addLinkFilter = (rawValue, table, column) => {
      const ids = this.parseCommaSeparated(rawValue);
      if (!ids) return;
      queryOptions.where[Op.and] = [
        ...(Array.isArray(queryOptions.where[Op.and]) ? queryOptions.where[Op.and] : []),
        literal(`EXISTS (SELECT 1 FROM ${schemaPrefix}"${table}" j WHERE j.product_id = "Product"."id" AND j.${column} IN (${ids.join(', ')}))`),
      ];
    };
    addLinkFilter(material, 'product_materials', 'material_id');
    addLinkFilter(variety, 'product_varieties', 'variety_id');
    addLinkFilter(occasion, 'product_occasions', 'occasion_id');

    // Op.gte/Op.lte are Symbols, so the bounds have to be counted explicitly — Object.keys()
    // skips symbol keys and would report an empty filter for every request.
    const parsePriceBound = (value) => {
      if (value === undefined || value === null || String(value).trim() === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    const minPriceValue = parsePriceBound(minPrice);
    const maxPriceValue = parsePriceBound(maxPrice);
    const addPriceBound = (value, operator) => {
      if (value === null) return;
      queryOptions.where[Op.and] = [
        ...(Array.isArray(queryOptions.where[Op.and]) ? queryOptions.where[Op.and] : []),
        literal(`${DISPLAY_PRICE_SQL} ${operator} ${sequelize.escape(value)}`),
      ];
    };
    addPriceBound(minPriceValue, ">=");
    addPriceBound(maxPriceValue, "<=");

    if (status && ["active", "inactive"].includes(String(status))) queryOptions.where.status = String(status);
    if (specialCollection === "true") {
      queryOptions.where.special_collection = true;
    } else if (specialCollection === "false") {
      queryOptions.where.special_collection = false;
    }
    if (newArrival === "true" || newArrival === "false") queryOptions.where.is_new_arrival = newArrival === "true";

    if (search && String(search).trim()) {
      const text = String(search).trim();
      const words = text.split(/\s+/).filter(Boolean);

      const colorSchema = sequelize.options?.define?.schema;
      const colorTable = colorSchema ? `"${colorSchema}"."colors"` : '"colors"';

      const buildWordConditions = (word) => {
        const safeWord = sequelize.escape(word);
        const safeLike = sequelize.escape(`%${word}%`);
        return [
          { name: { [Op.iLike]: `%${word}%` } },
          { short_description: { [Op.iLike]: `%${word}%` } },
          { description: { [Op.iLike]: `%${word}%` } },
          // Material/Variety are belongsToMany with no `as`, so the joined aliases Sequelize
          // emits are the PLURALS. Referencing "Material"/"Variety" here produced a
          // "missing FROM-clause entry" error on every search request.
          { "$Materials.name$": { [Op.iLike]: `%${word}%` } },
          { "$Materials.description$": { [Op.iLike]: `%${word}%` } },
          { "$Varieties.name$": { [Op.iLike]: `%${word}%` } },
          { "$Varieties.description$": { [Op.iLike]: `%${word}%` } },
          literal(`similarity("Product"."name", ${safeWord}) > 0.1`),
          literal(`similarity("Product"."short_description", ${safeWord}) > 0.1`),
          literal(`EXISTS (SELECT 1 FROM ${colorTable} WHERE id::text IN (SELECT jsonb_object_keys("Product"."color_stocks")) AND (name ILIKE ${safeLike} OR description ILIKE ${safeLike}))`),
        ];
      };
      queryOptions.where[Op.or] = [...words.flatMap(buildWordConditions), ...buildWordConditions(text)];
      queryOptions.subQuery = false;
    }

    if (stockStatus === "in_stock") queryOptions.where.stock_quantity = { [Op.gt]: 0 };
    else if (stockStatus === "out_of_stock") queryOptions.where.stock_quantity = { [Op.lte]: 0 };
    else if (stockStatus === "low_stock") {
      queryOptions.where.stock_quantity = { [Op.and]: [{ [Op.gt]: 0 }, { [Op.lt]: 5 }] };
    }

    // For color-filtered and joined search queries, paginate after normalization.
    // Joined rows can otherwise make a LIMIT of 20 collapse into fewer product records.
    const targetColors = this.parseCommaSeparated(color);
    const useDbPagination = !targetColors && !needsSearchIncludes && (paginated === "true" || paginated === true);

    if (useDbPagination) {
      queryOptions.limit = limit;
      queryOptions.offset = offset;
    } else if (rawLimit && !targetColors) {
      queryOptions.limit = Math.max(1, parseInt(rawLimit, 10) || 50);
    }

    const allRows = await attachReviewSummaries((await Product.findAll(queryOptions)).map(normalizeProduct));
    const filteredRows = targetColors
      ? allRows.filter((product) => targetColors.some((colorId) => toIntOrZero(product.color_stocks?.[String(colorId)]) > 0))
      : allRows;
    const responseRows = view === "home"
      ? filteredRows.map(toHomeProduct)
      : view === "collection"
        ? filteredRows.map(toCollectionProduct)
        : coverImagesOnly === "true"
          ? filteredRows.map(keepOnlyCoverColorImages)
          : filteredRows;
    const responseLimit = rawLimit ? Math.max(1, parseInt(rawLimit, 10) || 0) : null;
    const limitedRows = responseLimit ? responseRows.slice(0, responseLimit) : responseRows;

    if (!paginated || paginated === "false") return limitedRows;

    // For DB-paginated queries, get the total count separately
    let count;
    let pagedItems;
    if (useDbPagination) {
      const total = await Product.count({
        where: queryOptions.where,
        include: queryOptions.include,
        distinct: true,
        col: "id",
      });
      count = total;
      pagedItems = responseRows;
    } else {
      count = responseRows.length;
      pagedItems = responseRows.slice(offset, offset + limit);
    }

    if (view === "collection") {
      return {
        items: pagedItems,
        meta: {
          totalItems: count,
          currentPage: pageNum,
          pageSize: limit,
          totalPages: Math.max(1, Math.ceil(count / limit)),
          currentPageCount: pagedItems.length,
        },
      };
    }

    const stockCounts = await Product.findAll({ attributes: ["stock_quantity", "low_stock_threshold"] });
    const summary = stockCounts.reduce(
      (acc, product) => {
        const stock = toIntOrZero(product.stock_quantity);
        const low = toIntOrZero(product.low_stock_threshold);
        if (stock <= 0) acc.outOfStock += 1;
        else if (stock < low) acc.lowStock += 1;
        else acc.inStock += 1;
        return acc;
      },
      { outOfStock: 0, lowStock: 0, inStock: 0 },
    );

    return {
      items: pagedItems,
      meta: {
        totalItems: count,
        currentPage: pageNum,
        pageSize: limit,
        totalPages: Math.max(1, Math.ceil(count / limit)),
        currentPageCount: pagedItems.length,
      },
      summary,
    };
  }

  // Bounds for the storefront price slider. Read from the live catalogue so the filter's
  // ceiling always covers the priciest saree on sale instead of a hardcoded guess. Uses the
  // displayed-price expression the filter itself uses, so dragging the slider fully right
  // can never exclude a card whose printed MRP sits above the highest selling price.
  async getPriceRange() {
    const row = await Product.findOne({
      attributes: [
        [literal(`MIN(${DISPLAY_PRICE_SQL})`), "minPrice"],
        [literal(`MAX(${DISPLAY_PRICE_SQL})`), "maxPrice"],
      ],
      where: { status: "active", selling_price: { [Op.gt]: 0 } },
      raw: true,
    });
    return {
      minPrice: Math.max(0, Math.floor(Number(row?.minPrice) || 0)),
      maxPrice: Math.max(0, Math.ceil(Number(row?.maxPrice) || 0)),
    };
  }

  async getProductSummary() {
    const products = await Product.findAll({ attributes: ["stock_quantity", "low_stock_threshold", "status"] });
    const summary = products.reduce(
      (acc, product) => {
        const stock = toIntOrZero(product.stock_quantity);
        const low = toIntOrZero(product.low_stock_threshold || 5);
        if (stock <= 0) acc.outOfStock += 1;
        else if (stock < low) acc.lowStock += 1;
        else acc.inStock += 1;
        return acc;
      },
      { outOfStock: 0, lowStock: 0, inStock: 0 },
    );
    summary.totalProducts = products.length;
    return summary;
  }

  async getProductById(id) {
    return normalizeProduct(await Product.findByPk(id, { include: productIncludes }));
  }

  async getProductBySlug(slug) {
    return normalizeProduct(await Product.findOne({ where: { slug }, include: productIncludes }));
  }

  async getProductDetailBySlug(slug, requestedColorId = null) {
    const product = normalizeProduct(await Product.findOne({
      where: { slug },
      attributes: [
        "id",
        "name",
        "slug",
        "description",
        "short_description",
        "sku",
        "variant_skus",
        "selling_price",
        "mrp_price",
        "discount_percent",
        "images",
        "videos",
        "color_stocks",
        "stock_quantity",
        "low_stock_threshold",
        "status",
        "weight",
        "length",
        "width",
        "blouse_piece",
        "payment_options",
        "service_options",
        "care_instructions",
        "material_id",
        "variety_id",
        "key_highlights",
        "processing_days",
      ],
      include: [
        ...productIncludes,
        { model: Occasion, attributes: ["id", "name", "slug"], through: { attributes: [] } },
      ],
    }));

    if (!product) return null;

    const occasions = product.Occasions || [];
    delete product.Occasions;

    const images = normalizeImages(product.images || []);
    const coverColorId = images.find((image) => image.is_cover)?.color_id || images[0]?.color_id || null;
    const colorIds = [...new Set(images.map((image) => image.color_id).filter(Boolean))];
    const selectedColorId =
      requestedColorId && colorIds.includes(toIntOrZero(requestedColorId))
        ? toIntOrZero(requestedColorId)
        : coverColorId;

    const colors = await Color.findAll({
      where: { id: { [Op.in]: colorIds.length ? colorIds : [0] } },
      attributes: ["id", "name", "hex_code", "slug"],
    });

    const selectedImages = images
      .filter((image) => image.color_id === selectedColorId)
      .sort((a, b) => toIntOrZero(a.display_order) - toIntOrZero(b.display_order));

    const colorMeta = colors.map((color) => {
      const plain = typeof color.toJSON === "function" ? color.toJSON() : color;
      const qty = product.color_stocks?.[String(plain.id)] ?? 0;
      return {
        ...plain,
        stock_quantity: toIntOrZero(qty),
        stock_status: getStockStatus(qty, product.low_stock_threshold),
        sku: product.variant_skus?.[String(plain.id)] || formatVariantItemCode(product.sku, plain.slug || plain.name, plain.id),
      };
    });

    delete product.color_stocks;

    return {
      ...product,
      images: selectedImages,
      selected_color_id: selectedColorId,
      colors: colorMeta,
      occasions,
      stock_status: getStockStatus(product.stock_quantity, product.low_stock_threshold),
    };
  }

  async getProductColorImages(slug, colorId) {
    const product = normalizeProduct(await Product.findOne({
      where: { slug },
      attributes: ["id", "slug", "images", "color_stocks", "low_stock_threshold"],
    }));

    if (!product) return null;

    const targetColorId = toIntOrZero(colorId);
    const images = normalizeImages(product.images || [])
      .filter((image) => image.color_id === targetColorId)
      .sort((a, b) => toIntOrZero(a.display_order) - toIntOrZero(b.display_order));
    const stock = product.color_stocks?.[String(targetColorId)] ?? 0;

    return {
      product_id: product.id,
      color_id: targetColorId,
      stock_quantity: toIntOrZero(stock),
      stock_status: getStockStatus(stock, product.low_stock_threshold),
      images,
    };
  }

  async getRelatedProducts(slug, rawLimit = 4) {
    const limit = Math.min(12, Math.max(1, parseInt(rawLimit, 10) || 4));
    const relatedAttributes = [
      ...new Set([
        ...COLLECTION_PRODUCT_ATTRIBUTES,
        "material_id",
        "variety_id",
        "special_collection",
      ]),
    ];
    // All three link models, so the source and the candidates carry their id arrays.
    const linkIncludes = [
      { model: Occasion, attributes: ["id"], through: { attributes: [] } },
      { model: Variety, attributes: ["id"], through: { attributes: [] } },
      { model: Material, attributes: ["id"], through: { attributes: [] } },
    ];

    const source = normalizeProduct(await Product.findOne({
      where: { slug },
      attributes: ["id", "slug", "special_collection", "color_stocks"],
      include: linkIncludes,
    }));

    if (!source) return null;

    const sourceColorIds = getPositiveColorIds(source.color_stocks);
    const relationConditions = [];

    // Each relation is an EXISTS against its join table, matching a product that shares ANY of
    // the source's varieties/materials/occasions.
    const schemaPrefix = sequelize.options?.define?.schema
      ? `"${sequelize.options.define.schema}".` : '';
    const existsAny = (ids, table, column) => {
      if (!ids?.length) return;
      relationConditions.push(literal(
        `EXISTS (SELECT 1 FROM ${schemaPrefix}"${table}" j WHERE j.product_id = "Product"."id" AND j.${column} IN (${ids.join(", ")}))`,
      ));
    };
    existsAny(source.variety_ids, 'product_varieties', 'variety_id');
    existsAny(source.material_ids, 'product_materials', 'material_id');
    existsAny(source.occasion_ids, 'product_occasions', 'occasion_id');
    if (source.special_collection) relationConditions.push({ special_collection: true });
    if (sourceColorIds.length) {
      const colorList = sourceColorIds.map((colorId) => sequelize.escape(colorId)).join(", ");
      relationConditions.push(literal(`"Product"."color_stocks" ?| ARRAY[${colorList}]`));
    }

    const baseWhere = {
      status: "active",
      id: { [Op.ne]: source.id },
    };

    const relatedRows = relationConditions.length
      ? await Product.findAll({
          attributes: relatedAttributes,
          include: linkIncludes,
          where: {
            ...baseWhere,
            [Op.or]: relationConditions,
          },
        })
      : [];

    const relatedCandidates = relatedRows
      .map(normalizeProduct)
      .map((product) => ({ product, score: scoreRelatedProduct(source, product) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) =>
        b.score - a.score ||
        Number(Boolean(b.product.is_new_arrival)) - Number(Boolean(a.product.is_new_arrival)) ||
        b.product.id - a.product.id,
      )
      .slice(0, limit)
      .map(({ product }) => product);

    let selected = relatedCandidates;

    if (selected.length < limit) {
      const selectedIds = [source.id, ...selected.map((product) => product.id)];
      const fallbackRows = await Product.findAll({
        attributes: relatedAttributes,
        where: {
          status: "active",
          id: { [Op.notIn]: selectedIds },
        },
        order: [["is_new_arrival", "DESC"], ["id", "DESC"]],
        limit: limit - selected.length,
      });
      selected = [...selected, ...fallbackRows.map(normalizeProduct)];
    }

    const withReviews = await attachReviewSummaries(selected);
    return withReviews.map(toCollectionProduct);
  }

  async createProduct(data) {
    const occasionIds = parseIdList(data.occasion_ids);
    const varietyIds = parseAttributeIds(data.variety_ids, data.variety_id);
    const materialIds = parseAttributeIds(data.material_ids, data.material_id);
    const product = await Product.create(sanitizeProductPayload(data));
    await product.update({
      sku: formatProductCode(product.id),
      variant_skus: await buildVariantSkus(product.id, product.color_stocks || {}),
    });
    await Promise.all([
      product.setOccasions(occasionIds),
      product.setVarieties(varietyIds),
      product.setMaterials(materialIds),
    ]);
    return this.getProductById(product.id);
  }

  async updateProduct(id, data) {
    const occasionIds = parseIdList(data.occasion_ids);
    // Only reset an attribute the request actually mentioned — a partial update (a status
    // toggle) that names neither must leave both link sets exactly as they were, never wipe
    // them. `undefined` is "not mentioned"; an empty array is a deliberate "clear all".
    const varietyIds = mentionsAttribute(data, 'variety')
      ? parseAttributeIds(data.variety_ids, data.variety_id) : undefined;
    const materialIds = mentionsAttribute(data, 'material')
      ? parseAttributeIds(data.material_ids, data.material_id) : undefined;
    const product = await Product.findByPk(id);
    if (!product) throw new Error("Product not found");

    // Snapshot the old media before overwriting so we can delete what's removed.
    const oldVideos = mediaUrls(product.videos);
    const oldImages = mediaUrls(product.images);

    const payload = sanitizeProductPayload(data);
    payload.sku = formatProductCode(product.id);
    payload.variant_skus = await buildVariantSkus(product.id, payload.color_stocks || {});
    await product.update(payload);
    await product.setOccasions(occasionIds);
    if (varietyIds !== undefined) await product.setVarieties(varietyIds);
    if (materialIds !== undefined) await product.setMaterials(materialIds);

    // Delete any video/image that is no longer referenced by the product.
    // Only diff a media type when the request actually supplied it, so that
    // partial updates (e.g. a status toggle) never wipe existing media.
    const newVideos = new Set(mediaUrls(payload.videos));
    const newImages = new Set(mediaUrls(payload.images));
    cleanupOrphanedMedia({
      videos: Array.isArray(data.videos)
        ? oldVideos.filter((url) => !newVideos.has(url))
        : [],
      images: Array.isArray(data.images)
        ? oldImages.filter((url) => !newImages.has(url))
        : [],
    });

    return this.getProductById(id);
  }

  async reorderProducts(section, orderedIds) {
    const columnMap = {
      exclusive: "exclusive_order",
      new_arrival: "new_arrival_order",
      collection: "collection_order",
    };
    const column = columnMap[section];
    if (!column) throw new Error("Invalid section");

    const ids = (Array.isArray(orderedIds) ? orderedIds : [])
      .map((id) => parseInt(id, 10))
      .filter((id) => !Number.isNaN(id));

    await sequelize.transaction(async (transaction) => {
      // Clear existing positions for this section first so any product dropped
      // from the arrangement falls back to the default newest-first order.
      await Product.update(
        { [column]: null },
        { where: { [column]: { [Op.ne]: null } }, transaction },
      );
      await Promise.all(
        ids.map((id, index) =>
          Product.update({ [column]: index }, { where: { id }, transaction }),
        ),
      );
    });

    return { section, updated: ids.length };
  }

  async deleteProduct(id) {
    const product = await Product.findByPk(id);
    if (!product) throw new Error("Product not found");

    // A product that appears in any order can't be hard-deleted: order_items.product_id is
    // ON DELETE NO ACTION, so Postgres would reject the DELETE, and forcing it would orphan
    // order history and invoices. We check the real blockers up front so the admin sees exactly
    // why — a raw FK violation would otherwise surface as a generic "Could not delete product".
    const orderedCount = await OrderItem.count({ where: { product_id: id } });
    if (orderedCount > 0) {
      throw new Error(
        `"${product.name}" can't be deleted because it appears in ${orderedCount} past order `
        + `line${orderedCount === 1 ? "" : "s"}. Deleting it would break those orders and their `
        + `invoices. Set the product to Inactive instead — it disappears from the store while the `
        + `order history stays intact.`,
      );
    }

    // The cart FK is NO ACTION too, so a product sitting in a live cart also blocks deletion.
    const cartCount = await Cart.count({ where: { productId: id } });
    if (cartCount > 0) {
      throw new Error(
        `"${product.name}" can't be deleted because it's currently in ${cartCount} customer `
        + `cart${cartCount === 1 ? "" : "s"}. It can be deleted once those carts are cleared, or `
        + `set it to Inactive to hide it from the store now.`,
      );
    }

    // Remove all associated media from S3 / Cloudinary before deleting the row.
    cleanupOrphanedMedia({
      videos: mediaUrls(product.videos),
      images: mediaUrls(product.images),
    });
    return product.destroy();
  }
}

module.exports = new ProductService();
