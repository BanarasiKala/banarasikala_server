/**
 * What an exchange sends OUT.
 *
 * One exchanged order line can now be swapped for SEVERAL different sarees — exchange 3
 * units and take 2 × product A and 1 × product B — so the target is a LIST, and its
 * quantities must sum to exactly the quantity being exchanged. Nothing is left implicit:
 * every unit going back has a named unit coming out.
 *
 * Three shapes exist in the wild and all normalise to the same list, so callers never branch:
 *   • meta.exchange_targets  — the list (current).
 *   • meta.exchange_product_id / exchange_color_id — a single target (earlier build).
 *   • neither — a like-for-like replacement of the same saree in the same colour.
 */

const normalizeTarget = (target, fallbackQty = 1) => {
  const productId = Number(target?.product_id ?? target?.productId);
  if (!Number.isInteger(productId) || productId <= 0) return null;
  const rawColor = target?.color_id ?? target?.colorId ?? null;
  const colorId = Number(rawColor) > 0 ? Number(rawColor) : null;
  const quantity = Math.max(1, Number(target?.quantity ?? fallbackQty) || 1);
  return {
    product_id: productId,
    product_name: target?.product_name ?? target?.productName ?? null,
    color_id: colorId,
    color_name: target?.color_name ?? target?.colorName ?? null,
    quantity,
  };
};

/**
 * The sarees this exchange action must ship, as a list. `orderItem` is only consulted to
 * describe a like-for-like swap (the customer kept the same product and colour).
 */
const exchangeTargetsOf = (action, orderItem = null) => {
  const meta = action?.meta || {};
  const actionQty = Math.max(1, Number(action?.quantity || 1));

  if (Array.isArray(meta.exchange_targets) && meta.exchange_targets.length) {
    return meta.exchange_targets.map((t) => normalizeTarget(t)).filter(Boolean);
  }

  // Legacy single-target row, or a like-for-like swap with nothing recorded at all.
  const productId = Number(meta.exchange_product_id)
    || Number(action?.product_id)
    || Number(orderItem?.product_id)
    || null;
  if (!productId) return [];

  const colorId = meta.exchange_color_id
    ?? orderItem?.colorId
    ?? orderItem?.color_id
    ?? null;

  return [normalizeTarget({
    product_id: productId,
    product_name: meta.exchange_product_name || orderItem?.product_name || null,
    color_id: colorId,
    color_name: meta.exchange_color_name || null,
    quantity: actionQty,
  })].filter(Boolean);
};

/** What the customer handed BACK — snapshotted on the action, because the order line is not rewritten. */
const exchangedFromOf = (action, orderItem = null) => {
  const meta = action?.meta || {};
  return {
    product_id: Number(meta.original_product_id || action?.product_id || orderItem?.product_id) || null,
    product_name: meta.original_product_name || orderItem?.product_name || null,
    sku: meta.original_sku || orderItem?.sku || null,
    color_id: meta.original_color_id ?? orderItem?.colorId ?? orderItem?.color_id ?? null,
    color_name: meta.original_color_name || null,
    quantity: Math.max(1, Number(action?.quantity || 1)),
  };
};

const totalTargetQuantity = (targets = []) => targets.reduce(
  (sum, t) => sum + Math.max(1, Number(t?.quantity || 0)),
  0,
);

module.exports = {
  normalizeTarget,
  exchangeTargetsOf,
  exchangedFromOf,
  totalTargetQuantity,
};
