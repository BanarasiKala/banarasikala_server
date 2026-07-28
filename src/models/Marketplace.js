const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");

/**
 * A third-party storefront the shop also sells on — Amazon, Flipkart, Myntra.
 *
 * A row rather than a hardcoded list because the set grows: the shop lists on a new
 * marketplace, adds the row here, and its page at /store/<slug> exists with its products,
 * its footer badge and its nav entry, with no deploy. That is the whole reason this is a
 * table and not three columns on `products`.
 */
const Marketplace = sequelize.define(
  "Marketplace",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // Used in the public URL: /store/amazon.
    slug: {
      type: DataTypes.STRING(60),
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },
    tagline: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },
    /**
     * Either an Iconify id ("simple-icons:amazon") or an image path/URL ("/image.png",
     * or something uploaded). Both, because that is what the footer already does — Amazon
     * and Flipkart have Iconify marks, Myntra does not — and forcing one form would have
     * meant re-sourcing artwork that is already in the project.
     * The client picks its renderer by looking for a slash or a leading dot.
     */
    icon: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    // The marketplace's brand colour, used for the badge and page accents.
    accent_color: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    /**
     * The shop's own storefront page on that marketplace — "see all our products there".
     * Nullable on purpose: the shop has one on Amazon but not on Flipkart, so the button
     * and its blurb only render for channels that actually have somewhere to send people.
     * A button that goes to a marketplace's generic homepage is worse than no button.
     */
    storefront_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    // Copy shown beside that button. Per-channel because the pitch differs — Prime
    // delivery on Amazon is not a thing you can say about Flipkart.
    storefront_note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    /**
     * Listing URLs are checked to contain this, so a Flipkart link cannot be pasted into
     * the Amazon slot — a mistake that is invisible until a customer follows it to the
     * wrong shop. Blank disables the check for that channel.
     */
    url_pattern: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    /**
     * Where this channel is in its life:
     *
     *   live         page lists the products linked to it
     *   coming_soon  page exists and is linked, but says the shop is not there yet —
     *                which is Myntra today: the structure is built and the announcement
     *                is the content, so going live later is a status change, not a build
     *   hidden       no page, no footer badge; links are kept so it can come back
     *                without re-entering every product URL
     *
     * One field rather than a pair of booleans: these are three points on one line, and
     * as separate flags they would allow states that mean nothing (hidden AND coming
     * soon) that every reader would then have to resolve.
     */
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "live",
      validate: {
        isIn: [["live", "coming_soon", "hidden"]],
      },
    },
    display_order: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: "marketplaces",
    timestamps: true,
    underscored: true,
  },
);

module.exports = Marketplace;
