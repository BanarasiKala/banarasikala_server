const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");
const Material = require("./Material");
const Variety = require("./Variety");

const Product = sequelize.define(
  "Product",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    slug: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    short_description: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    sku: {
      type: DataTypes.STRING(255),
      allowNull: true,
      unique: true,
    },
    variant_skus: {
      type: DataTypes.JSONB,
      defaultValue: {},
      allowNull: false,
    },
    // Pricing & Financials
    selling_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    mrp_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    cost_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    discount_percent: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Inventory
    stock_quantity: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      allowNull: false,
    },
    low_stock_threshold: {
      type: DataTypes.INTEGER,
      defaultValue: 5,
    },
    // Days needed to process/dispatch this product before courier transit.
    // Null falls back to the client's VITE_ORDER_PROCESSING_DAYS env (default 4).
    processing_days: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    color_stocks: {
      type: DataTypes.JSONB,
      defaultValue: {},
      allowNull: false,
    },

    // Physical Attributes
    weight: {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    },
    length: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    },
    width: {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    },
    height: {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    },

    // Media. Each entry: { color_id, url, is_cover, display_order }
    images: {
      type: DataTypes.JSONB,
      defaultValue: [],
      allowNull: false,
    },

    // Product videos (max 3). Each entry: { url, display_order }
    videos: {
      type: DataTypes.JSONB,
      defaultValue: [],
      allowNull: false,
    },

    // Foreign Keys
    material_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: Material, key: "id" },
    },
    variety_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: Variety, key: "id" },
    },
    // Boolean Statuses
    special_collection: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    is_new_arrival: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Manual storefront ordering positions. Lower = shown first; null falls back
    // to the default newest-first order. Each surface is ordered independently.
    exclusive_order: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    new_arrival_order: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    collection_order: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING(20),
      defaultValue: "active",
      allowNull: false,
      validate: {
        isIn: [["active", "inactive"]],
      },
    },
    blouse_piece: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    payment_options: {
      type: DataTypes.JSONB,
      defaultValue: ["prepaid"],
      allowNull: false,
    },
    service_options: {
      type: DataTypes.JSONB,
      defaultValue: [],
      allowNull: false,
    },
    care_instructions: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    // Key highlights shown on the product page.
    // Each entry: { label: string, value: string, display_order: number }
    key_highlights: {
      type: DataTypes.JSONB,
      defaultValue: [],
      allowNull: false,
    },
  },
  {
    tableName: "products",
    timestamps: false,
  },
);

// Associations
Product.belongsTo(Material, { foreignKey: "material_id" });
Product.belongsTo(Variety, { foreignKey: "variety_id" });

module.exports = Product;
