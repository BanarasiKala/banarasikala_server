const Color = require('../models/Color');

class ColorService {
  async getAllColors() {
    return await Color.findAll();
  }

  async getColorById(id) {
    return await Color.findByPk(id);
  }

  async createColor(data) {
    return await Color.create(data);
  }

  async updateColor(id, data) {
    const color = await Color.findByPk(id);
    if (!color) throw new Error('Color not found');
    return await color.update(data);
  }

  async deleteColor(id) {
    const color = await Color.findByPk(id);
    if (!color) throw new Error('Color not found');
    return await color.destroy();
  }
}

module.exports = new ColorService();
