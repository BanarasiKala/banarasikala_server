const { DataTypes, Op } = require("sequelize");
const { sequelize } = require("../config/db");
const { config } = require("../config/env");
const Order = require("../models/Order");
const Customer = require("../models/Customer");

const ORDER_LIFECYCLE_COLUMNS = {
  is_rto: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  rto_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  is_redispatched: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  redispatch_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  original_order_id: { type: DataTypes.BIGINT, allowNull: true },
  redispatch_payment_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: true, defaultValue: 0 },
  customer_cod_blocked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  cod_blocked_at: { type: DataTypes.DATE, allowNull: true },
  cod_block_reason: { type: DataTypes.TEXT, allowNull: true },
  is_modified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  modified_at: { type: DataTypes.DATE, allowNull: true },
  status_history: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
  is_gift: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  gift_message: { type: DataTypes.TEXT, allowNull: true },
  gift_charge: { type: DataTypes.DECIMAL(10, 2), allowNull: true, defaultValue: 0 },
};

const CUSTOMER_COD_COLUMNS = {
  is_cod_blocked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  cod_block_reason: { type: DataTypes.TEXT, allowNull: true },
  blocked_at: { type: DataTypes.DATE, allowNull: true },
};

const COD_BLOCK_MESSAGE = "COD is not available for this account. Please place a prepaid order.";
const COD_RTO_BLOCK_REASON = "COD blocked because a previous COD order returned to seller after unsuccessful delivery.";

let lifecycleColumnsReady = false;

const ensureColumns = async (table, definitions) => {
  const queryInterface = sequelize.getQueryInterface();
  let columns = await queryInterface.describeTable(table);

  for (const [column, definition] of Object.entries(definitions)) {
    if (!columns[column]) {
      await queryInterface.addColumn(table, column, definition);
    }
  }

  return queryInterface.describeTable(table);
};

const ensureOrderLifecycleColumns = async () => {
  if (lifecycleColumnsReady) return;

  await ensureColumns({ tableName: "orders", schema: config.dbSchema }, ORDER_LIFECYCLE_COLUMNS);
  await ensureColumns({ tableName: "customers", schema: config.dbSchema }, CUSTOMER_COD_COLUMNS);

  lifecycleColumnsReady = true;
};

const normalizeText = (value) => String(value || "").trim().toLowerCase();
const normalizePhone = (value) => String(value || "").replace(/\D/g, "").slice(-10);

const getContactWhere = ({ email, phone }) => {
  const cleanEmail = normalizeText(email);
  const cleanPhone = normalizePhone(phone);
  if (!cleanEmail || !cleanPhone) return null;
  return {
    [Op.and]: [
      sequelize.where(sequelize.fn("lower", sequelize.col("email")), cleanEmail),
      { phone: { [Op.like]: `%${cleanPhone}` } },
    ],
  };
};

const isCodBlockedForContact = async ({ customerId, email, phone, transaction } = {}) => {
  await ensureOrderLifecycleColumns();

  const contactWhere = getContactWhere({ email, phone });
  const customerWhere = customerId
    ? { id: customerId }
    : contactWhere;

  if (customerWhere) {
    const customer = await Customer.findOne({
      where: customerWhere,
      attributes: ["id", "is_cod_blocked"],
      transaction,
    });
    if (customer?.is_cod_blocked) return true;
  }

  if (!contactWhere) return false;

  const blockedOrder = await Order.findOne({
    where: {
      customer_cod_blocked: true,
      [Op.and]: [
        sequelize.where(sequelize.fn("lower", sequelize.col("customer_email")), normalizeText(email)),
        { phone: { [Op.like]: `%${normalizePhone(phone)}` } },
      ],
    },
    attributes: ["id"],
    transaction,
  });

  return Boolean(blockedOrder);
};

const blockCustomerCodForOrder = async (order, reason = COD_RTO_BLOCK_REASON, transaction = null) => {
  await ensureOrderLifecycleColumns();

  const cleanEmail = normalizeText(order.customer_email);
  const cleanPhone = normalizePhone(order.phone);
  const where = order.customer_id
    ? { id: order.customer_id }
    : cleanEmail && cleanPhone
      ? {
        [Op.and]: [
          sequelize.where(sequelize.fn("lower", sequelize.col("email")), cleanEmail),
          { phone: { [Op.like]: `%${cleanPhone}` } },
        ],
      }
      : null;

  if (!where) return;

  await Customer.update(
    {
      is_cod_blocked: true,
      cod_block_reason: reason,
      blocked_at: new Date(),
    },
    { where, transaction },
  );
};

const toMoney = (value) => {
  const next = Number(value);
  return Number.isFinite(next) ? Math.max(0, Math.round(next * 100) / 100) : 0;
};

const getCourierMoney = (courierData, keys) => {
  const data = courierData || {};
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== "") return toMoney(data[key]);
  }
  return 0;
};

const getForwardShippingCharge = (order) => {
  const stored = toMoney(order.shipping_charge);
  if (stored > 0) return stored;
  return getCourierMoney(order.selected_courier_data, ["freight_charge", "rate", "charge", "shipping_charge"]);
};

const getRtoShippingCharge = (order) =>
  getCourierMoney(order.selected_courier_data, ["rto_charges", "rto_charge", "rto_freight_charge", "rto_shipping_charge"]);

const calculateRtoRefundAmount = (order, nextRtoCount = null) => {
  const paid = toMoney(order.payable_amount ?? order.total_amount);
  const rtoCount = Math.max(1, Number(nextRtoCount ?? order.rto_count ?? 1));
  const forwardCharge = getForwardShippingCharge(order);
  const rtoCharge = getRtoShippingCharge(order);
  const redispatchPaid = toMoney(order.redispatch_payment_amount);
  const logisticsDeduction = (forwardCharge + rtoCharge) * rtoCount + redispatchPaid;

  return Math.max(0, toMoney(paid - logisticsDeduction));
};

module.exports = {
  ORDER_LIFECYCLE_COLUMNS,
  CUSTOMER_COD_COLUMNS,
  COD_BLOCK_MESSAGE,
  COD_RTO_BLOCK_REASON,
  ensureOrderLifecycleColumns,
  isCodBlockedForContact,
  blockCustomerCodForOrder,
  calculateRtoRefundAmount,
  getForwardShippingCharge,
  getRtoShippingCharge,
  toMoney,
};
