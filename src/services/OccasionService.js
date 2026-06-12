const Occasion = require('../models/Occasion');

const pickAttributes = (fields, allowed) => {
  if (!fields) return undefined;
  const selected = String(fields)
    .split(",")
    .map((field) => field.trim())
    .filter((field) => allowed.includes(field));
  return selected.length ? selected : undefined;
};

class OccasionService {
  async getAllOccasions(filters = {}) {
    const parsedLimit = parseInt(filters.limit, 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(50, Math.max(1, parsedLimit))
      : 0;
    return await Occasion.findAll({
      attributes: pickAttributes(filters.fields, ["id", "name", "slug", "image", "createdAt", "updatedAt"]),
      order: [['name', 'ASC']],
      ...(limit ? { limit } : {}),
    });
  }

  async getOccasionById(id) {
    return await Occasion.findByPk(id);
  }

  async getOccasionBySlug(slug) {
    return await Occasion.findOne({ where: { slug } });
  }

  async createOccasion(data) {
    // Auto-generate slug if not provided
    if (!data.slug && data.name) {
      data.slug = data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    }
    return await Occasion.create(data);
  }

  async updateOccasion(id, data) {
    const occasion = await Occasion.findByPk(id);
    if (!occasion) throw new Error('Occasion not found');
    
    // Auto-generate slug if name changed but slug not provided
    if (data.name && !data.slug && data.name !== occasion.name) {
      data.slug = data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    }
    
    return await occasion.update(data);
  }

  async deleteOccasion(id) {
    const occasion = await Occasion.findByPk(id);
    if (!occasion) throw new Error('Occasion not found');
    return await occasion.destroy();
  }
}

module.exports = new OccasionService();
