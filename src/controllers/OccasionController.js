const OccasionService = require('../services/OccasionService');
const { uploadBufferToCloudinary } = require("../config/cloudinary");

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

  async create(req, res) {
    try {
      let data = req.body;
      if (req.file) {
        const uploadResult = await uploadBufferToCloudinary(req.file.buffer);
        data = { ...data, image: uploadResult.secure_url };
      } else {
        return res.status(400).json({ message: "Image is mandatory for Occasion" });
      }
      const occasion = await OccasionService.createOccasion(data);
      res.status(201).json(occasion);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async update(req, res) {
    try {
      let data = req.body;
      if (req.file) {
        const uploadResult = await uploadBufferToCloudinary(req.file.buffer);
        data = { ...data, image: uploadResult.secure_url };
      }
      const occasion = await OccasionService.updateOccasion(req.params.id, data);
      res.status(200).json(occasion);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async delete(req, res) {
    try {
      await OccasionService.deleteOccasion(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }
}

module.exports = new OccasionController();
