/**
 * Creates the three reel tables (reels, reel_comments, reel_likes) in the
 * vns_saree schema. Safe to run repeatedly — Sequelize's sync() only creates a
 * table if it does not already exist, and does not touch other tables.
 *
 * Run once after deploying the reels feature:
 *   npm run migrate:reels
 */
require("dotenv").config();

const { sequelize } = require("../src/config/db");
// Order matters: Reel must exist before the tables that reference it.
const Reel = require("../src/models/Reel");
const ReelComment = require("../src/models/ReelComment");
const ReelLike = require("../src/models/ReelLike");

(async () => {
  try {
    await sequelize.authenticate();
    console.log("Connected. Creating reel tables…");

    await Reel.sync();
    console.log("  ✓ reels");
    await ReelComment.sync();
    console.log("  ✓ reel_comments");
    await ReelLike.sync();
    console.log("  ✓ reel_likes");

    console.log("Done. Reel tables are ready.");
    process.exit(0);
  } catch (error) {
    console.error("Failed to create reel tables:", error);
    process.exit(1);
  }
})();
