const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const { config } = require("./config/env");
const requestLogger = require("./middleware/requestLogger");
const errorHandler = require("./middleware/errorHandler");

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

const app = express();

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
app.use(express.json({ limit: "1536mb" }));
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

app.use((req, res) => {
  res.status(404).json({ message: "API route not found" });
});

app.use(errorHandler);

module.exports = app;
