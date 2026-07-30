const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");

const Customer = sequelize.define(
  "Customer",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true,
      },
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    google_id: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    auth_provider: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "local",
    },
    role: {
      type: DataTypes.STRING(20),
      defaultValue: "user",
    },
    refresh_token: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    email_verified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    phone_verified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    phone_otp_verification_id: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    // Whether this person's reviews carry the "Verified Buyer" badge on the storefront. Not
    // the same thing as email_verified / phone_verified above, which are about reaching them;
    // this is about vouching for them publicly. Admin-controlled from User Directory.
    is_verified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    referral_code: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    referred_by_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "referred_by",
    },
    wallet_balance: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    avatar_url: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    is_cod_blocked: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    cod_block_reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    blocked_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "customers",
    timestamps: true,
  },
);

module.exports = Customer;
