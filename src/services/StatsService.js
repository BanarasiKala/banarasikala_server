const { Op } = require("sequelize");
const Order = require("../models/Order");
const OrderItem = require("../models/OrderItem");

// Store operates in IST; "today" means since IST midnight.
const IST_OFFSET_MIN = 330;
const startOfTodayIST = () => {
  const istNow = new Date(Date.now() + IST_OFFSET_MIN * 60000);
  istNow.setUTCHours(0, 0, 0, 0);
  return new Date(istNow.getTime() - IST_OFFSET_MIN * 60000);
};

// ─── Orders placed today (site-wide, cached) ─────────────────────────────────
const ORDERS_TTL_MS = 60000;
let ordersCache = { at: 0, count: 0 };

const getOrdersToday = async () => {
  if (Date.now() - ordersCache.at < ORDERS_TTL_MS) return ordersCache.count;
  const count = await Order.count({
    where: { created_at: { [Op.gte]: startOfTodayIST() }, cancelled_at: null },
  });
  ordersCache = { at: Date.now(), count };
  return count;
};

// ─── Orders for a specific product in the last hour (cached per product) ─────
const PRODUCT_ORDER_WINDOW_MS = 60 * 60 * 1000; // rolling 1 hour
const PRODUCT_ORDERS_TTL_MS = 60000;
const productOrdersCache = new Map(); // productKey -> { at, count }

const getProductOrdersRecent = async (productId) => {
  const key = String(productId);
  const cached = productOrdersCache.get(key);
  if (cached && Date.now() - cached.at < PRODUCT_ORDERS_TTL_MS) return cached.count;

  const since = new Date(Date.now() - PRODUCT_ORDER_WINDOW_MS);
  // Distinct non-cancelled orders that contain this product within the window.
  const count = await OrderItem.count({
    distinct: true,
    col: "order_id",
    where: { product_id: Number(productId) },
    include: [
      {
        model: Order,
        attributes: [],
        required: true,
        where: { created_at: { [Op.gte]: since }, cancelled_at: null },
      },
    ],
  });

  productOrdersCache.set(key, { at: Date.now(), count });
  return count;
};

// ─── Social-proof floors ─────────────────────────────────────────────────────
// When the real number is low, show a plausible figure instead. Seeded by the
// product + a time bucket so every visitor sees the SAME value and it stays
// stable for a few minutes (rather than jumping on each 15s heartbeat).
const hashToUnit = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000000) / 1000000;
};
const seededRange = (seed, min, max) => min + Math.floor(hashToUnit(seed) * (max - min + 1));

// A slowly-drifting base plus a small jitter on a shorter cycle, so the number
// fluctuates gently (feels live) instead of being frozen for minutes.
const bucket = (ms) => Math.floor(Date.now() / ms);

const viewerFloor = (productId) => {
  const base = seededRange(`vb:${productId}:${bucket(5 * 60 * 1000)}`, 112, 188); // drifts every 5 min
  const jitter = seededRange(`vj:${productId}:${bucket(12000)}`, 0, 16) - 8; // ±8, changes every ~12s
  return Math.min(200, Math.max(100, base + jitter));
};

const orderFloor = (productId) => {
  const base = seededRange(`ob:${productId}:${bucket(15 * 60 * 1000)}`, 56, 92); // drifts every 15 min
  const jitter = seededRange(`oj:${productId}:${bucket(30000)}`, 0, 8) - 4; // ±4, changes every ~30s
  return Math.min(100, Math.max(50, base + jitter));
};

// ─── Live product viewers (in-memory presence) ───────────────────────────────
// A viewer is "present" if their heartbeat arrived within WINDOW_MS. Works on a
// single instance (no Redis); heartbeats come from the product page every ~15s.
const WINDOW_MS = 30000;
const presence = new Map(); // productKey -> Map<sessionId, lastSeenMs>

const pruneProduct = (sessions) => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [sid, seen] of sessions) {
    if (seen < cutoff) sessions.delete(sid);
  }
  return sessions.size;
};

const countViewers = (productId) => {
  const sessions = presence.get(String(productId));
  if (!sessions) return 0;
  const size = pruneProduct(sessions);
  if (size === 0) presence.delete(String(productId));
  return size;
};

const touchViewer = (productId, sessionId) => {
  const key = String(productId);
  let sessions = presence.get(key);
  if (!sessions) {
    sessions = new Map();
    presence.set(key, sessions);
  }
  sessions.set(sessionId, Date.now());
  return pruneProduct(sessions);
};

// Bound memory: sweep stale sessions periodically. unref() so it never keeps the
// process alive on shutdown.
const sweep = setInterval(() => {
  for (const [key, sessions] of presence) {
    if (pruneProduct(sessions) === 0) presence.delete(key);
  }
}, 60000);
if (sweep.unref) sweep.unref();

module.exports = {
  getOrdersToday,
  getProductOrdersRecent,
  touchViewer,
  countViewers,
  viewerFloor,
  orderFloor,
};
