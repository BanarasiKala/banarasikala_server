const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// A short shoppable video ("reel"). Intentionally decoupled from the catalog:
// featured products are stored as an array of product ids (no FK constraints),
// so a reel can reference any number of products without being tied to the
// Product model's lifecycle.
const Reel = sequelize.define('Reel', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  title: {
    type: DataTypes.STRING(200),
    allowNull: true,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  video_url: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  // Optional poster/thumbnail image shown before the video plays.
  thumbnail_url: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // Featured product ids, e.g. [12, 45]. Products are resolved at read time.
  product_ids: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  // Denormalized counters kept in sync on like/view for cheap feed reads.
  like_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  view_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  // Lower numbers surface first; ties broken by newest.
  display_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  is_published: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
}, {
  tableName: 'reels',
  schema: 'vns_saree',
  timestamps: true,
  underscored: true,
});

module.exports = Reel;
