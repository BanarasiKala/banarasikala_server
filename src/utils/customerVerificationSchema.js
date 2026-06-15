const { sequelize } = require("../config/db");
const { config } = require("../config/env");

const schema = config.dbSchema || "public";

const ensureCustomerVerificationColumns = async () => {
  const steps = [
    // Add email_verified (defaults false for new rows)
    `ALTER TABLE ${schema}.customers ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`,
    // Add phone_otp_verification_id for storing MessageCentral session server-side
    `ALTER TABLE ${schema}.customers ADD COLUMN IF NOT EXISTS phone_otp_verification_id VARCHAR(255)`,
  ];

  for (const sql of steps) {
    try {
      await sequelize.query(sql);
    } catch (e) {
      console.warn(`[DB] customerVerification column skipped: ${e.message.split("\n")[0]}`);
    }
  }

  // All customers that existed before this column was added are already verified
  // (they went through OTP or Google flow). Mark them all as verified.
  try {
    await sequelize.query(`
      UPDATE ${schema}.customers
      SET email_verified = true
      WHERE email_verified = false
        AND phone_verified = true
    `);
    // Google customers have phone_verified=false but their email IS verified by Google
    await sequelize.query(`
      UPDATE ${schema}.customers
      SET email_verified = true
      WHERE email_verified = false
        AND auth_provider = 'google'
    `);
  } catch (e) {
    console.warn("[DB] Could not backfill email_verified:", e.message);
  }

  console.log("[DB] Customer verification columns ensured.");
};

const cleanupUnverifiedCustomers = async () => {
  try {
    // Remove pending registrations that were never completed after 48 hours
    const [, meta] = await sequelize.query(`
      DELETE FROM ${schema}.customers
      WHERE email_verified = false
        AND "createdAt" < NOW() - INTERVAL '48 hours'
    `);
    const count = meta?.rowCount ?? 0;
    if (count > 0) console.log(`[DB] Removed ${count} abandoned pending registration(s).`);
  } catch (e) {
    console.warn("[DB] Unverified customer cleanup failed:", e.message);
  }
};

module.exports = { ensureCustomerVerificationColumns, cleanupUnverifiedCustomers };
