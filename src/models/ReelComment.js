const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// A customer comment on a reel. Published the moment it is written — the only gate is
// being logged in. Admins moderate after the fact by deleting, from the Reels → Comments
// tab. (This used to sit behind an `is_approved` flag that an admin had to flip, which
// meant a comment written now appeared some time later, to a reader who had long since
// scrolled on. Nobody talks to a thread like that.)
//
// Threading is one level deep, like Instagram: a comment either starts a thread
// (parent_id null) or replies inside one. Replying to a reply re-points at the thread's
// root — see normalizeParent in ReelService — so a thread can never nest further than
// comment → reply, and the list stays readable on a phone.
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
  // Null for a top-level comment; the thread root's id for a reply. CASCADE so deleting
  // a comment takes its replies with it — a reply to nothing is noise.
  parent_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: { tableName: 'reel_comments', schema: 'vns_saree' },
      key: 'id',
    },
    onDelete: 'CASCADE',
  },
  comment: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
}, {
  tableName: 'reel_comments',
  schema: 'vns_saree',
  timestamps: true,
  underscored: true,
  indexes: [
    // Every read is "this reel's thread roots" or "this thread's replies".
    { fields: ['reel_id', 'parent_id'] },
  ],
});

const Reel = require('./Reel');
const Customer = require('./Customer');
Reel.hasMany(ReelComment, { foreignKey: 'reel_id', onDelete: 'CASCADE' });
ReelComment.belongsTo(Reel, { foreignKey: 'reel_id' });
ReelComment.belongsTo(Customer, { foreignKey: 'customer_id' });
// Self-association for the one level of threading.
ReelComment.hasMany(ReelComment, { as: 'replies', foreignKey: 'parent_id', onDelete: 'CASCADE' });
ReelComment.belongsTo(ReelComment, { as: 'parent', foreignKey: 'parent_id' });

module.exports = ReelComment;
