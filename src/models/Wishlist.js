const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");

const Wishlist = sequelize.define(
  "Wishlist",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    customerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "customers", key: "id" },
    },
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "products", key: "id" },
    },
    colorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    tableName: "wishlists",
    timestamps: true,
  }
);

const Product = require("./Product");
const Color = require("./Color");
Wishlist.belongsTo(Product, { foreignKey: "productId" });
Wishlist.belongsTo(Color, { foreignKey: "colorId" });

module.exports = Wishlist;
