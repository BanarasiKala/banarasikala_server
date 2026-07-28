const express = require("express");
const router = express.Router();
const MarketplaceController = require("../controllers/MarketplaceController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");

const admin = [authMiddleware, adminMiddleware];

// ─── Admin (static paths first so they don't collide with /:slug) ────────────
router.get("/admin/all", ...admin, MarketplaceController.adminList);
router.post("/admin", ...admin, MarketplaceController.create);
router.put("/admin/:id", ...admin, MarketplaceController.update);
router.delete("/admin/:id", ...admin, MarketplaceController.remove);
// Search products to attach, each with its current link on this channel.
router.get("/admin/:id/products", ...admin, MarketplaceController.pickerProducts);
// Attach a batch of product/URL pairs against one channel.
router.post("/admin/:id/bulk", ...admin, MarketplaceController.bulkAttach);
// A single product's links, for the product modal.
router.get("/admin/product/:productId/links", ...admin, MarketplaceController.productLinks);
router.put("/admin/product/:productId/links", ...admin, MarketplaceController.saveProductLinks);

// ─── Public ──────────────────────────────────────────────────────────────────
router.get("/", MarketplaceController.list);
// Two segments, so it cannot be swallowed by the one-segment /:slug below.
router.get("/product/:productId", MarketplaceController.linksForProduct);
router.get("/:slug", MarketplaceController.getPage);

module.exports = router;
