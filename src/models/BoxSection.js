const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * Box Section — admin-curated mosaic block rendered on the home page.
 * Each entry carries a title/description plus MULTIPLE images and MULTIPLE
 * videos, shown as a bento grid of media boxes.
 *
 * Media conventions match the rest of the admin: images live on Cloudinary
 * (signed upload), videos go direct-to-S3 via pre-signed PUTs.
 */
const BoxSection = sequelize.define('BoxSection', {
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
  // Array of S3 video URLs.
  videos: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
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
  tableName: 'box_sections',
});

module.exports = BoxSection;
