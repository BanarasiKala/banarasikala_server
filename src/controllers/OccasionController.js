const OccasionService = require('../services/OccasionService');
const { generateS3PresignedUploadUrl, deleteS3Object } = require("../config/s3");

class OccasionController {
  async getAll(req, res) {
    try {
      const occasions = await OccasionService.getAllOccasions(req.query);
      res.status(200).json(occasions);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getById(req, res) {
    try {
      const occasion = await OccasionService.getOccasionById(req.params.id);
      if (!occasion) return res.status(404).json({ message: 'Occasion not found' });
      res.status(200).json(occasion);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getBySlug(req, res) {
    try {
      const occasion = await OccasionService.getOccasionBySlug(req.params.slug);
      if (!occasion) return res.status(404).json({ message: 'Occasion not found' });
      res.status(200).json(occasion);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  // Returns a short-lived pre-signed PUT URL the admin browser uploads the
  // video to directly, plus the permanent public URL to store on the occasion.
  async getUploadUrl(req, res) {
    try {
      const { fileName = "occasion.mp4", contentType = "video/mp4" } = req.query;
      const result = await generateS3PresignedUploadUrl(fileName, contentType, "occasions");
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: error.message || "Failed to generate upload URL." });
    }
  }

  async create(req, res) {
    try {
      const data = req.body;
      if (!data.video) {
        return res.status(400).json({ message: "A video is mandatory for Occasion" });
      }
      const occasion = await OccasionService.createOccasion(data);
      res.status(201).json(occasion);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async update(req, res) {
    try {
      const existing = await OccasionService.getOccasionById(req.params.id);
      if (!existing) return res.status(404).json({ message: 'Occasion not found' });

      const data = { ...req.body };
      // If a new video was uploaded, remove the old S3 object. If no (or the
      // same) video came in, keep the existing one rather than wiping it.
      if (data.video && data.video !== existing.video) {
        await deleteS3Object(existing.video);
      } else {
        delete data.video;
      }

      const occasion = await OccasionService.updateOccasion(req.params.id, data);
      res.status(200).json(occasion);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async delete(req, res) {
    try {
      const existing = await OccasionService.getOccasionById(req.params.id);
      if (existing?.video) await deleteS3Object(existing.video);
      await OccasionService.deleteOccasion(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }
}

module.exports = new OccasionController();
