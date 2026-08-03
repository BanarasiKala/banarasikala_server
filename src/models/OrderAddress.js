const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');
const Order = require('./Order');

/**
 * order_addresses — versioned snapshot of the shipping address for an order.
 *
 * v1 is created at placement. A modify-window ADDRESS_CHANGE adds a new version
 * and flips is_current. Each shipment records which version it actually went to,
 * so history is never lost when the address changes.
 */
const OrderAddress = sequelize.define('OrderAddress', {
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
  /**
   * SHIPPING (where the parcel goes) or BILLING (who is being charged).
   *
   * An order snapshots one of each. They are the same place on an ordinary order and differ
   * when the shopper is sending to someone else — the buyer is billed at their own default
   * address, the parcel goes to the receiver's.
   *
   * ── Why the BILLING row is never `is_current` ───────────────────────────────────────────
   * Eight places across the controllers and services find an order's address with
   * `{ order_id, is_current: true }` — reverse pickups, RTO redispatch, exchanges, the
   * ShipRocket push. Every one of them means "where does this parcel physically go", and a
   * billing row surfacing in any of them would schedule a courier to the wrong door.
   *
   * Rather than add a type filter to all eight (and rely on the ninth being written
   * correctly), a BILLING row is created with is_current: false. `is_current` keeps its
   * existing meaning — the address this order currently ships to — so those queries stay
   * correct without being touched, and billing is only ever reached by asking for it.
   */
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'SHIPPING',
  },
  version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  is_current: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  /**
   * The receiver's email, snapshotted with the rest of the address.
   *
   * Snapshotted rather than read from customer_addresses at send time for the same reason
   * every other field here is: the shopper can edit or delete that saved address the day
   * after ordering, and the parcel would then be tracked by whoever the address points at
   * NOW rather than whoever it was sent to.
   *
   * Nullable — orders placed before this column existed have none, and every mail path
   * falls back to the buyer's own address when it is empty.
   */
  email: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  line: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  city: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  state: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  pincode: {
    type: DataTypes.STRING,
    allowNull: false,
  },
}, {
  tableName: 'order_addresses',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

Order.hasMany(OrderAddress, { foreignKey: 'order_id', as: 'Addresses' });
OrderAddress.belongsTo(Order, { foreignKey: 'order_id' });

module.exports = OrderAddress;
