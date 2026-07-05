const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const Product = require('./Product');

/**
 * Banaras Royale — curated premium showcase rendered on the home page.
 * Each entry carries a gallery of images, one video, and (optionally) one
 * linked product the shopper is sent to.
 *
 * Media conventions match the rest of the admin: images live on Cloudinary
 * (signed upload), the video goes direct-to-S3 via a pre-signed PUT.
 */
const BanarasRoyale = sequelize.define('BanarasRoyale', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // Array of Cloudinary image URLs.
  images: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  // One S3 video URL per entry.
  video: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Optional single linked product.
  product_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: Product, key: 'id' },
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  display_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  tableName: 'banaras_royale',
});

BanarasRoyale.belongsTo(Product, { foreignKey: 'product_id' });

module.exports = BanarasRoyale;
