/**
 * Moves reel comments from "admin approves each one" to "live on write, admin deletes",
 * and adds one level of threading so a comment can be replied to.
 *
 *   1. adds reel_comments.parent_id  → the thread root a reply belongs to (NULL = a root)
 *   2. indexes (reel_id, parent_id)  → every read is one reel's roots, or one thread's replies
 *   3. drops reel_comments.is_approved
 *
 * Schema auto-sync is disabled (SYNC_DATABASE = false in config/db.js), so this must be
 * run once after deploying. Safe to run repeatedly — every statement is IF [NOT] EXISTS.
 *
 *   npm run migrate:reel-comments
 *
 * NOTE ON EXISTING COMMENTS: dropping is_approved publishes everything that was sitting
 * unapproved. That is the point of the change, but it means real comments nobody has read
 * go live at once, so the count is printed below before the drop — check Reels → Comments
 * in the admin afterwards and delete anything that should not stand.
 */
require("dotenv").config();

const { sequelize } = require("../src/config/db");
const { config } = require("../src/config/env");

(async () => {
  try {
    await sequelize.authenticate();
    const table = `"${config.dbSchema}"."reel_comments"`;
    console.log(`Connected. Migrating ${table}…`);

    // Report the backlog BEFORE dropping the column, while it can still be counted.
    // The existence check has to be its OWN statement: Postgres parses a statement in
    // full before running it, so a `WHERE EXISTS (…information_schema…) AND is_approved`
    // guard still fails to parse once the column is gone, and the re-run would die here.
    const [columns] = await sequelize.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = :schema
          AND table_name = 'reel_comments'
          AND column_name = 'is_approved';`,
      { replacements: { schema: config.dbSchema } }
    );

    let pending = 0;
    if (columns.length > 0) {
      const [rows] = await sequelize.query(
        `SELECT COUNT(*)::int AS pending FROM ${table} WHERE is_approved = false;`
      );
      pending = Number(rows?.[0]?.pending || 0);
    }

    await sequelize.query(
      `ALTER TABLE ${table}
         ADD COLUMN IF NOT EXISTS "parent_id" INTEGER
         REFERENCES ${table}("id") ON DELETE CASCADE;`
    );
    console.log("  ✓ parent_id");

    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS "reel_comments_reel_id_parent_id"
         ON ${table} ("reel_id", "parent_id");`
    );
    console.log("  ✓ index (reel_id, parent_id)");

    await sequelize.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS "is_approved";`);
    console.log("  ✓ is_approved dropped — comments are live on write");

    if (pending > 0) {
      console.log("");
      console.log(`  ⚠ ${pending} comment(s) had been waiting for approval and are now visible.`);
      console.log("    Review them in the admin under Reels → Comments and delete any that");
      console.log("    should not stand.");
    }

    console.log("\nDone. Reel comments are threaded and unmoderated.");
    process.exit(0);
  } catch (error) {
    console.error("Failed to migrate reel comments:", error);
    process.exit(1);
  }
})();
