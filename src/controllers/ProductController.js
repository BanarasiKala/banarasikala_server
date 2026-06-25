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
}

module.exports = new ProductController();
