/**
 * Adds the `video` column to the occasions table so Occasions can store a
 * short video (uploaded to S3) instead of / alongside the image.
 *
 * Schema auto-sync is disabled (SYNC_DATABASE = false in config/db.js), so this
 * ALTER must be run once after deploying the occasion-video feature. Safe to run
 * repeatedly — `ADD COLUMN IF NOT EXISTS` is a no-op when the column exists.
 *
 *   npm run migrate:occasion-video
 */
require("dotenv").config();

const { sequelize } = require("../src/config/db");
const { config } = require("../src/config/env");

(async () => {
  try {
    await sequelize.authenticate();
    const table = `"${config.dbSchema}"."occasions"`;
    console.log(`Connected. Adding "video" column to ${table}…`);

    await sequelize.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "video" VARCHAR(255);`
    );

    console.log("Done. occasions.video is ready.");
    process.exit(0);
  } catch (error) {
    console.error("Failed to add occasions.video column:", error);
    process.exit(1);
  }
})();
