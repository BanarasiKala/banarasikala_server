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
    // Drives the "Verified Buyer" badge on the storefront. Defaults TRUE because every row in
    // this table came from a customer reviewing a product on a delivered order — they are, by
    // construction, a verified buyer. Admin can clear it on a specific review; the flag exists
    // so that decision is possible, not because the default is in doubt.
    `ADD COLUMN IF NOT EXISTS "is_verified" BOOLEAN NOT NULL DEFAULT TRUE`,
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

/**
 * The customer-level "Verified Buyer" flag.
 *
 * Defaults TRUE: a customer row that has reviews is by definition someone who bought and
 * received something. Turning this off is how an admin withholds the badge from one person
 * across every review they have written, without hunting those reviews down one at a time.
 */
let customerColumnsEnsured = false;
const ensureCustomerColumns = async () => {
  if (customerColumnsEnsured) return;
  try {
    await sequelize.query(
      `ALTER TABLE "${schema}"."customers" ADD COLUMN IF NOT EXISTS "is_verified" BOOLEAN NOT NULL DEFAULT TRUE`,
    );
    customerColumnsEnsured = true;
    console.log("[DB] Customer columns ensured.");
  } catch (error) {
    console.warn("[DB] Could not ensure customer columns:", error.message);
  }
};

/**
 * Post-inspection refund columns.
 *
 * Added after order_refunds shipped, so they need an explicit ALTER — the model's sync path is
 * CREATE TABLE IF NOT EXISTS and does nothing at all to a table that already exists.
 */
let refundColumnsEnsured = false;
const ensureRefundColumns = async () => {
  if (refundColumnsEnsured) return;
  const columns = [
    `ADD COLUMN IF NOT EXISTS "inspected_amount" NUMERIC(10,2)`,
    `ADD COLUMN IF NOT EXISTS "inspection_note" TEXT`,
    `ADD COLUMN IF NOT EXISTS "inspected_by" INTEGER`,
    `ADD COLUMN IF NOT EXISTS "inspected_at" TIMESTAMP WITH TIME ZONE`,
    `ADD COLUMN IF NOT EXISTS "proof_images" JSONB DEFAULT '[]'::jsonb`,
  ];
  try {
    for (const clause of columns) {
      await sequelize.query(`ALTER TABLE "${schema}"."order_refunds" ${clause}`);
    }
    refundColumnsEnsured = true;
    console.log("[DB] Refund inspection columns ensured.");
  } catch (error) {
    console.warn("[DB] Could not ensure refund columns:", error.message);
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

/**
 * The per-coupon "show the expiry to customers" flag.
 *
 * Added the same way as the other late columns here rather than through a migration, because
 * schema sync is skipped on boot. FALSE by default so existing coupons keep printing no
 * expiry until someone opts them in — the storefront should not start making promises about
 * dates nobody reviewed.
 */
const ensureCouponColumns = async () => {
  try {
    await sequelize.query(
      `ALTER TABLE "${schema}"."coupons" ADD COLUMN IF NOT EXISTS "show_validity" BOOLEAN NOT NULL DEFAULT FALSE`,
    );
    console.log("[DB] Coupon display columns ensured.");
  } catch (error) {
    console.warn("[DB] Could not ensure coupon columns:", error.message);
  }
};

module.exports = {
  ensureWalletConstraint,
  ensureProductOrderColumns,
  ensureCouponColumns,
  ensureFeedbackColumns,
  ensureCustomerColumns,
  ensureRefundColumns,
  ensureIndexes,
};
