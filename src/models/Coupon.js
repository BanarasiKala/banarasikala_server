const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");
const Product = require("./Product");
const Variety = require("./Variety");
const Color = require("./Color");
const Occasion = require("./Occasion");

const Coupon = sequelize.define(
  "Coupon",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // Basic Info
    code: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    description: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Description of the offer",
    },

    // Discount Type
    discount_type: {
      type: DataTypes.STRING,
      defaultValue: "percentage",
      validate: {
        isIn: [["percentage", "fixed_amount"]],
      },
    },
    discount_percent: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Percentage discount (e.g., 20 for 20%)",
    },
    discount_amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: "Fixed amount discount (e.g., 500 for ₹500 off)",
    },

    // Limits
    min_purchase_amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 0,
    },
    max_discount_amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: "Maximum discount cap for percentage coupons",
    },

    // Usage Limits
    usage_limit: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Total times coupon can be used (NULL = unlimited)",
    },
    usage_limit_per_user: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      comment: "Times one user can use this coupon",
    },
    usage_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: "Track actual usage count",
    },

    // Validity
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    valid_from: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When coupon becomes valid",
    },
    valid_until: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When coupon expires",
    },

    // Display Settings
    display_on_homepage: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: "Show this coupon on homepage",
    },
    banner_text: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'e.g., "Use code DIWALI20 for 20% off!"',
    },

    // Location/Delivery Based
    min_delivery_km: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Minimum delivery distance in KM to apply coupon",
    },

    // Applicability (Multiple Target Support)
    applicable_product_id: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      allowNull: true,
      defaultValue: null
    },
    applicable_variety_id: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      allowNull: true,
      defaultValue: null
    },
    applicable_color_id: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      allowNull: true,
      defaultValue: null
    },
    applicable_occasion_id: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      allowNull: true,
      defaultValue: null
    },
    applicable_material_id: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      allowNull: true,
      defaultValue: null
    },
  },
  {
    tableName: "coupons",
    schema: "vns_saree"
  },
);

// Note: belongsTo associations removed because arrays are not supported as foreign keys in Sequelize joins.
// Relationships are now handled at the application logic / frontend level.

module.exports = Coupon;
