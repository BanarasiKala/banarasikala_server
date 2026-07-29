const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * Admin-authored "seed" reviews for a product.
 *
 * These are the fallback shown on the storefront ONLY when a product has no real, approved
 * customer reviews yet — the moment a genuine review lands, it takes over and these disappear.
 * Kept in their own table (not `feedbacks`) because a real review requires a customer and a
 * delivered order; a seed review is just a name + rating + words the admin types in.
 */
const AdminReview = sequelize.define('AdminReview', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  product_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  reviewer_name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  rating: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1, max: 5 },
  },
  title: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  comment: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  images: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: [],
  },
  // Optional display date so a seed review can read as if written on a plausible day; falls
  // back to created_at on read when left blank.
  review_date: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  display_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  // Whether this seed review carries the "Verified Buyer" badge. Unlike a real feedback row
  // there is no purchase behind it, so there is nothing to derive it from — the admin decides
  // per review, and the default is off.
  is_verified: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
}, {
  tableName: 'admin_reviews',
  schema: 'vns_saree',
  timestamps: true,
  underscored: true,
});

const Product = require('./Product');
AdminReview.belongsTo(Product, { foreignKey: 'product_id', constraints: false });

module.exports = AdminReview;
