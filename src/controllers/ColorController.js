const ColorService = require('../services/ColorService');

class ColorController {
  async getAll(req, res) {
    try {
      const colors = await ColorService.getAllColors();
      res.status(200).json(colors);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getById(req, res) {
    try {
      const color = await ColorService.getColorById(req.params.id);
      if (!color) return res.status(404).json({ message: 'Color not found' });
      res.status(200).json(color);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async create(req, res) {
    try {
      const color = await ColorService.createColor(req.body);
      res.status(201).json(color);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async update(req, res) {
    try {
      const color = await ColorService.updateColor(req.params.id, req.body);
      res.status(200).json(color);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }

  async delete(req, res) {
    try {
      await ColorService.deleteColor(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }
}

module.exports = new ColorController();
