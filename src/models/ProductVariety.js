const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");
const Product = require("./Product");
const Variety = require("./Variety");

/**
 * product_varieties — a product can be woven in more than one variety (Katan + Kadwa), and a
 * variety spans many products. This join table is that many-to-many.
 *
 * Modelled deliberately on ProductOccasion, which already does exactly this for occasions —
 * same composite primary key, same timestamps:false, same pair of belongsToMany. Occasions
 * is the proof the pattern works end to end here; this is it applied to a second attribute.
 *
 * The old `products.variety_id` column is left in place for now as a fallback, but it is no
 * longer the source of truth — the associations below are. It can be dropped once nothing
 * reads it.
 */
const ProductVariety = sequelize.define(
  "ProductVariety",
  {
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: Product, key: "id" },
    },
    variety_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: Variety, key: "id" },
    },
  },
  {
    tableName: "product_varieties",
    timestamps: false,
  },
);

Product.belongsToMany(Variety, {
  through: ProductVariety,
  foreignKey: "product_id",
  otherKey: "variety_id",
});

Variety.belongsToMany(Product, {
  through: ProductVariety,
  foreignKey: "variety_id",
  otherKey: "product_id",
});

module.exports = ProductVariety;
