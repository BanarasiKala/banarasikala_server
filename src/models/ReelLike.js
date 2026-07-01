const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// One row per (reel, customer) like. The unique index enforces a single like per
// customer; Reel.like_count is the denormalized total for fast feed reads.
const ReelLike = sequelize.define('ReelLike', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  reel_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: { tableName: 'reels', schema: 'vns_saree' },
      key: 'id',
    },
    onDelete: 'CASCADE',
  },
  customer_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: { tableName: 'customers', schema: 'vns_saree' },
      key: 'id',
    },
  },
}, {
  tableName: 'reel_likes',
  schema: 'vns_saree',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['reel_id', 'customer_id'] },
  ],
});

const Reel = require('./Reel');
Reel.hasMany(ReelLike, { foreignKey: 'reel_id', onDelete: 'CASCADE' });
ReelLike.belongsTo(Reel, { foreignKey: 'reel_id' });

module.exports = ReelLike;
