const { Op } = require('sequelize');
const ProductService = require('./ProductService');
const CartService = require('./CartService');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const OrderItemAction = require('../models/OrderItemAction');
const OrderLedger = require('../models/OrderLedger');
const Shipment = require('../models/Shipment');
const Color = require('../models/Color');
const {
  isDeliveredEnoughForPostDeliveryAction, getActionableQuantity,
} = require('../utils/orderItemActions');
const { SHIPMENT_TYPE } = require('../utils/orderModelV2');
const { deriveOrderTotals } = require('./orderLedgerService');
const { RETURN_WINDOW_DAYS, isWithinReturnWindow } = require('./OrderReturnService');

/**
 * The tools the AI assistant can call.
 *
 * ── THE SECURITY BOUNDARY ────────────────────────────────────────────────────────────────
 * Two rules, and neither is negotiable:
 *
 *   1. NO TOOL TAKES AN IDENTITY. The customer id always comes from the JWT (`req.user.id`),
 *      passed in here as `customerId`. It is NEVER a tool parameter, because a tool parameter
 *      is a string the MODEL chose — and the model can be talked into choosing any string a
 *      visitor types. Every order/cart query is scoped with `customer_id` in the WHERE clause,
 *      not fetched-then-checked.
 *
 *      Without this, "show me order BKS2026071277" reads out a stranger's address and phone.
 *
 *   2. NO SQL TOOL, EVER. Tools take typed parameters; this file builds the query. A
 *      `run_query(sql)` tool is natural-language SQL injection with extra steps.
 *
 * Handlers return plain JSON. They must not throw — a thrown error becomes an unhandled
 * rejection inside the tool loop. Return `{ error: "..." }` and let the model recover.
 */

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

// What the model (and the product-card renderer) sees for one saree. Deliberately small —
// every field here is re-sent to the model on every subsequent turn.
/**
 * A search hit, in two widths.
 *
 * The browser needs the image URL, MRP and strike-through discount to render a card. The
 * MODEL does not — it only needs enough to talk about the saree and to pass a slug to a
 * follow-up tool. That difference matters because a tool result is not paid for once: it
 * stays in the conversation and is re-sent on every subsequent turn.
 *
 * A Cloudinary URL alone is ~100 characters. Across 6 products, plus mrp/discount/description,
 * the fat shape is ~600 tokens per search and the slim one ~250 — and that gap compounds for
 * the rest of the conversation.
 *
 * So: `card` goes to React over SSE, `model` goes to Claude.
 */
const serializeProduct = (product) => {
  const plain = typeof product?.toJSON === 'function' ? product.toJSON() : product;
  if (!plain) return null;
  const images = Array.isArray(plain.images) ? plain.images : [];
  const cover = images.find((img) => img.is_cover) || images[0];
  return {
    product_id: plain.id,
    name: plain.name,
    slug: plain.slug,
    price: money(plain.selling_price),
    mrp: money(plain.mrp_price),
    discount_percent: Number(plain.discount_percent) || 0,
    in_stock: Number(plain.stock_quantity || 0) > 0,
    image_url: cover?.url || cover?.image_url || null,
    short_description: plain.short_description || null,
  };
};

// What Claude actually needs to describe a saree and reference it in a follow-up tool call.
// Drops image_url, mrp, discount_percent and short_description — all rendering concerns.
const slimForModel = (p) => ({
  name: p.name,
  slug: p.slug,
  price: p.price,
  in_stock: p.in_stock,
});

// ── PUBLIC TOOLS ───────────────────────────────────────────────────────────────────────

/**
 * Live catalogue search. Maps straight onto ProductService.getAllProducts, which already does
 * fuzzy matching via Postgres pg_trgm `similarity()` — so "banarsi saaree" matches despite the
 * typos, with no embeddings and no vector store.
 */
const search_products = async (input = {}) => {
  const products = await ProductService.getAllProducts({
    search: String(input.query || '').trim(),
    minPrice: input.min_price,
    maxPrice: input.max_price,
    color: input.color,
    material: input.material,
    status: 'active',
    stockStatus: input.in_stock_only === false ? undefined : 'in_stock',
    sortBy: input.sort_by === 'price_low' ? 'price_asc'
      : input.sort_by === 'price_high' ? 'price_desc'
        : 'newest',
    // `limit` is the cap, NOT `pageSize`: with `paginated` unset, getAllProducts slices by
    // rawLimit and ignores pageSize entirely — passing only pageSize would return the WHOLE
    // matching catalogue and stuff every row into the prompt.
    limit: Math.min(8, Math.max(1, Number(input.limit) || 6)),
    // Trims each row to id/name/slug/price/images/stock — exactly what serializeProduct needs,
    // and nothing else. Every extra field here is re-sent to the model on every later turn.
    view: 'collection',
  });

  const rows = Array.isArray(products) ? products : (products?.items || []);
  const results = rows.map(serializeProduct).filter(Boolean);

  // Say "nothing found" explicitly. An empty array reads to the model as "I got nothing back",
  // which is exactly the moment it is tempted to invent a saree.
  if (!results.length) {
    return {
      found: 0,
      products: [],
      note: 'No sarees matched. Do NOT invent one. Tell the customer nothing matched and offer to widen the search (different colour, higher budget, or another fabric).',
    };
  }
  // products -> the model (slim). _cards -> the browser (full). AiChatService.buildTool
  // strips _cards before the result reaches Claude.
  return { found: results.length, products: results.map(slimForModel), _cards: results };
};

const get_product_details = async (input = {}) => {
  const detail = await ProductService.getProductDetailBySlug(String(input.slug || '').trim());
  if (!detail) return { error: 'No saree exists with that slug. Do not invent one.' };

  const plain = typeof detail.toJSON === 'function' ? detail.toJSON() : detail;
  return {
    ...serializeProduct(plain),
    description: plain.description || null,
    care_instructions: plain.care_instructions || null,
    key_highlights: plain.key_highlights || null,
    blouse_piece: plain.blouse_piece ?? null,
    // Per-colour availability — this is what makes "is it in red?" answerable.
    colors: (plain.colors || []).map((c) => ({
      color_id: c.id,
      name: c.name,
      in_stock: Number(c.stock_quantity || 0) > 0,
    })),
  };
};

const find_similar_products = async (input = {}) => {
  const related = await ProductService.getRelatedProducts(
    String(input.slug || '').trim(),
    Math.min(6, Math.max(1, Number(input.limit) || 4)),
  );
  const results = (related || []).map(serializeProduct).filter(Boolean);
  return { found: results.length, products: results.map(slimForModel), _cards: results };
};

// ── ACCOUNT TOOLS ──────────────────────────────────────────────────────────────────────
// Only registered when a customer is signed in (see AiChatService.buildTools). A tool that is
// not in the `tools` array cannot be called at all — that is the strongest boundary available,
// stronger than declaring it and guarding inside.

/**
 * Takes NO arguments, by design. There is no order id for the model to guess, invent, or be
 * talked into. It reads the session, full stop.
 */
/**
 * NOTE: there is no `total_amount` / `payable_amount` COLUMN on orders. In the V2 model money
 * is derived from the append-only ledger (deriveOrderTotals) — reading `order.total_amount`
 * returns undefined, and the bot would cheerfully tell the customer their order total is
 * "undefined". Same story for the AWB: it lives on the Shipment row, not the order.
 */
const orderTotalsFor = async (orderIds) => {
  if (!orderIds.length) return new Map();
  const rows = await OrderLedger.findAll({ where: { order_id: { [Op.in]: orderIds } } });
  const byOrder = new Map();
  for (const row of rows) {
    const key = Number(row.order_id);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(row);
  }
  const totals = new Map();
  for (const id of orderIds) {
    totals.set(Number(id), deriveOrderTotals(byOrder.get(Number(id)) || []));
  }
  return totals;
};

const get_my_orders = async (_input, { customerId }) => {
  if (!customerId) return { error: 'Not signed in.' };

  const orders = await Order.findAll({
    where: { customer_id: customerId },
    include: [{ model: OrderItem, attributes: ['product_name', 'quantity'] }],
    order: [['created_at', 'DESC']],
    limit: 5,
  });

  // One ledger query for all five orders, not one per order.
  const totals = await orderTotalsFor(orders.map((o) => o.id));

  return {
    found: orders.length,
    orders: orders.map((order) => ({
      order_number: order.order_number,
      status: order.status,
      placed_on: order.createdAt,
      delivered_at: order.delivered_at,
      total: money(totals.get(Number(order.id))?.payable_amount),
      items: (order.OrderItems || []).map((i) => `${i.quantity} × ${i.product_name}`),
    })),
  };
};

/**
 * Scoped by customer_id IN THE QUERY. Not "fetch then compare" — if the order isn't theirs it
 * does not exist as far as this tool is concerned, so there is nothing to leak even if the
 * model is fed an order number by a malicious visitor.
 *
 * Returns status and items only. NOT the address or phone: the model has no use for them, and
 * anything the model sees is echoed into the transcript.
 */
const get_order_details = async (input = {}, { customerId }) => {
  if (!customerId) return { error: 'Not signed in.' };

  const order = await Order.findOne({
    where: {
      order_number: String(input.order_number || '').trim(),
      customer_id: customerId, // ← the boundary
    },
    include: [{ model: OrderItem }],
  });
  if (!order) return { error: 'No such order on this account.' };

  const totals = (await orderTotalsFor([order.id])).get(Number(order.id));

  // The AWB lives on the latest FORWARD shipment, not on the order. Latest, not first: after an
  // RTO re-dispatch or an exchange replacement the earlier shipment's AWB is stale and tracking
  // it would show the customer a journey that already ended.
  const shipment = await Shipment.findOne({
    where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD },
    order: [['created_at', 'DESC']],
    attributes: ['awb_number', 'courier'],
  });

  return {
    order_number: order.order_number,
    status: order.status,
    placed_on: order.createdAt,
    delivered_at: order.delivered_at,
    payment_method: order.payment_method,
    total: money(totals?.payable_amount),
    amount_paid: money(totals?.amount_paid),
    tracking_awb: shipment?.awb_number || null,
    courier: shipment?.courier || null,
    items: (order.OrderItems || []).map((item) => ({
      product_name: item.product_name,
      quantity: item.quantity,
      price: money(item.price),
      status: item.status,
    })),
  };
};

/**
 * Mirrors the real eligibility rules (OrderReturnService.assertReverseEligibility) rather than
 * restating them, so the bot can never promise a return the system will refuse.
 */
const check_return_eligibility = async (input = {}, { customerId }) => {
  if (!customerId) return { error: 'Not signed in.' };

  const order = await Order.findOne({
    where: {
      order_number: String(input.order_number || '').trim(),
      customer_id: customerId, // ← the boundary
    },
    include: [{ model: OrderItem, include: [OrderItemAction] }],
  });
  if (!order) return { error: 'No such order on this account.' };

  if (!isDeliveredEnoughForPostDeliveryAction(order)) {
    return { eligible: false, reason: 'This order has not been delivered yet. Returns and exchanges open after delivery.' };
  }
  if (!isWithinReturnWindow(order)) {
    return { eligible: false, reason: `The ${RETURN_WINDOW_DAYS}-day window after delivery has closed.` };
  }

  const items = (order.OrderItems || []).map((item) => {
    const actions = item.OrderItemActions || [];
    const used = actions.find((a) => !['Rejected', 'Cancelled'].includes(a.status));
    return {
      product_name: item.product_name,
      eligible: !used && getActionableQuantity(item, actions) > 0,
      // Already returned or exchanged once — the rule is one reverse action per item.
      reason: used ? `Already has a ${used.action_type} request (${used.status}).` : null,
    };
  });

  return {
    eligible: items.some((i) => i.eligible),
    window_days: RETURN_WINDOW_DAYS,
    items,
    note: 'Returns and exchanges are started from the order page, not from chat. Point the customer there.',
  };
};

/**
 * The one STATE-CHANGING tool.
 *
 * Confirmation is enforced in the SCHEMA, not the prompt: `confirmed` is a required boolean,
 * so the model physically cannot call this without having asserted the customer agreed. If it
 * arrives false we refuse and tell it to ask. A prompt instruction saying "please confirm
 * first" is a suggestion; a required parameter is a wall.
 */
const add_to_cart = async (input = {}, { customerId }) => {
  if (!customerId) return { error: 'Not signed in — the customer must sign in to use the cart.' };

  if (input.confirmed !== true) {
    return {
      added: false,
      error: 'Not confirmed. Ask the customer to confirm the exact saree, colour and quantity, then call again with confirmed: true.',
    };
  }

  const product = await ProductService.getProductBySlug(String(input.slug || '').trim());
  if (!product) return { added: false, error: 'No saree exists with that slug.' };

  const quantity = Math.min(5, Math.max(1, Number(input.quantity) || 1));

  // Resolve the colour by NAME (what the customer said) to an id, against this product's own
  // in-stock colours. The model never supplies a raw colour id.
  let colorId = null;
  const stocks = product.color_stocks || {};
  const inStockIds = Object.entries(stocks)
    .filter(([, qty]) => Number(qty) > 0)
    .map(([id]) => Number(id));

  if (input.color_name) {
    const wanted = String(input.color_name).trim().toLowerCase();
    const colors = inStockIds.length
      ? await Color.findAll({ where: { id: { [Op.in]: inStockIds } }, attributes: ['id', 'name'] })
      : [];
    const match = colors.find((c) => String(c.name).toLowerCase() === wanted);
    if (!match) {
      return {
        added: false,
        error: `"${input.color_name}" is not an in-stock colour for this saree. Available: ${colors.map((c) => c.name).join(', ') || 'none'}.`,
      };
    }
    colorId = match.id;
  } else if (inStockIds.length > 1) {
    return { added: false, error: 'This saree has several colours in stock. Ask the customer which one, then call again.' };
  } else if (inStockIds.length === 1) {
    colorId = inStockIds[0];
  }

  try {
    // CartService re-validates stock and rejects an oversell — the source of truth stays there.
    await CartService.addToCart(customerId, product.id, quantity, colorId);
  } catch (error) {
    return { added: false, error: error.message || 'Could not add to cart.' };
  }

  return {
    added: true,
    product_name: product.name,
    quantity,
    note: 'Added. Tell the customer it is in their cart and they can check out when ready. Do not claim the order is placed.',
  };
};

module.exports = {
  serializeProduct,
  publicHandlers: { search_products, get_product_details, find_similar_products },
  accountHandlers: {
    get_my_orders, get_order_details, check_return_eligibility, add_to_cart,
  },
};
