const NewsletterSubscriber = require('../models/NewsletterSubscriber');
const NewsletterCampaign = require('../models/NewsletterCampaign');
const EmailService = require('./EmailService');

/**
 * Sends a campaign to every active subscriber.
 *
 * Throttled deliberately. Campaigns share the same SMTP relay as order confirmations and
 * verification links, and those are the emails a business genuinely cannot afford to have
 * throttled or reputation-blocked. Firing several hundred marketing emails as fast as
 * nodemailer will accept them is the quickest way to lose both. So: small batches, a pause
 * between them, and one email at a time inside a batch.
 *
 * Both knobs are env-overridable without being required, so the rate can be tuned against a
 * real provider's limits without a code change:
 *   NEWSLETTER_BATCH_SIZE   (default 20)
 *   NEWSLETTER_BATCH_PAUSE_MS (default 2000)
 */
const BATCH_SIZE = Math.max(1, Number(process.env.NEWSLETTER_BATCH_SIZE) || 20);
const BATCH_PAUSE_MS = Math.max(0, Number(process.env.NEWSLETTER_BATCH_PAUSE_MS) ?? 2000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const activeSubscriberEmails = async () => {
  const rows = await NewsletterSubscriber.findAll({
    where: { is_active: true },
    attributes: ['email'],
  });
  // De-dupe defensively: the column is unique, but a case difference would still send twice.
  return [...new Set(rows.map((row) => String(row.email || '').trim().toLowerCase()).filter(Boolean))];
};

/**
 * Runs the send. Deliberately NOT awaited by the HTTP handler — a few hundred throttled emails
 * take minutes, far longer than any request should stay open. Progress is written to the
 * campaign row as it goes, which is what the admin screen polls.
 */
const runCampaign = async (campaignId) => {
  const campaign = await NewsletterCampaign.findByPk(campaignId);
  if (!campaign) return;

  try {
    const recipients = await activeSubscriberEmails();
    await campaign.update({
      status: 'Sending',
      recipient_count: recipients.length,
      started_at: new Date(),
      sent_count: 0,
      failed_count: 0,
    });

    let sent = 0;
    let failed = 0;

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);

      for (const email of batch) {
        try {
          await EmailService.sendNewsletterCampaign(email, campaign);
          sent += 1;
        } catch (error) {
          failed += 1;
          console.error(`[Newsletter] campaign #${campaign.id} failed for ${email}:`, error.message);
        }
      }

      await campaign.update({ sent_count: sent, failed_count: failed });
      if (i + BATCH_SIZE < recipients.length) await sleep(BATCH_PAUSE_MS);
    }

    await campaign.update({
      status: 'Sent',
      sent_count: sent,
      failed_count: failed,
      finished_at: new Date(),
    });
    console.log(`[Newsletter] campaign #${campaign.id} finished — ${sent} sent, ${failed} failed.`);
  } catch (error) {
    console.error(`[Newsletter] campaign #${campaignId} aborted:`, error.message);
    await campaign.update({
      status: 'Failed',
      error: String(error.message || '').slice(0, 1000),
      finished_at: new Date(),
    }).catch(() => {});
  }
};

module.exports = { runCampaign, activeSubscriberEmails, BATCH_SIZE, BATCH_PAUSE_MS };
