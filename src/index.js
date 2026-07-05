const path = require("path");
const fs = require("fs/promises");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const { config } = require("./config/env");
const requestLogger = require("./middleware/requestLogger");
const errorHandler = require("./middleware/errorHandler");
const ProductService = require("./services/ProductService");

const VarietyRoutes = require("./routes/VarietyRoutes");
const ColorRoutes = require("./routes/ColorRoutes");
const MaterialRoutes = require("./routes/MaterialRoutes");
const OccasionRoutes = require("./routes/OccasionRoutes");
const CouponRoutes = require("./routes/CouponRoutes");
const ProductRoutes = require("./routes/ProductRoutes");
const OrderRoutes = require("./routes/OrderRoutes");
const RazorpayRoutes = require("./routes/RazorpayRoutes");
const AuthRoutes = require("./routes/AuthRoutes");
const CartRoutes = require("./routes/CartRoutes");
const WishlistRoutes = require("./routes/WishlistRoutes");
const FeedbackRoutes = require("./routes/FeedbackRoutes");
const ShipRocketRoutes = require("./routes/ShipRocketRoutes");
const WalletRoutes = require("./routes/WalletRoutes");
const ReferralRoutes = require("./routes/ReferralRoutes");
const CustomerRoutes = require("./routes/CustomerRoutes");
const CustomerAddressRoutes = require("./routes/CustomerAddressRoutes");
const ContactRoutes = require("./routes/ContactRoutes");
const NewsletterRoutes = require("./routes/NewsletterRoutes");
const ChatBotRoutes = require("./routes/ChatBotRoutes");
const ReelRoutes = require("./routes/ReelRoutes");
const StatsRoutes = require("./routes/StatsRoutes");
const BanarasRoyaleRoutes = require("./routes/BanarasRoyaleRoutes");

const app = express();

const clientDistPath = path.resolve(__dirname, "..", "..", "banarasikala_client", "dist");
const clientIndexHtmlPath = path.join(clientDistPath, "index.html");
let clientIndexHtml = null;

const loadClientIndexHtml = async () => {
  try {
    clientIndexHtml = await fs.readFile(clientIndexHtmlPath, "utf8");
  } catch (error) {
    console.warn(`[Server] Could not load client index.html from ${clientIndexHtmlPath}: ${error.message}`);
    clientIndexHtml = null;
  }
};

const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
const stripHtml = (value) => normalizeText(String(value || "").replace(/<[^>]*>/g, " "));
const truncateText = (value, maxLength = 180) => {
  const text = stripHtml(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
};
const escapeHtml = (value) => String(value || "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const metaKeys = [
  "description",
  "og:title",
  "og:description",
  "og:image",
  "og:image:secure_url",
  "og:image:alt",
  "og:url",
  "og:type",
  "og:site_name",
  "twitter:card",
  "twitter:title",
  "twitter:description",
  "twitter:image",
  "twitter:image:alt",
  "product:price:amount",
  "product:price:currency",
];

const removeExistingMeta = (html) => metaKeys.reduce(
  (current, key) => current.replace(
    new RegExp(`\\s*<meta\\s+(?:name|property)=["']${key}["'][^>]*>`, "gi"),
    "",
  ),
  html,
).replace(/\s*<link\s+rel=["']canonical["'][^>]*>/gi, "");

const getProductImages = (product = {}) => {
  return [...(product.images || []), ...(product.productImages || [])]
    .map((image) => (typeof image === "string" ? { url: image } : image))
    .filter((image) => image?.url)
    .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0));
};

const getProductShareImage = (product = {}) => {
  const images = getProductImages(product);
  return (images.find((image) => image.is_cover) || images[0])?.url
    || product.image_url
    || product.image
    || "/logo_transparent_2.png";
};

const toAbsoluteUrl = (url, pageUrl) => {
  try {
    return new URL(url || "/logo_transparent_2.png", new URL(pageUrl).origin).href;
  } catch {
    return url || "/logo_transparent_2.png";
  }
};

const renderProductHtml = (product, pageUrl) => {
  if (!clientIndexHtml) return null;
  const productName = normalizeText(product.name || "Banarasi Kala");
  const title = productName === "Banarasi Kala" ? productName : `${productName} | Banarasi Kala`;
  const description = truncateText(product.short_description || product.description || "Shop authentic Banarasi sarees, handwoven silk, and premium accessories from Banarasi Kala.");
  const imageUrl = toAbsoluteUrl(getProductShareImage(product), pageUrl);
  const price = Number(product.selling_price || product.price || 0);

  const metaTags = `
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}" />
    <meta property="og:image:alt" content="${escapeHtml(productName)}" />
    <meta property="og:url" content="${escapeHtml(pageUrl)}" />
    <meta property="og:type" content="product" />
    <meta property="og:site_name" content="Banarasi Kala" />
    ${price > 0 ? `<meta property="product:price:amount" content="${escapeHtml(price.toFixed(2))}" />` : ""}
    ${price > 0 ? '<meta property="product:price:currency" content="INR" />' : ""}
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
    <meta name="twitter:image:alt" content="${escapeHtml(productName)}" />
    <link rel="canonical" href="${escapeHtml(pageUrl)}" />
  `;

  const html = removeExistingMeta(clientIndexHtml);
  if (/<title>.*?<\/title>/i.test(html)) {
    return html.replace(/<title>.*?<\/title>/i, `<title>${escapeHtml(title)}</title>${metaTags}`);
  }
  return html.replace(/<\/head>/i, `<title>${escapeHtml(title)}</title>${metaTags}</head>`);
};

loadClientIndexHtml();

app.use(helmet());
app.use(compression());
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);
// verify() keeps the raw body bytes — required to check Razorpay's webhook
// HMAC signature, which is computed over the exact payload as sent.
app.use(express.json({
  limit: "1536mb",
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ limit: "1536mb", extended: true }));
app.use(requestLogger);

app.get("/", (req, res) => {
  res.json({
    name: "VNS Saree API",
    status: "ok",
    environment: config.nodeEnv,
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Authentication APIs.
// Public: customer register/login, admin login, password reset, token refresh.
app.use("/api/auth", AuthRoutes);

// Catalog APIs.
// Public: read endpoints used by the customer storefront.
// Admin: create/update/delete endpoints inside these routers require admin auth.
app.use("/api/products", ProductRoutes);
app.use("/api/varieties", VarietyRoutes);
app.use("/api/colors", ColorRoutes);
app.use("/api/materials", MaterialRoutes);
app.use("/api/occasions", OccasionRoutes);
app.use("/api/coupons", CouponRoutes);
app.use("/api/royale", BanarasRoyaleRoutes);

// Feedback APIs.
// Public: approved feedback list. Customer: submit feedback. Admin: moderation.
app.use("/api/feedback", FeedbackRoutes);

// Checkout APIs.
// Public from the backend perspective; checkout pages control customer access in the frontend.
app.use("/api/razorpay", RazorpayRoutes);
app.use("/api/orders", OrderRoutes);

// Shipping APIs (admin-initiated).
app.use("/api/shiprocket", ShipRocketRoutes);

// Safe Webhook endpoint for ShipRocket status updates (does not contain restricted keywords)
const ShipRocketController = require("./controllers/ShipRocketController");
app.post("/api/delivery-updates/callback", ShipRocketController.webhook);

// Customer account APIs. Route files enforce customer authentication.
app.use("/api/cart", CartRoutes);
app.use("/api/wishlist", WishlistRoutes);
app.use("/api/wallet", WalletRoutes);
app.use("/api/referral", ReferralRoutes);
app.use("/api/customers", CustomerRoutes);
app.use("/api/addresses", CustomerAddressRoutes);

// Contact form — public, no auth required
app.use("/api/contact", ContactRoutes);

// Newsletter subscription — public subscribe, admin list
app.use("/api/newsletter", NewsletterRoutes);

// ChatBot — public, no auth required
app.use("/api/chatbot", ChatBotRoutes);

// Reels — public feed (view/share no login; like/comment require login).
// Admin endpoints for upload/CRUD and comment moderation live under /admin.
app.use("/api/reels", ReelRoutes);

// Social-proof stats — public (orders today, live product viewers).
app.use("/api/stats", StatsRoutes);

app.get("/product/:slug", async (req, res, next) => {
  try {
    const colorId = req.query.color || null;
    const product = await ProductService.getProductDetailBySlug(req.params.slug, colorId);
    if (!product) return next();

    const scheme = req.headers["x-forwarded-proto"]?.split(",")[0] || req.protocol;
    const pageUrl = `${scheme}://${req.get("host")}${req.originalUrl}`;
    const html = renderProductHtml(product, pageUrl);
    if (html) {
      return res.type("html").send(html);
    }
    return next();
  } catch (error) {
    console.error("[Server] Product share route error:", error);
    return next(error);
  }
});

app.use(express.static(clientDistPath, { index: false }));

app.get("*", (req, res) => {
  if (clientIndexHtml && req.method === "GET") {
    return res.type("html").send(clientIndexHtml);
  }
  return res.status(404).json({ message: "API route not found" });
});

app.use(errorHandler);

module.exports = app;
