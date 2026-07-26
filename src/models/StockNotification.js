const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * A customer's request to be emailed when an out-of-stock product is available again.
 *
 * One PENDING row per customer+product (notified_at IS NULL). When the admin sends the restock
 * mail, notified_at is stamped so the same person is never emailed twice for the same wait — and
 * if the product sells out again, a fresh pending row is created the next time they ask.
 */
const StockNotification = sequelize.define('StockNotification', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  product_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  customer_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Which colour they were looking at, if any — informational; the notification is per product.
  color_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  // Null = still waiting; a timestamp = the restock email has been sent.
  notified_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'stock_notifications',
  schema: 'vns_saree',
  timestamps: true,
  underscored: true,
});

const Product = require('./Product');
StockNotification.belongsTo(Product, { foreignKey: 'product_id', constraints: false });

module.exports = StockNotification;
