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

// Global sync is disabled, so the table is created on first use, once per process.
let ready = false;
const ensureCampaignTable = async () => {
  if (ready) return;
  try {
    await NewsletterCampaign.sync();
    ready = true;
  } catch (error) {
    console.error('[Newsletter] campaign table ensure failed:', error.message);
  }
};

module.exports = NewsletterCampaign;
module.exports.ensureCampaignTable = ensureCampaignTable;
