const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");

const Cart = sequelize.define(
  "Cart",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    customerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "customers",
        key: "id",
      },
    },
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "products",
        key: "id",
      },
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    colorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: "colors",
        key: "id",
      },
    },
  },
  {
    tableName: "carts",
    timestamps: true,
  }
);

const Product = require("./Product");
const Color = require("./Color");
Cart.belongsTo(Product, { foreignKey: "productId" });
Cart.belongsTo(Color, { foreignKey: "colorId" });
module.exports = Cart;
