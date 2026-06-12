const PRODUCT_PREFIX = 'BKS';
const ORDER_PREFIX = 'BKS';

// BKS00001 → product SKU (5-digit zero-padded)
const formatProductCode = (id) => `${PRODUCT_PREFIX}${String(id).padStart(5, '0')}`;

const slugifyCodePart = (value, fallback = 'variant') => {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
  return slug || fallback;
};

// BKS00001-red → variant SKU
const formatVariantItemCode = (productCode, colorName, colorId = null) =>
  `${productCode}-${slugifyCodePart(colorName, colorId ? `color-${colorId}` : 'variant')}`;

// BKS20260528{orderId} — generated AFTER order insert so DB id is available
const formatOrderNumber = (date, orderId) => {
  const year  = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day   = String(date.getDate()).padStart(2, '0');
  return `${ORDER_PREFIX}${year}${month}${day}${orderId}`;
};

module.exports = {
  formatProductCode,
  formatVariantItemCode,
  formatOrderNumber,
};
