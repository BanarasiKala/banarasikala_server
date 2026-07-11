const { Transaction } = require('sequelize');
const Product = require('../models/Product');
const { AppError } = require('./http');

/**
 * Single source of truth for stock movement.
 *
 * Stock lives in TWO places that must always agree: `stock_quantity` (the total) and
 * `color_stocks` (a colourId -> qty map). Every flow that moves goods has to move both, in
 * the same direction, by the same amount — and every flow that got that wrong drifted the
 * inventory silently. Returns and exchanges previously moved NEITHER, so a returned saree
 * was never sellable again and an exchanged colour was never actually consumed.
 *
 * Callers must pass a transaction; the product row is locked FOR UPDATE so two concurrent
 * checkouts / completions can't both read the last unit and both take it.
 */

const hasColor = (colorId) => colorId !== null && colorId !== undefined && colorId !== '';

/**
 * A product's stock for one colour. Falls back to the total for products that were never
 * given a per-colour breakdown (legacy single-variant rows).
 */
const colorStockOf = (product, colorId) => {
  const stocks = product?.color_stocks || {};
  return Number(stocks?.[colorId] ?? stocks?.[String(colorId)] ?? product?.stock_quantity ?? 0);
};

const lockProduct = async (productId, transaction) => Product.findByPk(productId, {
  attributes: ['id', 'name', 'stock_quantity', 'color_stocks'],
  transaction,
  ...(transaction ? { lock: Transaction.LOCK.UPDATE } : {}),
});

/**
 * Take `quantity` units off the shelf. Throws (400) rather than going negative — we must
 * never promise goods we don't have.
 */
const consumeStock = async ({ productId, colorId, quantity, transaction, label }) => {
  const qty = Math.max(1, Number(quantity || 1));
  const product = await lockProduct(productId, transaction);
  if (!product) throw new AppError('Product not found.', 404);

  const currentColorStock = colorStockOf(product, colorId);
  const currentTotalStock = Number(product.stock_quantity || 0);

  if (currentTotalStock < qty || currentColorStock < qty) {
    const available = Math.max(0, Math.min(currentColorStock, currentTotalStock));
    throw new AppError(
      `Only ${available} item(s) are available for ${label || product.name}.`,
      400,
    );
  }

  const updatePayload = { stock_quantity: currentTotalStock - qty };
  if (hasColor(colorId)) {
    updatePayload.color_stocks = {
      ...(product.color_stocks || {}),
      [String(colorId)]: currentColorStock - qty,
    };
  }
  await product.update(updatePayload, { transaction });
  return product;
};

/**
 * Put `quantity` units back on the shelf (cancellation, completed return, the colour handed
 * back in an exchange). Never throws on the happy path — goods coming back are always valid.
 */
const releaseStock = async ({ productId, colorId, quantity, transaction }) => {
  const qty = Math.max(1, Number(quantity || 1));
  const product = await lockProduct(productId, transaction);
  if (!product) return null;

  const updatePayload = { stock_quantity: Number(product.stock_quantity || 0) + qty };
  if (hasColor(colorId)) {
    updatePayload.color_stocks = {
      ...(product.color_stocks || {}),
      [String(colorId)]: colorStockOf(product, colorId) + qty,
    };
  }
  await product.update(updatePayload, { transaction });
  return product;
};

module.exports = {
  colorStockOf,
  consumeStock,
  releaseStock,
};
