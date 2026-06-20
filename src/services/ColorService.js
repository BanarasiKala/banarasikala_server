const { Op } = require('sequelize');
const Color = require('../models/Color');

const normalizeHex = (hex) => {
  if (!hex) return null;
  const clean = String(hex).trim().toLowerCase();
  return clean.startsWith('#') ? clean : `#${clean}`;
};

class ColorService {
  async _checkUnique(name, hexCode, excludeId = null) {
    const conditions = [];
    if (name) conditions.push({ name: { [Op.iLike]: name.trim() } });
    if (hexCode) conditions.push({ hex_code: { [Op.iLike]: normalizeHex(hexCode) } });
    if (!conditions.length) return;

    const where = { [Op.or]: conditions };
    if (excludeId) where.id = { [Op.ne]: excludeId };

    const existing = await Color.findOne({ where });
    if (!existing) return;

    if (name && existing.name.toLowerCase() === name.trim().toLowerCase()) {
      throw new Error(`A color named "${existing.name}" already exists.`);
    }
    throw new Error(`Hex code "${existing.hex_code}" is already used by color "${existing.name}".`);
  }

  async getAllColors() {
    return await Color.findAll();
  }

  async getColorById(id) {
    return await Color.findByPk(id);
  }

  async createColor(data) {
    await this._checkUnique(data.name, data.hex_code);
    if (data.hex_code) data.hex_code = normalizeHex(data.hex_code);
    return await Color.create(data);
  }

  async updateColor(id, data) {
    const color = await Color.findByPk(id);
    if (!color) throw new Error('Color not found');
    await this._checkUnique(data.name, data.hex_code, id);
    if (data.hex_code) data.hex_code = normalizeHex(data.hex_code);
    return await color.update(data);
  }

  async deleteColor(id) {
    const color = await Color.findByPk(id);
    if (!color) throw new Error('Color not found');
    return await color.destroy();
  }
}

module.exports = new ColorService();
