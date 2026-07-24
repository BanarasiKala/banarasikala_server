const Material = require('../models/Material');
const { uniqueSlug } = require('../utils/slugify');

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
    // The slug is derived from the name, not accepted from the caller — see utils/slugify.
    const slug = await uniqueSlug(Material, data.name);
    return await Material.create({ ...data, slug });
  }

  async updateMaterial(id, data) {
    const row = await Material.findByPk(id);
    if (!row) throw new Error('Material not found');

    // A rename re-slugs. Leaving the old slug behind is how a URL ends up describing a
    // name the row no longer has.
    const patch = { ...data };
    if (patch.name && patch.name !== row.name) {
      patch.slug = await uniqueSlug(Material, patch.name, { excludeId: row.id });
    } else {
      // Never let a stale slug posted by an old client overwrite the real one.
      delete patch.slug;
    }
    return await row.update(patch);
  }

  async deleteMaterial(id) {
    const material = await Material.findByPk(id);
    if (!material) throw new Error('Material not found');
    return await material.destroy();
  }
}

module.exports = new MaterialService();
