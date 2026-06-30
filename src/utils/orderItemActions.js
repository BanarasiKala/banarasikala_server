const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');

const ACTION_TYPES = Object.freeze({
  CANCEL: 'cancel',
  RETURN: 'return',
  EXCHANGE: 'exchange',
});

const ACTION_STATUS = Object.freeze({
  INITIATED: 'Initiated',
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
});

const ITEM_STATUS = Object.freeze({
  ACTIVE: 'Active',
  CANCEL_REQUESTED: 'Cancel Requested',
  PARTIALLY_CANCELLED: 'Partially Cancelled',
  CANCELLED: 'Cancelled',
  RETURN_REQUESTED: 'Return Initiated',
  PARTIALLY_RETURNED: 'Partially Returned',
  RETURN_COMPLETED: 'Return Completed',
  EXCHANGE_REQUESTED: 'Exchange Initiated',
  PARTIALLY_EXCHANGED: 'Partially Exchanged',
  EXCHANGE_COMPLETED: 'Exchange Completed',
});

const ORDER_ITEM_ACTION_COLUMNS = {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  order_id: { type: DataTypes.INTEGER, allowNull: false },
  order_item_id: { type: DataTypes.INTEGER, allowNull: false },
  product_id: { type: DataTypes.INTEGER, allowNull: true },
  action_type: { type: DataTypes.STRING, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  status: { type: DataTypes.STRING, allowNull: false, defaultValue: ACTION_STATUS.REQUESTED },
  reason: { type: DataTypes.TEXT, allowNull: true },
  item_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  forward_shipping_deduction: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  reverse_shipping_deduction: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  estimated_refund_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  meta: { type: DataTypes.JSONB, allowNull: true },
  requested_by: { type: DataTypes.INTEGER, allowNull: true },
  reviewed_by: { type: DataTypes.INTEGER, allowNull: true },
  reviewed_at: { type: DataTypes.DATE, allowNull: true },
  completed_at: { type: DataTypes.DATE, allowNull: true },
  shiprocket_return_order_id: { type: DataTypes.STRING, allowNull: true },
  shiprocket_return_awb: { type: DataTypes.STRING, allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
};

// V2: the rollup counters were dropped from order_items (now derived from
// shipment_items / return_items). Empty so the schema check no longer
// resurrects them. Kept as a named export for backward compatibility.
const ORDER_ITEM_ACTION_QUANTITY_COLUMNS = {};

let schemaReady = false;

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const ensureOrderItemActionSchema = async () => {
  if (schemaReady) return;
  const queryInterface = sequelize.getQueryInterface();
  const actionTable = { tableName: 'order_item_actions', schema: config.dbSchema };
  const itemTable = { tableName: 'order_items', schema: config.dbSchema };

  try {
    await queryInterface.describeTable(actionTable);
  } catch {
    await queryInterface.createTable(actionTable, ORDER_ITEM_ACTION_COLUMNS);
  }

  let actionColumns = await queryInterface.describeTable(actionTable);
  for (const [column, definition] of Object.entries(ORDER_ITEM_ACTION_COLUMNS)) {
    if (!actionColumns[column]) {
      await queryInterface.addColumn(actionTable, column, definition);
    }
  }

  let itemColumns = await queryInterface.describeTable(itemTable);
  for (const [column, definition] of Object.entries(ORDER_ITEM_ACTION_QUANTITY_COLUMNS)) {
    if (!itemColumns[column]) {
      await queryInterface.addColumn(itemTable, column, definition);
    }
  }

  schemaReady = true;
};

const normalizeActionType = (value) => {
  const next = String(value || '').trim().toLowerCase();
  if (!Object.values(ACTION_TYPES).includes(next)) return null;
  return next;
};

// V2: the per-item rollup counters were dropped from order_items. Actioned
// quantity is now derived from the item's own action rows (passed in). With no
// actions, the full quantity is still available.
const REVERSE_CLOSED = ['rejected', 'cancelled'];
const getActionableQuantity = (item, actions = []) => {
  const quantity = Math.max(0, Number(item?.quantity || 0));
  const used = (Array.isArray(actions) ? actions : [])
    .filter((a) => Number(a.order_item_id) === Number(item?.id)
      && !REVERSE_CLOSED.includes(String(a.status || '').toLowerCase()))
    .reduce((sum, a) => sum + Number(a.quantity || 0), 0);
  return Math.max(0, quantity - used);
};

// Forward delivery deduction comes from the item's own shipping snapshot.
const getForwardDeduction = (item) => {
  const rules = item?.shipping_meta?.refund_rules || {};
  return roundMoney(rules.return_delivery_deduction ?? item?.shipping_meta?.delivery_charge ?? 0);
};

// Reverse (pickup) shipping is now passed in by the caller, sourced from the
// forward shipment's rate card rather than the (dropped) order columns.
const calculateItemAction = ({ item, actionType, quantity, reverseShippingCharge = 0 }) => {
  const qty = Math.max(1, Number(quantity || 1));
  const itemAmount = roundMoney(Number(item.price || 0) * qty);
  const forwardDeduction = actionType === ACTION_TYPES.RETURN ? getForwardDeduction(item) : 0;
  const reverseDeduction = actionType === ACTION_TYPES.RETURN ? roundMoney(reverseShippingCharge) : 0;
  const estimatedRefund = actionType === ACTION_TYPES.RETURN
    ? Math.max(0, roundMoney(itemAmount - forwardDeduction - reverseDeduction))
    : actionType === ACTION_TYPES.CANCEL
      ? itemAmount
      : 0;

  return {
    item_amount: itemAmount,
    forward_shipping_deduction: roundMoney(forwardDeduction),
    reverse_shipping_deduction: roundMoney(reverseDeduction),
    estimated_refund_amount: roundMoney(estimatedRefund),
  };
};

const statusForRequestedAction = (actionType) => {
  if (actionType === ACTION_TYPES.CANCEL) return ITEM_STATUS.CANCEL_REQUESTED;
  if (actionType === ACTION_TYPES.RETURN) return ITEM_STATUS.RETURN_REQUESTED;
  return ITEM_STATUS.EXCHANGE_REQUESTED;
};

// fullyActioned: whether the completed quantity now covers the whole line
// (derived by the caller from the item's action rows).
const statusAfterCompletedAction = (actionType, fullyActioned) => {
  if (actionType === ACTION_TYPES.CANCEL) {
    return fullyActioned ? ITEM_STATUS.CANCELLED : ITEM_STATUS.PARTIALLY_CANCELLED;
  }
  if (actionType === ACTION_TYPES.RETURN) {
    return fullyActioned ? ITEM_STATUS.RETURN_COMPLETED : ITEM_STATUS.PARTIALLY_RETURNED;
  }
  return fullyActioned ? ITEM_STATUS.EXCHANGE_COMPLETED : ITEM_STATUS.PARTIALLY_EXCHANGED;
};

const isDeliveredEnoughForPostDeliveryAction = (order) => {
  const status = String(order?.status || '').toLowerCase();
  return Boolean(order?.delivered_at) || status === 'delivered';
};

// V2: status history is written to the order_status_history table, not a JSONB
// column — appendOrderStatusHistory was removed.

module.exports = {
  ACTION_TYPES,
  ACTION_STATUS,
  ITEM_STATUS,
  ensureOrderItemActionSchema,
  normalizeActionType,
  getActionableQuantity,
  calculateItemAction,
  statusForRequestedAction,
  statusAfterCompletedAction,
  isDeliveredEnoughForPostDeliveryAction,
  roundMoney,
};
