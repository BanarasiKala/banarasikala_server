/**
 * Creates the marketplace tables and seeds the three channels the shop sells on.
 *
 *   marketplaces               Amazon / Flipkart / Myntra — name, mark, brand colour,
 *                              storefront link, and where each one is in its life
 *   product_marketplace_links  which product is listed where, and at what URL
 *
 * Schema auto-sync is disabled (SYNC_DATABASE = false in config/db.js), so this must be
 * run once after deploying. Safe to run repeatedly: sync() only creates a table that is
 * not there, and the seed below skips any slug that already exists, so edits made in the
 * admin are never overwritten by a re-run.
 *
 *   npm run migrate:marketplaces
 */
require("dotenv").config();

const { sequelize } = require("../src/config/db");
const Marketplace = require("../src/models/Marketplace");
// Order matters: both parents must exist before the join table that references them.
require("../src/models/Product");
const ProductMarketplaceLink = require("../src/models/ProductMarketplaceLink");

/**
 * Seeded to match what the footer already shows, so nothing has to be re-sourced:
 * Amazon and Flipkart have Iconify marks, Myntra is the image already in public/.
 *
 * Only Amazon carries a storefront_url — that is the one the shop actually has, and the
 * "see everything" button renders only where there is somewhere real to send people.
 * Myntra starts as coming_soon: the page and its footer badge exist, and going live
 * later is a status change in the admin rather than a build.
 */
const SEED = [
  {
    slug: "amazon",
    name: "Amazon",
    tagline: "Genuine Banarasi handloom, delivered by Amazon.",
    icon: "simple-icons:amazon",
    accent_color: "#FF9900",
    storefront_url: "https://www.amazon.in",
    storefront_note:
      "Every Banarasi Kala saree we list on Amazon, in one place — with Prime delivery, Amazon's returns window and Pay on Delivery.",
    url_pattern: "amazon.",
    status: "live",
    display_order: 1,
  },
  {
    slug: "flipkart",
    name: "Flipkart",
    tagline: "Our handwoven sarees, on Flipkart.",
    icon: "simple-icons:flipkart",
    accent_color: "#2874F0",
    // No storefront page on Flipkart yet, so no button — see Marketplace.storefront_url.
    storefront_url: null,
    storefront_note: null,
    url_pattern: "flipkart.",
    status: "live",
    display_order: 2,
  },
  {
    slug: "myntra",
    name: "Myntra",
    tagline: "Coming soon to Myntra.",
    icon: "/image.png",
    accent_color: "#FF3F6C",
    storefront_url: null,
    storefront_note: null,
    url_pattern: "myntra.",
    status: "coming_soon",
    display_order: 3,
  },
];

(async () => {
  try {
    await sequelize.authenticate();
    console.log("Connected. Creating marketplace tables…");

    await Marketplace.sync();
    console.log("  ✓ marketplaces");
    await ProductMarketplaceLink.sync();
    console.log("  ✓ product_marketplace_links");

    console.log("\nSeeding channels (existing slugs are left untouched)…");
    for (const row of SEED) {
      const [, created] = await Marketplace.findOrCreate({
        where: { slug: row.slug },
        defaults: row,
      });
      console.log(`  ${created ? "✓ added  " : "· kept   "} ${row.slug}`);
    }

    console.log("\nDone. Marketplace pages are live at /store/<slug>.");
    process.exit(0);
  } catch (error) {
    console.error("Failed to create marketplace tables:", error);
    process.exit(1);
  }
})();
