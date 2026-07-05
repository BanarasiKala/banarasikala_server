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

// ─── Orders for a specific product today (cached per product) ────────────────
const PRODUCT_ORDERS_TTL_MS = 60000;
const productOrdersCache = new Map(); // productKey -> { at, count }

const getProductOrdersToday = async (productId) => {
  const key = String(productId);
  const cached = productOrdersCache.get(key);
  if (cached && Date.now() - cached.at < PRODUCT_ORDERS_TTL_MS) return cached.count;

  // Distinct non-cancelled orders that contain this product since IST midnight.
  const count = await OrderItem.count({
    distinct: true,
    col: "order_id",
    where: { product_id: Number(productId) },
    include: [
      {
        model: Order,
        attributes: [],
        required: true,
        where: { created_at: { [Op.gte]: startOfTodayIST() }, cancelled_at: null },
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
  const base = seededRange(`vb:${productId}:${bucket(5 * 60 * 1000)}`, 22, 28); // drifts every 5 min
  const jitter = seededRange(`vj:${productId}:${bucket(12000)}`, 0, 4) - 2; // ±2, changes every ~12s
  return Math.min(30, Math.max(20, base + jitter));
};

// Synthetic "orders today": climbs 5 → 10 across the IST day and resets at
// midnight. A small per-product/per-day offset staggers the step times so all
// products don't tick up at the same moment.
const orderFloor = (productId) => {
  const dayStart = startOfTodayIST().getTime();
  const dayFraction = Math.min(0.999, Math.max(0, (Date.now() - dayStart) / (24 * 60 * 60 * 1000)));
  const dayKey = new Date(dayStart + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10);
  const offset = hashToUnit(`of:${productId}:${dayKey}`) * 0.12 - 0.06; // ±6% of the day
  const staggered = Math.min(0.999, Math.max(0, dayFraction + offset));
  return 5 + Math.floor(staggered * 6); // 5..10, monotonically increasing
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
  getProductOrdersToday,
  touchViewer,
  countViewers,
  viewerFloor,
  orderFloor,
};
