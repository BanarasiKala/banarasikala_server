const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');

/**
 * Build the order card that gets posted INTO a support conversation.
 *
 * Built on the server, never accepted from the client. The card is the only thing telling
 * support which saree a complaint is about, so a browser that could dictate its contents
 * could put any product, any order number, in front of an agent about to authorise a refund.
 * The client sends an order id; ownership is checked by the caller; everything shown is read
 * back out of the database here.
 *
 * The result is stored as a snapshot on the message rather than joined at read time. A
 * thread has to render the order as it was when the customer complained — join it live and
 * cancelling a line six weeks later silently rewrites the conversation, and reading one
 * thread becomes a fan-out of order queries.
 */

const sortProductImages = (images = []) => [...images].sort((a, b) => {
  const left = Number.isFinite(Number(a.display_order)) ? Number(a.display_order) : 999;
  const right = Number.isFinite(Number(b.display_order)) ? Number(b.display_order) : 999;
  return left - right;
});

// Mirrors pickOrderItemImage in OrderController: the colour the customer actually bought
// first, then the cover, then anything. A support card showing a different colourway than
// the one on the doorstep is worse than showing no photo at all.
const pickImage = (product, colorId) => {
  const images = Array.isArray(product?.images) ? sortProductImages(product.images) : [];
  if (!images.length) return '';

  const numericColorId = Number(colorId);
  const colorImages = Number.isFinite(numericColorId)
    ? images.filter((image) => Number(image.color_id) === numericColorId)
    : [];
  const coverImages = images.filter((image) => image.is_cover);
  const selected = colorImages[0] || coverImages[0] || images[0];
  return selected?.url || selected?.image_url || '';
};

// The lead item is the first one still standing: a cancelled line is not what someone is
// writing in about. If every line is cancelled it is shown anyway — a cancellation is a
// perfectly good reason to be in this conversation.
const leadItem = (items = []) => {
  const live = items.filter((item) => String(item?.status || '').toLowerCase() !== 'cancelled');
  return (live.length ? live : items)[0] || null;
};

const buildSnapshot = (order) => {
  const items = order.OrderItems || [];
  const live = items.filter((item) => String(item?.status || '').toLowerCase() !== 'cancelled');
  const shown = live.length ? live : items;
  const lead = leadItem(items);

  return {
    number: order.order_number || `#${order.id}`,
    productName: lead?.product_name || '',
    productImage: lead ? pickImage(lead.Product, lead.colorId || lead.color_id) : '',
    statusLabel: order.status || '',
    extraItems: Math.max(0, shown.length - 1),
  };
};

/**
 * Load an order and reduce it to a card.
 *
 * @param {number} orderId
 * @returns {Promise<{order: object, snapshot: object}|null>} null when the order is gone.
 */
const loadOrderCard = async (orderId) => {
  const order = await Order.findByPk(orderId, {
    include: [{
      model: OrderItem,
      include: [{ model: Product, attributes: ['id', 'images'] }],
    }],
  });
  if (!order) return null;
  return { order, snapshot: buildSnapshot(order) };
};

module.exports = { loadOrderCard, buildSnapshot };
