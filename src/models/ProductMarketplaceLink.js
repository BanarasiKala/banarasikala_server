const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");
const Product = require("./Product");
const Marketplace = require("./Marketplace");

/**
 * One product's listing on one marketplace.
 *
 * A join row rather than amazon_url / flipkart_url / myntra_url columns on `products`:
 * a new channel is a row in `marketplaces`, not a migration plus edits to the model, the
 * admin form, the serialiser and the page. It also gives an indexed answer to the
 * question the storefront page asks — "every product listed on this channel" — which a
 * JSON blob on products could not without scanning the table.
 */
const ProductMarketplaceLink = sequelize.define(
  "ProductMarketplaceLink",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: Product, key: "id" },
      onDelete: "CASCADE",
    },
    marketplace_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: Marketplace, key: "id" },
      onDelete: "CASCADE",
    },
    // The deep link to this exact product on that marketplace.
    url: {
      type: DataTypes.STRING(1000),
      allowNull: false,
    },
    // Lets a single listing be pulled (out of stock there, under review) without losing
    // the URL — re-finding an ASIN months later is real work.
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    tableName: "product_marketplace_links",
    timestamps: true,
    underscored: true,
    indexes: [
      // A product is listed at most once per channel; pasting a second URL replaces the
      // first rather than quietly creating a duplicate the page would render twice.
      { unique: true, fields: ["product_id", "marketplace_id"] },
      // Drives the storefront page.
      { fields: ["marketplace_id", "is_active"] },
    ],
  },
);

Product.hasMany(ProductMarketplaceLink, { foreignKey: "product_id", onDelete: "CASCADE" });
ProductMarketplaceLink.belongsTo(Product, { foreignKey: "product_id" });
Marketplace.hasMany(ProductMarketplaceLink, { foreignKey: "marketplace_id", onDelete: "CASCADE" });
ProductMarketplaceLink.belongsTo(Marketplace, { foreignKey: "marketplace_id" });

module.exports = ProductMarketplaceLink;
