const express = require("express");
const router = express.Router();
const WishlistController = require("../controllers/WishlistController");
const { authMiddleware } = require("../middleware/authMiddleware");
const { sequelize } = require("../config/db");
const { config } = require("../config/env");

const migrate = async () => {
  const schema = config.dbSchema || "public";

  // 1. Add colorId column if missing
  try {
    await sequelize.query(
      `ALTER TABLE "${schema}"."wishlists" ADD COLUMN IF NOT EXISTS "colorId" INTEGER`
    );
    console.log("[Wishlist] colorId column ensured.");
  } catch (err) {
    console.error("[Wishlist] colorId column:", err.message);
  }

  // 2. Drop the Sequelize-created unique INDEX on (customerId, productId)
  //    Sequelize uses CREATE UNIQUE INDEX, NOT ADD CONSTRAINT, so we must
  //    query pg_indexes (not information_schema) and use DROP INDEX.
  try {
    const [rows] = await sequelize.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = '${schema}'
        AND tablename  = 'wishlists'
        AND indexdef LIKE '%UNIQUE%'
        AND indexname  NOT LIKE '%pkey%'
    `);

    for (const row of rows) {
      await sequelize.query(
        `DROP INDEX IF EXISTS "${schema}"."${row.indexname}"`
      );
      console.log(`[Wishlist] Dropped unique index: ${row.indexname}`);
    }

    if (rows.length === 0) {
      console.log("[Wishlist] No unique indexes to drop.");
    }
  } catch (err) {
    console.error("[Wishlist] Index drop migration:", err.message);
  }
};

migrate();

router.use(authMiddleware);

router.get("/", WishlistController.getWishlist);
router.post("/toggle", WishlistController.toggleWishlist);
router.delete("/:id", WishlistController.removeFromWishlist);

module.exports = router;
