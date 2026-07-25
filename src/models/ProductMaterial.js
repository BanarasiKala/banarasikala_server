const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");
const Product = require("./Product");
const Material = require("./Material");

/**
 * product_materials — a saree is often a blend (Silk + Zari, Satin + Silk), and a material
 * spans many products. This join table is that many-to-many.
 *
 * Mirrors ProductOccasion / ProductVariety exactly. The old `products.material_id` column
 * stays as a fallback but is no longer authoritative; the association below is.
 */
const ProductMaterial = sequelize.define(
  "ProductMaterial",
  {
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: Product, key: "id" },
    },
    material_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: Material, key: "id" },
    },
  },
  {
    tableName: "product_materials",
    timestamps: false,
  },
);

Product.belongsToMany(Material, {
  through: ProductMaterial,
  foreignKey: "product_id",
  otherKey: "material_id",
});

Material.belongsToMany(Product, {
  through: ProductMaterial,
  foreignKey: "material_id",
  otherKey: "product_id",
});

module.exports = ProductMaterial;
