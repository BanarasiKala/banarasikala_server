const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// A customer comment on a reel. Hidden until an admin approves it (mirrors the
// Feedback moderation flow).
const ReelComment = sequelize.define('ReelComment', {
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
  comment: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  is_approved: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
}, {
  tableName: 'reel_comments',
  schema: 'vns_saree',
  timestamps: true,
  underscored: true,
});

const Reel = require('./Reel');
const Customer = require('./Customer');
Reel.hasMany(ReelComment, { foreignKey: 'reel_id', onDelete: 'CASCADE' });
ReelComment.belongsTo(Reel, { foreignKey: 'reel_id' });
ReelComment.belongsTo(Customer, { foreignKey: 'customer_id' });

module.exports = ReelComment;
