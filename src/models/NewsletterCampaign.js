const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { config } = require('../config/env');

/**
 * One newsletter send. Recorded before the first email leaves, and updated as the batch runs,
 * so a campaign is never a fire-and-forget action nobody can account for afterwards.
 *
 * `status` is what makes a double-send visible: a campaign already Sending or Sent cannot be
 * dispatched again, which matters because there is no recalling an email.
 */
const NewsletterCampaign = sequelize.define('NewsletterCampaign', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  subject: { type: DataTypes.STRING(255), allowNull: false },
  heading: { type: DataTypes.STRING(255), allowNull: false },
  intro: { type: DataTypes.TEXT, allowNull: false },
  body: { type: DataTypes.TEXT, allowNull: true },
  cta_label: { type: DataTypes.STRING(120), allowNull: true },
  cta_url: { type: DataTypes.STRING(500), allowNull: true },
  // Optional hero image — a product shot for a feature mail. Manual campaigns leave it null.
  image_url: { type: DataTypes.STRING(1000), allowNull: true },
  // What this campaign was generated FROM. This is what makes "have I already emailed the
  // list about this coupon?" answerable: count the campaigns for (source_type, source_id)
  // rather than relying on whoever pressed the button to remember.
  //   source_type: 'manual' | 'coupon' | 'product'
  //   template:    'custom' | 'coupon' | 'exclusive' | 'new_arrival'
  source_type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' },
  source_id: { type: DataTypes.INTEGER, allowNull: true },
  template: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'custom' },
  // Draft -> Sending -> Sent | Failed
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'Draft' },
  recipient_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  sent_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  failed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  started_at: { type: DataTypes.DATE, allowNull: true },
  finished_at: { type: DataTypes.DATE, allowNull: true },
  created_by: { type: DataTypes.INTEGER, allowNull: true },
  error: { type: DataTypes.TEXT, allowNull: true },
}, {
  tableName: 'newsletter_campaigns',
  schema: config.dbSchema,
  timestamps: true,
  underscored: true,
});

// Global sync is disabled, so the table is created on first use, once per process. `alter`
// is deliberately avoided; instead any column missing from an existing table is added
// individually, which is how the rest of this codebase evolves a live schema.
let ready = false;
const ensureCampaignTable = async () => {
  if (ready) return;
  try {
    const qi = sequelize.getQueryInterface();
    const table = { tableName: 'newsletter_campaigns', schema: config.dbSchema };
    try {
      const columns = await qi.describeTable(table);
      const attributes = NewsletterCampaign.rawAttributes;
      for (const [name, definition] of Object.entries(attributes)) {
        const column = definition.field || name;
        if (!columns[column]) await qi.addColumn(table, column, definition);
      }
    } catch {
      await NewsletterCampaign.sync();
    }
    ready = true;
  } catch (error) {
    console.error('[Newsletter] campaign table ensure failed:', error.message);
  }
};

module.exports = NewsletterCampaign;
module.exports.ensureCampaignTable = ensureCampaignTable;
