const { sequelize } = require("../config/db");
const { config } = require("../config/env");

const schema = config.dbSchema || "public";

const ensureWalletConstraint = async () => {
  try {
    await sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'wallet_balance_non_negative'
            AND conrelid = '${schema}.customers'::regclass
        ) THEN
          ALTER TABLE ${schema}.customers
            ADD CONSTRAINT wallet_balance_non_negative
            CHECK (wallet_balance >= 0);
        END IF;
      END
      $$;
    `);
    console.log("[DB] wallet_balance_non_negative constraint ensured.");
  } catch (error) {
    console.warn("[DB] Could not ensure wallet constraint:", error.message);
  }
};

const ensureIndexes = async () => {
  const indexes = [
    // customers
    `CREATE INDEX IF NOT EXISTS idx_customers_referral_code ON ${schema}.customers (referral_code)`,
    // orders
    `CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON ${schema}.orders (customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status ON ${schema}.orders (status)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_shiprocket_order_id ON ${schema}.orders (shiprocket_order_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_gateway_payment_id ON ${schema}.orders (gateway_payment_id) WHERE gateway_payment_id IS NOT NULL`,
    // products
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON ${schema}.products (slug)`,
    `CREATE INDEX IF NOT EXISTS idx_products_status ON ${schema}.products (status)`,
  ];

  for (const sql of indexes) {
    try {
      await sequelize.query(sql);
    } catch (error) {
      console.warn(`[DB] Index skipped (${error.message.split('\n')[0]})`);
    }
  }
  console.log("[DB] Indexes ensured.");
};

module.exports = { ensureWalletConstraint, ensureIndexes };
