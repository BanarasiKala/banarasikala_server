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

const ORDER_ITEM_ACTION_QUANTITY_COLUMNS = {
  cancelled_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  returned_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  exchanged_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  pending_action_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
};

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

const getActionableQuantity = (item) => {
  const quantity = Math.max(0, Number(item?.quantity || 0));
  const used = Number(item?.cancelled_quantity || 0)
    + Number(item?.returned_quantity || 0)
    + Number(item?.exchanged_quantity || 0)
    + Number(item?.pending_action_quantity || 0);
  return Math.max(0, quantity - used);
};

const getCourierCharge = (order) => {
  const courier = order?.selected_courier_data || {};
  const candidates = [
    courier.freight_charge,
    courier.rate,
    courier.shipping_charge,
    courier.delivery_charge,
    courier.charge,
    order?.shipping_charge,
  ];
  return roundMoney(candidates.find((value) => Number(value) > 0) || 0);
};

const getForwardDeduction = (item) => {
  const rules = item?.shipping_meta?.refund_rules || {};
  return roundMoney(rules.return_delivery_deduction ?? item?.shipping_meta?.delivery_charge ?? 0);
};

const calculateItemAction = ({ order, item, actionType, quantity }) => {
  const qty = Math.max(1, Number(quantity || 1));
  const itemAmount = roundMoney(Number(item.price || 0) * qty);
  const forwardDeduction = actionType === ACTION_TYPES.RETURN ? getForwardDeduction(item) : 0;
  const reverseDeduction = actionType === ACTION_TYPES.RETURN ? getCourierCharge(order) : 0;
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

const statusAfterCompletedAction = (item, actionType) => {
  const quantity = Math.max(0, Number(item.quantity || 0));
  const cancelled = Number(item.cancelled_quantity || 0);
  const returned = Number(item.returned_quantity || 0);
  const exchanged = Number(item.exchanged_quantity || 0);
  if (actionType === ACTION_TYPES.CANCEL) {
    return cancelled >= quantity ? ITEM_STATUS.CANCELLED : ITEM_STATUS.PARTIALLY_CANCELLED;
  }
  if (actionType === ACTION_TYPES.RETURN) {
    return returned >= quantity ? ITEM_STATUS.RETURN_COMPLETED : ITEM_STATUS.PARTIALLY_RETURNED;
  }
  return exchanged >= quantity ? ITEM_STATUS.EXCHANGE_COMPLETED : ITEM_STATUS.PARTIALLY_EXCHANGED;
};

const isDeliveredEnoughForPostDeliveryAction = (order) => {
  const status = String(order?.status || '').toLowerCase();
  return Boolean(order?.delivered_at) || status === 'delivered';
};

/**
 * Append one entry to an order's status_history array.
 * actor: 'customer' | 'admin' | 'system'
 */
const appendOrderStatusHistory = (order, status, actor, note = null) => {
  const history = Array.isArray(order.status_history) ? [...order.status_history] : [];
  history.push({ status, timestamp: new Date().toISOString(), actor, note });
  return history;
};

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
  appendOrderStatusHistory,
  roundMoney,
};
