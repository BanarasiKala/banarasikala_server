const BanarasRoyale = require('../models/BanarasRoyale');
const Product = require('../models/Product');
const { generateS3PresignedUploadUrl, deleteS3Object } = require('../config/s3');

const PRODUCT_ATTRS = ['id', 'name', 'slug', 'selling_price', 'mrp_price', 'images'];

const normalizeImages = (images) => (Array.isArray(images)
  ? images.map((url) => String(url || '').trim()).filter(Boolean)
  : []);

class BanarasRoyaleController {
  // Public storefront list — active entries only, with the linked product.
  async getAll(req, res) {
    try {
      const rows = await BanarasRoyale.findAll({
        where: { is_active: true },
        include: [{ model: Product, attributes: PRODUCT_ATTRS }],
        order: [['display_order', 'ASC'], ['id', 'DESC']],
      });
      res.status(200).json(rows);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  // Admin list — every entry, active or not.
  async listAdmin(req, res) {
    try {
      const rows = await BanarasRoyale.findAll({
        include: [{ model: Product, attributes: PRODUCT_ATTRS }],
        order: [['display_order', 'ASC'], ['id', 'DESC']],
      });
      res.status(200).json(rows);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  // Pre-signed S3 PUT URL for the entry's video (admin browser uploads
  // directly, then sends the permanent public URL with the entry).
  async getUploadUrl(req, res) {
    try {
      const { fileName = 'royale.mp4', contentType = 'video/mp4' } = req.query;
      const result = await generateS3PresignedUploadUrl(fileName, contentType, 'royale');
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: error.message || 'Failed to generate upload URL.' });
    }
  }

  async create(req, res) {
    try {
      const images = normalizeImages(req.body.images);
      const video = String(req.body.video || '').trim() || null;
      if (!video && images.length === 0) {
        return res.status(400).json({ message: 'Add at least one image or a video.' });
      }
      const row = await BanarasRoyale.create({
        title: String(req.body.title || '').trim() || null,
        description: String(req.body.description || '').trim() || null,
        images,
        video,
        product_id: req.body.product_id ? Number(req.body.product_id) : null,
        is_active: req.body.is_active !== false,
        display_order: Number(req.body.display_order) || 0,
      });
      res.status(201).json(row);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async update(req, res) {
    try {
      const row = await BanarasRoyale.findByPk(req.params.id);
      if (!row) return res.status(404).json({ message: 'Entry not found' });

      const data = {};
      if (req.body.title !== undefined) data.title = String(req.body.title || '').trim() || null;
      if (req.body.description !== undefined) data.description = String(req.body.description || '').trim() || null;
      if (req.body.images !== undefined) data.images = normalizeImages(req.body.images);
      if (req.body.product_id !== undefined) data.product_id = req.body.product_id ? Number(req.body.product_id) : null;
      if (req.body.is_active !== undefined) data.is_active = Boolean(req.body.is_active);
      if (req.body.display_order !== undefined) data.display_order = Number(req.body.display_order) || 0;

      // A replaced video removes the old S3 object; omitting it keeps the old one.
      if (req.body.video !== undefined) {
        const nextVideo = String(req.body.video || '').trim() || null;
        if (nextVideo !== row.video && row.video) await deleteS3Object(row.video);
        data.video = nextVideo;
      }

      await row.update(data);
      res.status(200).json(row);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async delete(req, res) {
    try {
      const row = await BanarasRoyale.findByPk(req.params.id);
      if (!row) return res.status(404).json({ message: 'Entry not found' });
      if (row.video) await deleteS3Object(row.video);
      await row.destroy();
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }
}

module.exports = new BanarasRoyaleController();
