const { Op, literal } = require('sequelize');
const { sequelize } = require('../config/db');
const Product = require('../models/Product');
const Variety = require('../models/Variety');
const Material = require('../models/Material');
const ProductVariety = require('../models/ProductVariety');
const ProductMaterial = require('../models/ProductMaterial');
const ProductService = require('../services/ProductService');

// Prefix for raw subqueries so they resolve under the configured schema (vns_saree).
const schemaPrefix = sequelize.options?.define?.schema
  ? `"${sequelize.options.define.schema}".`
  : '';
const { generateUploadSignature } = require("../config/cloudinary");
const { generateS3PresignedUploadUrl } = require("../config/s3");

const logServerError = (scope, error) => {
  console.error(`[ProductController:${scope}]`, error);
};

const userFacingMessage = (error, fallback) => {
  if (!error) return fallback;
  const raw = error.message || "";

  if (raw.includes("must have at least 1 image")) return raw;
  if (raw.includes("maximum 8 images")) return raw;
  if (raw.includes("At least one product color is required")) return raw;
  if (raw.includes("At least one product image is required")) return raw;
  if (raw.includes("can have maximum 3 videos")) return raw;
  if (raw.includes("Choose at least one payment option")) return raw;
  if (raw.includes("Choose at least one return/exchange option")) return raw;
  if (raw.includes("Product not found")) return "Product not found.";
  // Descriptive delete blockers (product referenced by orders / carts) pass through verbatim.
  if (raw.includes("can't be deleted because")) return raw;
  // Safety net: any other foreign-key violation on delete gets an honest reason, not the
  // generic fallback.
  if (error.name === "SequelizeForeignKeyConstraintError") {
    return "This product can't be deleted because other records still reference it (for example past orders or a customer's cart). Set it to Inactive instead to hide it from the store.";
  }

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
    if (colorImages.length > 8) throw new Error("Each color can have maximum 8 images");
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
      const and = [];

      const term = String(search).trim();
      if (term) {
        where[Op.or] = [
          { name: { [Op.iLike]: `%${term}%` } },
          { sku: { [Op.iLike]: `%${term}%` } },
        ];
      }

      // Variety and material are many-to-many now, so a filter is EXISTS / NOT EXISTS against
      // the join table, not a column compare. `unassigned` wins over an explicit id — the two
      // together are contradictory, and "what's left" is the view someone reaches for to
      // finish. `schemaPrefix` keeps the raw SQL valid under the vns_saree schema.
      const link = (table, column, hasId, wantUnassigned) => {
        if (String(wantUnassigned) === 'true') {
          and.push(literal(`NOT EXISTS (SELECT 1 FROM ${schemaPrefix}"${table}" j WHERE j.product_id = "Product"."id")`));
        } else if (hasId) {
          and.push(literal(`EXISTS (SELECT 1 FROM ${schemaPrefix}"${table}" j WHERE j.product_id = "Product"."id" AND j.${column} = ${Number(hasId)})`));
        }
      };
      link('product_varieties', 'variety_id', varietyId, unassignedVariety);
      link('product_materials', 'material_id', materialId, unassignedMaterial);
      if (and.length) where[Op.and] = and;

      const products = await Product.findAll({
        where,
        attributes: ['id', 'name', 'sku', 'images', 'status'],
        include: [
          { model: Variety, attributes: ['id', 'name'], through: { attributes: [] } },
          { model: Material, attributes: ['id', 'name'], through: { attributes: [] } },
        ],
        order: [['name', 'ASC']],
      });

      // Progress counts for the WHOLE catalogue — a product "needs a variety" when it has no
      // rows in product_varieties. Counting distinct products with no link is one NOT EXISTS.
      const missingCount = (table) => Product.count({
        where: literal(`NOT EXISTS (SELECT 1 FROM ${schemaPrefix}"${table}" j WHERE j.product_id = "Product"."id")`),
      });
      const [totalProducts, missingVariety, missingMaterial] = await Promise.all([
        Product.count(),
        missingCount('product_varieties'),
        missingCount('product_materials'),
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
            variety_ids: (p.Varieties || []).map((v) => v.id),
            material_ids: (p.Materials || []).map((m) => m.id),
            varieties: (p.Varieties || []).map((v) => ({ id: v.id, name: v.name })),
            materials: (p.Materials || []).map((m) => ({ id: m.id, name: m.name })),
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
   * Add, remove, or replace variety/material links on many products at once.
   *
   * ── `mode`, because these are now sets ──────────────────────────────────────────────────
   * A product holds several varieties and materials, so "apply Silk to 6 products" needs to
   * say what happens to what is already there:
   *   add      Silk joins whatever each product already has (the default — you are building up)
   *   remove   Silk is taken off, the rest untouched
   *   replace  the selected set becomes exactly what each product has for that attribute
   *
   * `add` is the default because the catalogue is being populated from empty; replace is the
   * blunt instrument, offered but not assumed.
   *
   * ── Independence and validation ─────────────────────────────────────────────────────────
   * `varietyIds` and `materialIds` are handled separately — sending one never touches the
   * other. Ids are checked before anything is written (a bad id would be an FK error mid-way),
   * and the whole thing runs in one transaction so a failure leaves the catalogue untouched.
   */
  async bulkSetAttributes(req, res) {
    const { productIds, varietyIds, materialIds, mode = 'add' } = req.body || {};

    const ids = [...new Set((Array.isArray(productIds) ? productIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return res.status(400).json({ message: 'Select at least one product.' });
    if (ids.length > 500) return res.status(400).json({ message: 'Too many products in one request (max 500).' });

    if (!['add', 'remove', 'replace'].includes(mode)) {
      return res.status(400).json({ message: 'Mode must be add, remove or replace.' });
    }

    const cleanIds = (value) => [...new Set((Array.isArray(value) ? value : [])
      .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const setsVariety = Object.hasOwn(req.body || {}, 'varietyIds');
    const setsMaterial = Object.hasOwn(req.body || {}, 'materialIds');
    const varIds = cleanIds(varietyIds);
    const matIds = cleanIds(materialIds);

    if (!setsVariety && !setsMaterial) {
      return res.status(400).json({ message: 'Choose a variety or a material to apply.' });
    }
    // add/remove need something to act with; replace-with-nothing is a legitimate "clear all".
    if (mode !== 'replace' && setsVariety && !varIds.length && setsMaterial && !matIds.length) {
      return res.status(400).json({ message: 'Pick at least one variety or material.' });
    }

    try {
      // Every id must exist before a single row is written.
      if (varIds.length) {
        const found = await Variety.count({ where: { id: varIds } });
        if (found !== varIds.length) return res.status(400).json({ message: 'One or more varieties do not exist.' });
      }
      if (matIds.length) {
        const found = await Material.count({ where: { id: matIds } });
        if (found !== matIds.length) return res.status(400).json({ message: 'One or more materials do not exist.' });
      }

      const applyLinks = async (JoinModel, column, attrIds, transaction) => {
        if (mode === 'replace') {
          // Wipe the selected products' links for this attribute, then re-add the chosen set.
          await JoinModel.destroy({ where: { product_id: ids }, transaction });
          if (attrIds.length) {
            await JoinModel.bulkCreate(
              ids.flatMap((pid) => attrIds.map((aid) => ({ product_id: pid, [column]: aid }))),
              { ignoreDuplicates: true, transaction },
            );
          }
        } else if (mode === 'add') {
          await JoinModel.bulkCreate(
            ids.flatMap((pid) => attrIds.map((aid) => ({ product_id: pid, [column]: aid }))),
            { ignoreDuplicates: true, transaction },
          );
        } else { // remove
          await JoinModel.destroy({ where: { product_id: ids, [column]: attrIds }, transaction });
        }
      };

      await sequelize.transaction(async (transaction) => {
        if (setsVariety) await applyLinks(ProductVariety, 'variety_id', varIds, transaction);
        if (setsMaterial) await applyLinks(ProductMaterial, 'material_id', matIds, transaction);
      });

      // Note: catalogue endpoints carry a 120s Cache-Control (middleware/cacheHeaders), so a
      // browser or CDN may serve the old attributes for up to two minutes. There is no
      // server-side store to purge — it is purely an HTTP TTL.
      return res.status(200).json({ success: true, updated: ids.length, mode });
    } catch (error) {
      logServerError('bulkSetAttributes', error);
      return res.status(500).json({ message: 'Failed to update products.' });
    }
  }
}

module.exports = new ProductController();
