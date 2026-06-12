const Variety = require('../models/Variety');

const pickAttributes = (fields, allowed) => {
  if (!fields) return undefined;
  const selected = String(fields)
    .split(",")
    .map((field) => field.trim())
    .filter((field) => allowed.includes(field));
  return selected.length ? selected : undefined;
};

class VarietyService {
  async getAllVarieties(filters = {}) {
    return await Variety.findAll({
      attributes: pickAttributes(filters.fields, ["id", "name", "slug", "image", "createdAt", "updatedAt"]),
      order: [["name", "ASC"]],
    });
  }

  async getVarietyById(id) {
    return await Variety.findByPk(id);
  }

  async createVariety(data) {
    return await Variety.create(data);
  }

  async updateVariety(id, data) {
    const variety = await Variety.findByPk(id);
    if (!variety) throw new Error('Variety not found');
    return await variety.update(data);
  }

  async deleteVariety(id) {
    const variety = await Variety.findByPk(id);
    if (!variety) throw new Error('Variety not found');
    return await variety.destroy();
  }
}

module.exports = new VarietyService();
