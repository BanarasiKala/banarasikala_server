const { Op } = require('sequelize');
const NewsletterSubscriber = require('../models/NewsletterSubscriber');
const NewsletterCampaign = require('../models/NewsletterCampaign');
const { ensureCampaignTable } = require('../models/NewsletterCampaign');
const Coupon = require('../models/Coupon');
const Product = require('../models/Product');
const NewsletterCampaignService = require('../services/NewsletterCampaignService');
const { buildCouponCampaign, buildProductCampaign, PRODUCT_TEMPLATES } = require('../services/CampaignContentBuilder');
const EmailService = require('../services/EmailService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fire-and-forget: a mail server hiccup must not fail a subscription that is already saved.
const sendWelcome = (email) => {
  EmailService.sendNewsletterWelcome(email).catch((error) => {
    console.error('Newsletter welcome email failed:', error.message);
  });
};

exports.subscribe = async (req, res) => {
  try {

    const email = String(req.body.email || '').trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ success: false, message: 'Please enter your email address.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const existing = await NewsletterSubscriber.findOne({ where: { email } });

    if (existing) {
      if (existing.is_active) {
        return res.status(409).json({
          success: false,
          alreadySubscribed: true,
          message: 'This email is already subscribed to our newsletter.',
        });
      }
      // Re-activate if they previously unsubscribed
      existing.is_active = true;
      await existing.save();
      sendWelcome(email);
      return res.status(200).json({
        success: true,
        message: "Welcome back! You've been re-subscribed to our newsletter.",
      });
    }

    await NewsletterSubscriber.create({ email });
    sendWelcome(email);

    return res.status(201).json({
      success: true,
      message: "You're subscribed! Stay tuned for exclusive Banarasi Kala updates.",
    });
  } catch (error) {
    console.error('Newsletter subscribe error:', error);
    return res.status(500).json({ success: false, message: 'Could not subscribe right now. Please try again.' });
  }
};

// ── Campaigns ────────────────────────────────────────────────────────────────────────────
// A send cannot be recalled, so the guards here are deliberate: required copy, an explicit
// test-send path, and a status check that refuses to dispatch a campaign twice.

const cleanCampaignInput = (body = {}) => ({
  subject: String(body.subject || '').trim().slice(0, 255),
  heading: String(body.heading || '').trim().slice(0, 255),
  intro: String(body.intro || '').trim(),
  body: String(body.body || '').trim(),
  cta_label: String(body.ctaLabel || '').trim().slice(0, 120) || null,
  cta_url: String(body.ctaUrl || '').trim().slice(0, 500) || null,
});

const validateCampaign = (input) => {
  if (!input.subject) return 'A subject line is required.';
  if (!input.heading) return 'A heading is required.';
  if (!input.intro) return 'An intro paragraph is required.';
  if (input.cta_label && !input.cta_url) return 'A button label needs a button link.';
  if (input.cta_url && !/^https?:\/\//i.test(input.cta_url)) return 'The button link must start with http:// or https://.';
  return null;
};

// Preview the real thing against one address before committing to the whole list.
exports.sendTest = async (req, res) => {
  try {
    const input = cleanCampaignInput(req.body);
    const problem = validateCampaign(input);
    if (problem) return res.status(400).json({ success: false, message: problem });

    const to = String(req.body.testEmail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(to)) {
      return res.status(400).json({ success: false, message: 'Enter a valid test email address.' });
    }

    await EmailService.sendNewsletterCampaign(to, input);
    return res.status(200).json({ success: true, message: `Test email sent to ${to}.` });
  } catch (error) {
    console.error('Newsletter sendTest error:', error);
    return res.status(500).json({ success: false, message: 'Could not send the test email.' });
  }
};

exports.sendCampaign = async (req, res) => {
  try {
    await ensureCampaignTable();
    const input = cleanCampaignInput(req.body);
    const problem = validateCampaign(input);
    if (problem) return res.status(400).json({ success: false, message: problem });

    const recipients = await NewsletterCampaignService.activeSubscriberEmails();
    if (!recipients.length) {
      return res.status(400).json({ success: false, message: 'There are no active subscribers to send to.' });
    }

    const campaign = await NewsletterCampaign.create({
      ...input,
      status: 'Draft',
      recipient_count: recipients.length,
      created_by: req.user?.id || null,
    });

    // Not awaited: a throttled send to hundreds of subscribers takes minutes, far longer than
    // a request should stay open. The admin screen polls the campaign row for progress.
    NewsletterCampaignService.runCampaign(campaign.id);

    return res.status(202).json({
      success: true,
      message: `Sending to ${recipients.length} subscriber${recipients.length === 1 ? '' : 's'}.`,
      campaignId: campaign.id,
    });
  } catch (error) {
    console.error('Newsletter sendCampaign error:', error);
    return res.status(500).json({ success: false, message: 'Could not start the campaign.' });
  }
};

// ── Sourced campaigns (coupon / product) ────────────────────────────────────────────────
// Same pipeline as a manual campaign — the copy is generated from the entity, stored on the
// campaign row, and sent by the same renderer. What changes is that the row is tagged with
// what it came from, which is what makes the send counts below possible.

const startCampaign = async (res, content, actorId) => {
  const recipients = await NewsletterCampaignService.activeSubscriberEmails();
  if (!recipients.length) {
    return res.status(400).json({ success: false, message: 'There are no active subscribers to send to.' });
  }

  const campaign = await NewsletterCampaign.create({
    ...content,
    status: 'Draft',
    recipient_count: recipients.length,
    created_by: actorId || null,
  });

  NewsletterCampaignService.runCampaign(campaign.id);

  return res.status(202).json({
    success: true,
    message: `Sending to ${recipients.length} subscriber${recipients.length === 1 ? '' : 's'}.`,
    campaignId: campaign.id,
  });
};

exports.sendCouponCampaign = async (req, res) => {
  try {
    await ensureCampaignTable();
    const coupon = await Coupon.findByPk(Number(req.params.couponId));
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });
    if (!coupon.is_active) {
      return res.status(400).json({ success: false, message: 'This coupon is inactive — activate it before telling subscribers about it.' });
    }
    return await startCampaign(res, buildCouponCampaign(coupon.get({ plain: true })), req.user?.id);
  } catch (error) {
    console.error('Newsletter sendCouponCampaign error:', error);
    return res.status(500).json({ success: false, message: 'Could not start the coupon campaign.' });
  }
};

exports.sendProductCampaign = async (req, res) => {
  try {
    await ensureCampaignTable();
    const kind = String(req.body?.kind || '').trim();
    if (!PRODUCT_TEMPLATES[kind]) {
      return res.status(400).json({ success: false, message: 'Choose either an exclusive pick or a new arrival email.' });
    }

    const product = await Product.findByPk(Number(req.params.productId), {
      attributes: ['id', 'name', 'slug', 'images', 'selling_price', 'status'],
    });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    if (String(product.status) !== 'active') {
      return res.status(400).json({ success: false, message: 'This product is inactive — subscribers would land on a page they cannot buy from.' });
    }

    const content = buildProductCampaign(product.get({ plain: true }), kind);
    return await startCampaign(res, content, req.user?.id);
  } catch (error) {
    console.error('Newsletter sendProductCampaign error:', error);
    return res.status(500).json({ success: false, message: 'Could not start the product campaign.' });
  }
};

/**
 * How many times each entity has already been emailed about, so the admin screens can show it
 * before someone sends a second identical mail to the same list.
 *
 * `sourceType` is required; `sourceIds` narrows it to the rows currently on screen.
 */
exports.campaignSummary = async (req, res) => {
  try {
    await ensureCampaignTable();
    const sourceType = String(req.query.sourceType || '').trim();
    if (!['coupon', 'product'].includes(sourceType)) {
      return res.status(400).json({ success: false, message: 'sourceType must be coupon or product.' });
    }

    const ids = String(req.query.sourceIds || '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter(Number.isInteger);

    const rows = await NewsletterCampaign.findAll({
      where: {
        source_type: sourceType,
        // A Failed campaign still went out to whoever it reached before it stopped, so it is
        // counted. Only a Draft that never started is excluded.
        status: { [Op.ne]: 'Draft' },
        ...(ids.length ? { source_id: { [Op.in]: ids } } : {}),
      },
      attributes: ['source_id', 'template', 'status', 'sent_count', 'created_at'],
      order: [['created_at', 'DESC']],
    });

    // { [sourceId]: { total, sentTo, lastSentAt, byTemplate: { exclusive: 2, … } } }
    const summary = {};
    for (const row of rows) {
      const key = String(row.source_id);
      if (!summary[key]) summary[key] = { total: 0, sentTo: 0, lastSentAt: null, byTemplate: {} };
      const entry = summary[key];
      entry.total += 1;
      entry.sentTo += Number(row.sent_count || 0);
      entry.byTemplate[row.template] = (entry.byTemplate[row.template] || 0) + 1;
      if (!entry.lastSentAt) entry.lastSentAt = row.created_at;
    }

    const activeSubscribers = await NewsletterSubscriber.count({ where: { is_active: true } });
    return res.status(200).json({ success: true, activeSubscribers, summary });
  } catch (error) {
    console.error('Newsletter campaignSummary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load campaign history.' });
  }
};

exports.listCampaigns = async (req, res) => {
  try {
    await ensureCampaignTable();
    const campaigns = await NewsletterCampaign.findAll({
      order: [['created_at', 'DESC']],
      limit: 25,
    });
    const activeCount = await NewsletterSubscriber.count({ where: { is_active: true } });
    return res.status(200).json({ success: true, data: campaigns, activeSubscribers: activeCount });
  } catch (error) {
    console.error('Newsletter listCampaigns error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load campaigns.' });
  }
};

exports.getAll = async (req, res) => {
  try {

    const subscribers = await NewsletterSubscriber.findAll({
      where: { is_active: true },
      attributes: ['id', 'email', 'created_at'],
      order: [['created_at', 'DESC']],
    });
    return res.status(200).json({ success: true, data: subscribers });
  } catch (error) {
    console.error('Newsletter getAll error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch subscribers.' });
  }
};
