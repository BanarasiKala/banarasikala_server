const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const NewsletterSubscriber = sequelize.define('NewsletterSubscriber', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: false,
    unique: true,
    validate: { isEmail: true },
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: 'newsletter_subscribers',
  schema: 'vns_saree',
  timestamps: true,
  underscored: true,
});

module.exports = NewsletterSubscriber;
