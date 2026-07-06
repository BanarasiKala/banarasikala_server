const BoxSection = require('../models/BoxSection');
const { generateS3PresignedUploadUrl, deleteS3Object } = require('../config/s3');

const normalizeUrls = (list) => (Array.isArray(list)
  ? list.map((url) => String(url || '').trim()).filter(Boolean)
  : []);

class BoxSectionController {
  // Public storefront list — active entries only.
  async getAll(req, res) {
    try {
      const rows = await BoxSection.findAll({
        where: { is_active: true },
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
      const rows = await BoxSection.findAll({
        order: [['display_order', 'ASC'], ['id', 'DESC']],
      });
      res.status(200).json(rows);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  // Pre-signed S3 PUT URL for one video file (called once per video).
  async getUploadUrl(req, res) {
    try {
      const { fileName = 'box.mp4', contentType = 'video/mp4' } = req.query;
      const result = await generateS3PresignedUploadUrl(fileName, contentType, 'box-section');
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: error.message || 'Failed to generate upload URL.' });
    }
  }

  async create(req, res) {
    try {
      const images = normalizeUrls(req.body.images);
      const videos = normalizeUrls(req.body.videos);
      if (!images.length && !videos.length) {
        return res.status(400).json({ message: 'Add at least one image or video.' });
      }
      const row = await BoxSection.create({
        title: String(req.body.title || '').trim() || null,
        description: String(req.body.description || '').trim() || null,
        images,
        videos,
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
      const row = await BoxSection.findByPk(req.params.id);
      if (!row) return res.status(404).json({ message: 'Entry not found' });

      const data = {};
      if (req.body.title !== undefined) data.title = String(req.body.title || '').trim() || null;
      if (req.body.description !== undefined) data.description = String(req.body.description || '').trim() || null;
      if (req.body.images !== undefined) data.images = normalizeUrls(req.body.images);
      if (req.body.is_active !== undefined) data.is_active = Boolean(req.body.is_active);
      if (req.body.display_order !== undefined) data.display_order = Number(req.body.display_order) || 0;

      // Videos removed from the list get their S3 objects deleted too.
      if (req.body.videos !== undefined) {
        const nextVideos = normalizeUrls(req.body.videos);
        const oldVideos = normalizeUrls(row.videos);
        await Promise.all(
          oldVideos
            .filter((url) => !nextVideos.includes(url))
            .map((url) => deleteS3Object(url).catch(() => {})),
        );
        data.videos = nextVideos;
      }

      await row.update(data);
      res.status(200).json(row);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async delete(req, res) {
    try {
      const row = await BoxSection.findByPk(req.params.id);
      if (!row) return res.status(404).json({ message: 'Entry not found' });
      await Promise.all(normalizeUrls(row.videos).map((url) => deleteS3Object(url).catch(() => {})));
      await row.destroy();
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }
}

module.exports = new BoxSectionController();
