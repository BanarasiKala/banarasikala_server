const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Feedback = sequelize.define('Feedback', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  customer_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: {
        tableName: 'customers',
        schema: 'vns_saree'
      },
      key: 'id'
    }
  },
  order_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  order_item_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  product_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  rating: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      min: 1,
      max: 5
    }
  },
  comment: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  title: {
    type: DataTypes.STRING,
    allowNull: true
  },
  images: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: []
  },
  is_approved: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  tableName: 'feedbacks',
  schema: 'vns_saree',
  timestamps: true,
  underscored: true
});

// Associations
const Customer = require('./Customer');
const Product = require('./Product');
const Order = require('./Order');
const OrderItem = require('./OrderItem');
Feedback.belongsTo(Customer, { foreignKey: 'customer_id' });
Feedback.belongsTo(Product, { foreignKey: 'product_id', constraints: false });
Feedback.belongsTo(Order, { foreignKey: 'order_id', constraints: false });
Feedback.belongsTo(OrderItem, { foreignKey: 'order_item_id', constraints: false });

module.exports = Feedback;
