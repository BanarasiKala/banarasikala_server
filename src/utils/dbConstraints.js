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

try {
    await sequelize.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = '${schema}'
            AND table_name = 'wallet_transactions'
            AND column_name = 'status'
            AND udt_name LIKE 'enum_%'
        ) THEN
          ALTER TABLE "${schema}"."wallet_transactions"
            ALTER COLUMN status DROP DEFAULT;
          ALTER TABLE "${schema}"."wallet_transactions"
            ALTER COLUMN status TYPE VARCHAR(20) USING status::text;
          ALTER TABLE "${schema}"."wallet_transactions"
            ALTER COLUMN status SET DEFAULT 'completed';
        END IF;
      END
      $$;
    `);
    console.log("[DB] wallet_transactions.status column ensured as VARCHAR.");
  } catch (error) {
    console.warn("[DB] Could not convert wallet_transactions.status:", error.message);
  }
};

const ensureProductOrderColumns = async () => {
  const columns = ["exclusive_order", "new_arrival_order", "collection_order", "processing_days"];
  for (const column of columns) {
    try {
      await sequelize.query(
        `ALTER TABLE "${schema}"."products" ADD COLUMN IF NOT EXISTS "${column}" INTEGER`,
      );
    } catch (error) {
      console.warn(`[DB] Could not ensure products.${column}:`, error.message);
    }
  }
  console.log("[DB] Product storefront order columns ensured.");
};

// Lazily ensure the feedbacks table has all the columns the app expects.
// Runs at most once per process (idempotent ALTERs guarded by a flag) so the
// per-request callers in FeedbackController don't issue DDL on every hit.
let feedbackColumnsEnsured = false;
const ensureFeedbackColumns = async () => {
  if (feedbackColumnsEnsured) return;
  const columns = [
    `ADD COLUMN IF NOT EXISTS "order_id" INTEGER`,
    `ADD COLUMN IF NOT EXISTS "order_item_id" INTEGER`,
    `ADD COLUMN IF NOT EXISTS "product_id" INTEGER`,
    `ADD COLUMN IF NOT EXISTS "title" VARCHAR(255)`,
    `ADD COLUMN IF NOT EXISTS "images" JSONB DEFAULT '[]'::jsonb`,
  ];
  try {
    for (const clause of columns) {
      await sequelize.query(`ALTER TABLE "${schema}"."feedbacks" ${clause}`);
    }
    feedbackColumnsEnsured = true;
    console.log("[DB] Feedback columns ensured.");
  } catch (error) {
    console.warn("[DB] Could not ensure feedback columns:", error.message);
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
    `CREATE INDEX IF NOT EXISTS idx_products_exclusive_order ON ${schema}.products (exclusive_order) WHERE exclusive_order IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_products_new_arrival_order ON ${schema}.products (new_arrival_order) WHERE new_arrival_order IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_products_collection_order ON ${schema}.products (collection_order) WHERE collection_order IS NOT NULL`,
    // Order child tables. Postgres does NOT index a foreign key column automatically, so
    // without these every read of an order (the My Orders page fetches seven of these
    // collections per order) sequentially scans each table.
    `CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON ${schema}.order_items (order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_item_actions_order_id ON ${schema}.order_item_actions (order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_item_actions_order_item_id ON ${schema}.order_item_actions (order_item_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_ledger_order_id ON ${schema}.order_ledger (order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id ON ${schema}.order_status_history (order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON ${schema}.shipments (order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_addresses_order_id ON ${schema}.order_addresses (order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rto_events_order_id ON ${schema}.rto_events (order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_refunds_order_id ON ${schema}.order_refunds (order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_order_id ON ${schema}.payments (order_id)`,
    // The page's feedback lookup filters on exactly this pair.
    `CREATE INDEX IF NOT EXISTS idx_feedbacks_customer_order ON ${schema}.feedbacks (customer_id, order_id)`,
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

module.exports = { ensureWalletConstraint, ensureProductOrderColumns, ensureFeedbackColumns, ensureIndexes };
