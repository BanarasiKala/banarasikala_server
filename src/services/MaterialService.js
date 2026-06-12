const Material = require('../models/Material');

const pickAttributes = (fields, allowed) => {
  if (!fields) return undefined;
  const selected = String(fields)
    .split(",")
    .map((field) => field.trim())
    .filter((field) => allowed.includes(field));
  return selected.length ? selected : undefined;
};

class MaterialService {
  async getAllMaterials(filters = {}) {
    return await Material.findAll({
      attributes: pickAttributes(filters.fields, ["id", "name", "slug", "image", "createdAt", "updatedAt"]),
      order: [["name", "ASC"]],
    });
  }

  async getMaterialById(id) {
    return await Material.findByPk(id);
  }

  async createMaterial(data) {
    return await Material.create(data);
  }

  async updateMaterial(id, data) {
    const material = await Material.findByPk(id);
    if (!material) throw new Error('Material not found');
    return await material.update(data);
  }

  async deleteMaterial(id) {
    const material = await Material.findByPk(id);
    if (!material) throw new Error('Material not found');
    return await material.destroy();
  }
}

module.exports = new MaterialService();
