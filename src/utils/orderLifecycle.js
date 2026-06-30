const { DataTypes, Op } = require("sequelize");
const { sequelize } = require("../config/db");
const { config } = require("../config/env");
const Order = require("../models/Order");
const Customer = require("../models/Customer");
const CodBlockEvent = require("../models/CodBlockEvent");
const { COD_BLOCK_ACTION } = require("./orderModelV2");

// V2: these legacy order columns were dropped and now live in dedicated tables
// (shipments, rto_events, order_modifications, order_status_history,
// cod_block_events, order_ledger). The list is intentionally empty so the
// ensure helper no longer resurrects the dropped columns.
const ORDER_LIFECYCLE_COLUMNS = {};

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

// V2: the COD-block flag is a customer-level attribute (customers.is_cod_blocked),
// with history in cod_block_events. We no longer scan the orders table.
const isCodBlockedForContact = async ({ customerId, email, phone, transaction } = {}) => {
  const customerWhere = customerId ? { id: customerId } : getContactWhere({ email, phone });
  if (!customerWhere) return false;

  const customer = await Customer.findOne({
    where: customerWhere,
    attributes: ["id", "is_cod_blocked"],
    transaction,
  });
  return Boolean(customer?.is_cod_blocked);
};

// V2: set the customer-level flag and record a cod_block_events audit row.
// The order no longer stores phone, so guests are matched by email only.
const blockCustomerCodForOrder = async (order, reason = COD_RTO_BLOCK_REASON, transaction = null) => {
  const cleanEmail = normalizeText(order.customer_email);
  const where = order.customer_id
    ? { id: order.customer_id }
    : cleanEmail
      ? sequelize.where(sequelize.fn("lower", sequelize.col("email")), cleanEmail)
      : null;

  if (!where) return;

  const customer = await Customer.findOne({ where, attributes: ["id"], transaction });
  if (!customer) return;

  await Customer.update(
    { is_cod_blocked: true, cod_block_reason: reason, blocked_at: new Date() },
    { where: { id: customer.id }, transaction },
  );

  await CodBlockEvent.create(
    {
      customer_id: customer.id,
      action: COD_BLOCK_ACTION.BLOCK,
      triggered_by_order_id: order.id || null,
      reason,
    },
    { transaction },
  );
};

const toMoney = (value) => {
  const next = Number(value);
  return Number.isFinite(next) ? Math.max(0, Math.round(next * 100) / 100) : 0;
};

// V2: RTO refund/shipping calculations moved to the ledger + rto_events (charges
// are sourced from the forward shipment's rate card in ShipRocketController).
// The old order-column-based helpers were removed.

module.exports = {
  ORDER_LIFECYCLE_COLUMNS,
  CUSTOMER_COD_COLUMNS,
  COD_BLOCK_MESSAGE,
  COD_RTO_BLOCK_REASON,
  ensureOrderLifecycleColumns,
  isCodBlockedForContact,
  blockCustomerCodForOrder,
  toMoney,
};
