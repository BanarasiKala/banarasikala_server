const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const Product = require('../models/Product');
const Variety = require('../models/Variety');
const Material = require('../models/Material');
const ProductService = require('../services/ProductService');
const { generateUploadSignature } = require("../config/cloudinary");
const { generateS3PresignedUploadUrl } = require("../config/s3");

const logServerError = (scope, error) => {
  console.error(`[ProductController:${scope}]`, error);
};

const userFacingMessage = (error, fallback) => {
  if (!error) return fallback;
  const raw = error.message || "";

  if (raw.includes("must have at least 1 image")) return raw;
  if (raw.includes("maximum 6 images")) return raw;
  if (raw.includes("At least one product color is required")) return raw;
  if (raw.includes("At least one product image is required")) return raw;
  if (raw.includes("can have maximum 3 videos")) return raw;
  if (raw.includes("Choose at least one payment option")) return raw;
  if (raw.includes("Choose at least one return/exchange option")) return raw;
  if (raw.includes("Product not found")) return "Product not found.";

  return fallback;
};

const buildProductPayload = (body) => {
  if (!body) throw new Error("productData is required");

  const images = Array.isArray(body.images) ? body.images : [];
  const videos = Array.isArray(body.videos) ? body.videos : [];

  const selectedColorIds = Object.entries(body.color_stocks || {})
    .filter(([, qty]) => parseInt(qty, 10) > 0)
    .map(([colorId]) => parseInt(colorId, 10));

  if (selectedColorIds.length < 1) throw new Error("At least one product color is required");

  selectedColorIds.forEach((colorId) => {
    const colorImages = images.filter((img) => parseInt(img.color_id, 10) === colorId);
    if (colorImages.length > 6) throw new Error("Each color can have maximum 6 images");
    if (colorImages.length < 1) throw new Error(`Color ${colorId} must have at least 1 image`);
    const videoCount = videos.filter((v) => parseInt(v.color_id, 10) === colorId).length;
    if (videoCount > 3) throw new Error(`Color ${colorId} can have maximum 3 videos`);
  });

  const coverColorId = parseInt(body.cover_color_id, 10);
  const effectiveCoverColorId = selectedColorIds.includes(coverColorId) ? coverColorId : selectedColorIds[0];

  const processedImages = images.map((img, index) => ({
    color_id: parseInt(img.color_id, 10),
    url: img.url || img.image_url,
    display_order: parseInt(img.display_order, 10) || index,
    is_cover: parseInt(img.color_id, 10) === effectiveCoverColorId,
  }));

  const processedVideos = videos.map((v, index) => ({
    color_id: parseInt(v.color_id, 10),
    url: v.url,
    display_order: parseInt(v.display_order, 10) || index,
  }));

  return {
    ...body,
    images: processedImages,
    videos: processedVideos,
    cover_color_id: effectiveCoverColorId,
  };
};

class ProductController {
  async getAll(req, res) {
    try {
      const products = await ProductService.getAllProducts(req.query);
      res.status(200).json(products);
    } catch (error) {
      logServerError("getAll", error);
      res.status(500).json({ message: "Failed to load products." });
    }
  }

  async getSummary(req, res) {
    try {
      const summary = await ProductService.getProductSummary();
      res.status(200).json(summary);
    } catch (error) {
      logServerError("getSummary", error);
      res.status(500).json({ message: "Failed to load product summary." });
    }
  }

  async getById(req, res) {
    try {
      const product = await ProductService.getProductById(req.params.id);
      if (!product) return res.status(404).json({ message: 'Product not found' });
      res.status(200).json(product);
    } catch (error) {
      logServerError("getById", error);
      res.status(500).json({ message: "Failed to load product." });
    }
  }

  async getBySlug(req, res) {
    try {
      const product = await ProductService.getProductBySlug(req.params.slug);
      if (!product) return res.status(404).json({ message: 'Product not found' });
      res.status(200).json(product);
    } catch (error) {
      logServerError("getBySlug", error);
      res.status(500).json({ message: "Failed to load product." });
    }
  }

  async getDetailBySlug(req, res) {
    try {
      const product = await ProductService.getProductDetailBySlug(req.params.slug, req.query.color);
      if (!product) return res.status(404).json({ message: 'Product not found' });
      res.status(200).json(product);
    } catch (error) {
      logServerError("getDetailBySlug", error);
      res.status(500).json({ message: "Failed to load product detail." });
    }
  }

  async getRelatedBySlug(req, res) {
    try {
      const products = await ProductService.getRelatedProducts(req.params.slug, req.query.limit);
      if (!products) return res.status(404).json({ message: 'Product not found' });
      res.status(200).json(products);
    } catch (error) {
      logServerError("getRelatedBySlug", error);
      res.status(500).json({ message: "Failed to load related products." });
    }
  }

  async getColorImages(req, res) {
    try {
      const payload = await ProductService.getProductColorImages(req.params.slug, req.params.colorId);
      if (!payload) return res.status(404).json({ message: 'Product not found' });
      res.status(200).json(payload);
    } catch (error) {
      logServerError("getColorImages", error);
      res.status(500).json({ message: "Failed to load product color images." });
    }
  }

  async create(req, res) {
    try {
      const product = await ProductService.createProduct(req.body);
      res.status(201).json(product);
    } catch (error) {
      logServerError("create", error);
      res.status(400).json({ message: userFacingMessage(error, "Could not create product. Please check the form values.") });
    }
  }

  async update(req, res) {
    try {
      const product = await ProductService.updateProduct(req.params.id, req.body);
      res.status(200).json(product);
    } catch (error) {
      logServerError("update", error);
      res.status(400).json({ message: userFacingMessage(error, "Could not update product. Please check the form values.") });
    }
  }

  async reorder(req, res) {
    try {
      const { section, orderedIds } = req.body || {};
      const result = await ProductService.reorderProducts(section, orderedIds);
      res.status(200).json(result);
    } catch (error) {
      logServerError("reorder", error);
      const message = error.message === "Invalid section"
        ? "Invalid section. Use exclusive, new_arrival, or collection."
        : "Could not save product order.";
      res.status(400).json({ message });
    }
  }

  async delete(req, res) {
    try {
      await ProductService.deleteProduct(req.params.id);
      res.status(204).send();
    } catch (error) {
      logServerError("delete", error);
      res.status(400).json({ message: userFacingMessage(error, "Could not delete product.") });
    }
  }

  getUploadSignature(req, res) {
    const folder = "vns-saree/products";
    const sigData = generateUploadSignature(folder);
    res.json({ ...sigData, resourceType: "image" });
  }

  async getS3VideoUrl(req, res) {
    try {
      const { fileName = "video.webm", contentType = "video/webm" } = req.query;
      const result = await generateS3PresignedUploadUrl(fileName, contentType);
      res.json(result);
    } catch (err) {
      res.status(500).json({ message: err.message || "Failed to generate S3 upload URL" });
    }
  }

  async createWithImages(req, res) {
    try {
      const payload = buildProductPayload(req.body);
      const product = await ProductService.createProduct(payload);
      res.status(201).json(product);
    } catch (error) {
      logServerError("createWithImages", error);
      res.status(400).json({ message: userFacingMessage(error, "Could not create product. Please review entered values and images.") });
    }
  }

  async updateWithImages(req, res) {
    try {
      const payload = buildProductPayload(req.body);
      const product = await ProductService.updateProduct(req.params.id, payload);
      res.status(200).json(product);
    } catch (error) {
      logServerError("updateWithImages", error);
      res.status(400).json({ message: userFacingMessage(error, "Could not update product. Please review entered values and images.") });
    }
  }

  /**
   * Products stripped to what the bulk-assign screen needs.
   *
   * Deliberately not `getAll`: that endpoint carries the storefront's includes, pagination and
   * sort machinery, and the assign screen wants the opposite — every matching product at once,
   * with four columns, so the "select all matching" button can honestly mean ALL of them
   * rather than "all on this page". A page-by-page selector is how half a catalogue ends up
   * assigned and the other half forgotten.
   *
   * Filters: `search` (name/sku), `varietyId`, `materialId`, and the two that make the screen
   * work — `unassignedVariety` / `unassignedMaterial`, which is how you answer "what is left".
   */
  async getAttributeBoard(req, res) {
    try {
      const { search = '', varietyId, materialId, unassignedVariety, unassignedMaterial } = req.query;
      const where = {};

      const term = String(search).trim();
      if (term) {
        where[Op.or] = [
          { name: { [Op.iLike]: `%${term}%` } },
          { sku: { [Op.iLike]: `%${term}%` } },
        ];
      }

      // `unassigned` wins over an explicit id: asking for both is contradictory, and the
      // unassigned view is the one someone reaches for when they are trying to finish.
      if (String(unassignedVariety) === 'true') where.variety_id = null;
      else if (varietyId) where.variety_id = Number(varietyId);

      if (String(unassignedMaterial) === 'true') where.material_id = null;
      else if (materialId) where.material_id = Number(materialId);

      const products = await Product.findAll({
        where,
        attributes: ['id', 'name', 'sku', 'images', 'variety_id', 'material_id', 'status'],
        order: [['name', 'ASC']],
      });

      // Counts for the whole catalogue, not the filtered set — the screen shows progress
      // ("12 still need a variety"), and a count that shrank as you filtered would be
      // describing the filter rather than the work left.
      const [totalProducts, missingVariety, missingMaterial] = await Promise.all([
        Product.count(),
        Product.count({ where: { variety_id: null } }),
        Product.count({ where: { material_id: null } }),
      ]);

      return res.status(200).json({
        products: products.map((p) => {
          const images = Array.isArray(p.images) ? p.images : [];
          const cover = images.find((i) => i.is_cover) || images[0] || null;
          return {
            id: p.id,
            name: p.name,
            sku: p.sku,
            status: p.status,
            variety_id: p.variety_id,
            material_id: p.material_id,
            image: cover?.url || cover?.image_url || '',
          };
        }),
        totals: { totalProducts, missingVariety, missingMaterial },
      });
    } catch (error) {
      logServerError('getAttributeBoard', error);
      return res.status(500).json({ message: 'Failed to load products.' });
    }
  }

  /**
   * Set variety and/or material on many products at once.
   *
   * ── The three-state field ───────────────────────────────────────────────────────────────
   * Each of `varietyId` / `materialId` can be:
   *   omitted   leave every selected product's value alone
   *   a number  set it
   *   null      clear it
   *
   * Omitted and null have to be distinguishable or the endpoint cannot express "set the
   * material, don't touch the variety" — which is the whole point of assigning them
   * separately. `Object.hasOwn` on the parsed body is what draws that line.
   *
   * ── Why the ids are checked first ───────────────────────────────────────────────────────
   * variety_id and material_id are real foreign keys, so a bad id would fail at the database
   * with a constraint error after some rows had already been considered. Validating up front
   * turns that into a clean 400 naming the offending id, and the transaction means a failure
   * anywhere leaves the catalogue exactly as it was.
   */
  async bulkSetAttributes(req, res) {
    const { productIds, varietyId, materialId } = req.body || {};

    const ids = [...new Set((Array.isArray(productIds) ? productIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0))];

    if (!ids.length) {
      return res.status(400).json({ message: 'Select at least one product.' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ message: 'Too many products in one request (max 500).' });
    }

    const setsVariety = Object.hasOwn(req.body || {}, 'varietyId');
    const setsMaterial = Object.hasOwn(req.body || {}, 'materialId');
    if (!setsVariety && !setsMaterial) {
      return res.status(400).json({ message: 'Choose a variety or a material to apply.' });
    }

    const patch = {};
    if (setsVariety) patch.variety_id = varietyId === null || varietyId === '' ? null : Number(varietyId);
    if (setsMaterial) patch.material_id = materialId === null || materialId === '' ? null : Number(materialId);

    for (const [field, value] of Object.entries(patch)) {
      if (value !== null && !Number.isInteger(value)) {
        return res.status(400).json({ message: `Invalid ${field}.` });
      }
    }

    try {
      if (patch.variety_id) {
        const exists = await Variety.findByPk(patch.variety_id, { attributes: ['id'] });
        if (!exists) return res.status(400).json({ message: `Variety ${patch.variety_id} does not exist.` });
      }
      if (patch.material_id) {
        const exists = await Material.findByPk(patch.material_id, { attributes: ['id'] });
        if (!exists) return res.status(400).json({ message: `Material ${patch.material_id} does not exist.` });
      }

      const updated = await sequelize.transaction(async (transaction) => {
        const [count] = await Product.update(patch, { where: { id: ids }, transaction });
        return count;
      });

      // Note: the catalogue endpoints carry a 120s Cache-Control (middleware/cacheHeaders),
      // so a browser or CDN may serve the old variety for up to two minutes after this. There
      // is no server-side store to purge — it is purely an HTTP TTL.

      return res.status(200).json({
        success: true,
        updated,
        applied: {
          ...(setsVariety ? { variety_id: patch.variety_id } : {}),
          ...(setsMaterial ? { material_id: patch.material_id } : {}),
        },
      });
    } catch (error) {
      logServerError('bulkSetAttributes', error);
      return res.status(500).json({ message: 'Failed to update products.' });
    }
  }
}

module.exports = new ProductController();
