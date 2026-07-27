const { config } = require('../config/env');

/**
 * Turns a coupon or a product into campaign copy.
 *
 * Kept apart from the controller so the wording of a "new arrival" mail lives in one place
 * rather than being assembled inline at the call site, and apart from EmailService so there is
 * still exactly ONE renderer — every campaign, however it was generated, is stored on the same
 * campaign row and sent by the same code path.
 */

const storeUrl = () => (config.frontendUrl || 'https://banarasikala.com').replace(/\/$/, '');

const money = (value) => `Rs. ${Number(value || 0).toLocaleString('en-IN')}`;

/** The offer in one line, phrased the way a shopper reads it rather than how it is stored. */
const describeDiscount = (coupon) => {
  const isFixed = String(coupon.discount_type) === 'fixed_amount' && Number(coupon.discount_amount) > 0;
  const headline = isFixed
    ? `${money(coupon.discount_amount)} off`
    : `${Number(coupon.discount_percent || 0)}% off`;

  const conditions = [];
  if (Number(coupon.min_purchase_amount) > 0) {
    conditions.push(`on orders above ${money(coupon.min_purchase_amount)}`);
  }
  if (!isFixed && Number(coupon.max_discount_amount) > 0) {
    conditions.push(`up to ${money(coupon.max_discount_amount)}`);
  }
  return { headline, conditions: conditions.join(', ') };
};

const formatDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
};

const buildCouponCampaign = (coupon) => {
  const { headline, conditions } = describeDiscount(coupon);
  const expires = formatDate(coupon.valid_until);
  const code = String(coupon.code || '').toUpperCase();

  const lines = [
    `Use code ${code} at checkout to get ${headline}${conditions ? ` ${conditions}` : ''}.`,
  ];
  if (coupon.description) lines.push(String(coupon.description).trim());
  if (expires) lines.push(`Valid until ${expires}.`);

  return {
    subject: `${headline} with code ${code} | Banarasi Kala`,
    heading: `${headline} — code ${code}`,
    intro: `A little something for you: use <strong>${code}</strong> at checkout for ${headline}${conditions ? ` ${conditions}` : ''}.`,
    body: lines.join('\n\n'),
    cta_label: 'Shop the collection',
    cta_url: `${storeUrl()}/collection`,
    image_url: null,
    source_type: 'coupon',
    source_id: coupon.id,
    template: 'coupon',
  };
};

const coverImageOf = (product) => {
  const images = Array.isArray(product?.images) ? product.images : [];
  const cover = images.find((image) => image.is_cover) || images[0] || null;
  return cover?.url || cover?.image_url || null;
};

const PRODUCT_TEMPLATES = {
  exclusive: {
    template: 'exclusive',
    subject: (name) => `An exclusive pick: ${name} | Banarasi Kala`,
    heading: 'An exclusive pick',
    intro: (name) => `We have set aside something special — <strong>${name}</strong>, chosen for our exclusive collection.`,
    line: 'Exclusive pieces are woven in very small numbers, so they rarely stay long.',
    cta: 'View this saree',
  },
  new_arrival: {
    template: 'new_arrival',
    subject: (name) => `Just arrived: ${name} | Banarasi Kala`,
    heading: 'Fresh off the loom',
    intro: (name) => `<strong>${name}</strong> has just arrived, and you are among the first to see it.`,
    line: 'Every piece is handwoven in Varanasi, and no two are ever quite the same.',
    cta: 'See it first',
  },
};

const buildProductCampaign = (product, kind) => {
  const shape = PRODUCT_TEMPLATES[kind];
  if (!shape) return null;

  const name = String(product.name || 'a new saree').trim();
  const price = Number(product.selling_price || 0);
  const lines = [shape.line];
  if (price > 0) lines.push(`${name} — ${money(price)}.`);

  return {
    subject: shape.subject(name),
    heading: shape.heading,
    intro: shape.intro(name),
    body: lines.join('\n\n'),
    cta_label: shape.cta,
    cta_url: product.slug ? `${storeUrl()}/product/${product.slug}` : `${storeUrl()}/collection`,
    image_url: coverImageOf(product),
    source_type: 'product',
    source_id: product.id,
    template: shape.template,
  };
};

module.exports = { buildCouponCampaign, buildProductCampaign, PRODUCT_TEMPLATES };
