/**
 * Slugs for taxonomy rows (varieties, materials, and anything else with a name + slug).
 *
 * ── Why the server owns this ────────────────────────────────────────────────────────────
 * The admin form used to build the slug in the browser and post it alongside the name, which
 * failed in two ways. On create, two clients could disagree about the rules. On update it
 * sent back the EXISTING slug, so renaming "Katan" to "Katan Silk" left the slug reading
 * `katan` forever — the URL and the label drifted apart with nothing to reconcile them.
 *
 * Deriving it here from the name means one rule, applied on every write, and a rename keeps
 * the slug honest without the client having to think about it.
 */

const slugify = (value) => String(value ?? '')
  .normalize('NFKD')                 // "Kadwā" -> "Kadwa" once the marks below are stripped
  .replace(/[̀-ͯ]/g, '')   // combining accents
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')       // anything not url-safe becomes a separator
  .replace(/^-+|-+$/g, '')           // no leading/trailing dashes
  .slice(0, 120);

/**
 * A slug that is free, given a model with a unique `slug` column.
 *
 * Appends -2, -3 … on collision. Two materials legitimately called "Silk Blend" would
 * otherwise be a unique-constraint error thrown in the admin's face for something the server
 * can resolve on its own.
 *
 * `excludeId` is the row being updated — without it, saving a variety without renaming it
 * would collide with its own existing slug and get pointlessly suffixed.
 *
 * Racy in theory: two simultaneous creates of the same name can both see the base as free.
 * The unique index still refuses the loser, which is the correct outcome — this narrows the
 * window rather than pretending to close it.
 */
const uniqueSlug = async (Model, name, { excludeId = null, transaction = null } = {}) => {
  const { Op } = require('sequelize');
  const base = slugify(name) || 'item';

  const where = { slug: { [Op.like]: `${base}%` } };
  if (excludeId) where.id = { [Op.ne]: excludeId };

  const taken = new Set(
    (await Model.findAll({ where, attributes: ['slug'], raw: true, transaction }))
      .map((row) => row.slug),
  );

  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
};

module.exports = { slugify, uniqueSlug };
