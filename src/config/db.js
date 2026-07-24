const { Sequelize } = require("sequelize");
const { config } = require("./env");

/**
 * Global schema sync — OFF, and it needs to stay off.
 *
 * `alter: true` re-adds every foreign key on each run WITHOUT dropping the previous one.
 * Postgres does not reject the duplicate, it just appends a number to the auto-generated
 * name — products_variety_id_fkey, _fkey1, _fkey2 — so each boot leaves another identical
 * constraint behind. On 2026-07-24 the products table was found carrying 320 of them
 * (160 per column) from roughly that many past runs, which had two effects:
 *
 *   - every write to products was validated 160 times over
 *   - the copies disagreed on ON DELETE (6 said NO ACTION, 154 said SET NULL), and Postgres
 *     applies the strictest, so deleting a variety failed however the model was declared
 *
 * They were dropped and replaced with one clean constraint per column. Turning this back on
 * would start the accumulation again from scratch.
 *
 * Tables that genuinely need creating on boot call `Model.sync({ force: false })` themselves
 * — that is CREATE TABLE IF NOT EXISTS and never touches constraints on an existing table.
 * Column changes are made with an explicit, idempotent migration (see SupportRoutes or
 * utils/orderTransactions for the shape).
 */
const SYNC_DATABASE = false;
const SYNC_OPTIONS = { alter: true };

if (!config.databaseUrl) {
  console.error("CRITICAL ERROR: DATABASE_URL is not defined in environment variables.");
}

const shouldUseSsl = (url) => url.includes("supabase.co") || url.includes("render.com");

const sequelize = new Sequelize(config.databaseUrl, {
  dialect: "postgres",
  logging: false,
  dialectOptions: {
    ssl: shouldUseSsl(config.databaseUrl) ? {
      require: true,
      rejectUnauthorized: false,
    } : false,
  },
  define: {
    schema: config.dbSchema,
    timestamps: false,
  },
});

const runSchemaSync = async () => {
  if (!SYNC_DATABASE) {
    console.log("Database schema sync skipped.");
    return;
  }

  console.log("Database schema sync started.");
  await sequelize.sync(SYNC_OPTIONS);
  console.log("Database schema synchronized.");
};

const connectDB = async () => {
  try {
    await sequelize.authenticate();
    console.log("PostgreSQL connected successfully.");
    console.log(`Database schema: ${config.dbSchema}`);

    await runSchemaSync();

    // Foreign-key indexes for the order graph. Postgres does not index FKs automatically,
    // so without these every My Orders load runs a sequential scan per association — cost
    // scaling with total rows in the system rather than the customer's own. Idempotent
    // (CREATE INDEX IF NOT EXISTS) and best-effort: never block boot on it.
    // Runs AFTER sync so the tables exist.
    try {
      const { ensureOrderIndexes } = require('../utils/ensureIndexes');
      await ensureOrderIndexes();
    } catch (indexError) {
      console.error('[Indexes] Skipped:', indexError.message);
    }

  } catch (error) {
    console.error("Unable to connect to the database:", error);
    process.exit(1);
  }
};

module.exports = { sequelize, connectDB };
