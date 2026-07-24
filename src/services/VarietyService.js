const Variety = require('../models/Variety');
const { uniqueSlug } = require('../utils/slugify');

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
    // The slug is derived from the name, not accepted from the caller — see utils/slugify.
    const slug = await uniqueSlug(Variety, data.name);
    return await Variety.create({ ...data, slug });
  }

  async updateVariety(id, data) {
    const row = await Variety.findByPk(id);
    if (!row) throw new Error('Variety not found');

    // A rename re-slugs. Leaving the old slug behind is how a URL ends up describing a
    // name the row no longer has.
    const patch = { ...data };
    if (patch.name && patch.name !== row.name) {
      patch.slug = await uniqueSlug(Variety, patch.name, { excludeId: row.id });
    } else {
      // Never let a stale slug posted by an old client overwrite the real one.
      delete patch.slug;
    }
    return await row.update(patch);
  }

  async deleteVariety(id) {
    const variety = await Variety.findByPk(id);
    if (!variety) throw new Error('Variety not found');
    return await variety.destroy();
  }
}

module.exports = new VarietyService();
