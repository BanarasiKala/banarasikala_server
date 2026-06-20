const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");
const Customer = require("./Customer");

const WalletTransaction = sequelize.define(
  "WalletTransaction",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: Customer, key: "id" },
    },
    amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "completed",
    },
    available_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    dedupe_key: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    meta: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "wallet_transactions",
    schema: "vns_saree",
    timestamps: true,
    underscored: true,
  },
);

Customer.hasMany(WalletTransaction, { foreignKey: "customer_id" });
WalletTransaction.belongsTo(Customer, { foreignKey: "customer_id" });

module.exports = WalletTransaction;

