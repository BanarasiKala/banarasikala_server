const VarietyService = require('../services/VarietyService');
const { uploadBufferToCloudinary } = require("../config/cloudinary");

class VarietyController {
  async getAll(req, res) {
    try {
      const varieties = await VarietyService.getAllVarieties(req.query);
      res.status(200).json(varieties);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getById(req, res) {
    try {
      const variety = await VarietyService.getVarietyById(req.params.id);
      if (!variety) return res.status(404).json({ message: 'Variety not found' });
      res.status(200).json(variety);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async create(req, res) {
    try {
      const data = { ...req.body };
      if (req.file) {
        const uploadResult = await uploadBufferToCloudinary(req.file.buffer);
        data.image = uploadResult.secure_url;
      }

      if (!data.image) {
        return res.status(400).json({ message: "Image is mandatory for Variety" });
      }

      const variety = await VarietyService.createVariety(data);
      res.status(201).json(variety);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async update(req, res) {
    try {
      const data = { ...req.body };
      if (req.file) {
        const uploadResult = await uploadBufferToCloudinary(req.file.buffer);
        data.image = uploadResult.secure_url;
      }
      const variety = await VarietyService.updateVariety(req.params.id, data);
      res.status(200).json(variety);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async delete(req, res) {
    try {
      await VarietyService.deleteVariety(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }
}

module.exports = new VarietyController();
