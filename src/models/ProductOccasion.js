const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");
const Product = require("./Product");
const Occasion = require("./Occasion");

const ProductOccasion = sequelize.define(
  "ProductOccasion",
  {
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: Product, key: "id" },
    },
    occasion_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: Occasion, key: "id" },
    },
  },
  {
    tableName: "product_occasions",
    timestamps: false,
  }
);

Product.belongsToMany(Occasion, {
  through: ProductOccasion,
  foreignKey: "product_id",
  otherKey: "occasion_id",
});

Occasion.belongsToMany(Product, {
  through: ProductOccasion,
  foreignKey: "occasion_id",
  otherKey: "product_id",
});

module.exports = ProductOccasion;
