const { UniqueConstraintError } = require("sequelize");
const Wishlist = require("../models/Wishlist");
const Product = require("../models/Product");
const Color = require("../models/Color");
const { sequelize } = require("../config/db");
const { config } = require("../config/env");

// Drops Sequelize-created unique indexes (pg_indexes, not information_schema)
const dropUniqueIndexes = async () => {
  const schema = config.dbSchema || "public";
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
      console.log(`[Wishlist] Inline drop unique index: ${row.indexname}`);
    }
  } catch (err) {
    console.error("[Wishlist] dropUniqueIndexes:", err.message);
  }
};

class WishlistService {
  async getWishlist(customerId) {
    try {
      return await Wishlist.findAll({
        where: { customerId },
        include: [
          {
            model: Product,
            attributes: [
              "id", "name", "slug", "short_description",
              "selling_price", "mrp_price", "discount_percent",
              "images", "color_stocks", "stock_quantity",
              "low_stock_threshold", "status",
            ],
          },
          {
            model: Color,
            attributes: ["id", "name", "hex_code", "slug"],
            required: false,
          },
        ],
      });
    } catch {
      return await Wishlist.findAll({
        where: { customerId },
        include: [
          {
            model: Product,
            attributes: [
              "id", "name", "slug", "short_description",
              "selling_price", "mrp_price", "discount_percent",
              "images", "color_stocks", "stock_quantity",
              "low_stock_threshold", "status",
            ],
          },
        ],
      });
    }
  }

  async toggleWishlist(customerId, productId, colorId) {
    const pId = parseInt(productId, 10);
    const cId = colorId ? parseInt(colorId, 10) : null;
    if (isNaN(pId)) throw new Error("Invalid Product ID");

    let existing;
    try {
      const where = { customerId, productId: pId };
      if (cId !== null) where.colorId = cId;
      else where.colorId = null;
      existing = await Wishlist.findOne({ where });
    } catch {
      existing = await Wishlist.findOne({ where: { customerId, productId: pId } });
    }

    if (existing) {
      await existing.destroy();
      return { added: false };
    }

    try {
      await Wishlist.create({ customerId, productId: pId, colorId: cId });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        // Old unique index still present — drop it then retry
        await dropUniqueIndexes();
        await Wishlist.create({ customerId, productId: pId, colorId: cId });
      } else {
        throw err;
      }
    }

    return { added: true };
  }

  async removeById(customerId, wishlistId) {
    return await Wishlist.destroy({
      where: { id: wishlistId, customerId },
    });
  }
}

module.exports = new WishlistService();
