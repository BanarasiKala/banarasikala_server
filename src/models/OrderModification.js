const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');

/**
 * order_modifications — audit of changes made in the modify window
 * (now < dispatch_deadline AND no forward shipment yet).
 *
 * triggered_recalculation = true when the change produced order_ledger entries
 * (prepaid qty change/refund). For COD it is typically false — items change but
 * money is only collected at delivery.
 */
const OrderModification = sequelize.define('OrderModification', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  order_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: Order, key: 'id' },
  },
  // QTY_CHANGE | ITEM_REMOVED | ITEM_ADDED | ADDRESS_CHANGE
  type: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  before_json: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  after_json: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  triggered_recalculation: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // CUSTOMER | ADMIN | SYSTEM
  actor: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'CUSTOMER',
  },
}, {
  tableName: 'order_modifications',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(OrderModification, { foreignKey: 'order_id', as: 'Modifications' });
OrderModification.belongsTo(Order, { foreignKey: 'order_id' });

module.exports = OrderModification;
