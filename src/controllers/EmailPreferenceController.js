const { Op } = require('sequelize');
const NewsletterSubscriber = require('../models/NewsletterSubscriber');
const StockNotification = require('../models/StockNotification');
const Product = require('../models/Product');
const { verifyPreferenceToken, normalizeEmail } = require('../utils/emailPreferenceToken');

/**
 * The preference centre behind every unsubscribe link.
 *
 * One address can be on more than one list — the newsletter, plus a back-in-stock alert for
 * each saree it is waiting on — so an unsubscribe link that only killed the newsletter would
 * leave the customer still receiving mail they thought they had stopped. This lists every
 * place the address is registered and lets them switch any of them off.
 *
 * Authorised by the signed token in the link, never by a session: these links are opened from
 * an email client, usually logged out.
 */

// Both endpoints answer identically for a bad token, so the response cannot be used to test
// whether an address is on our lists.
const authorise = (req) => {
  const email = normalizeEmail(req.query.email ?? req.body?.email);
  const token = req.query.token ?? req.body?.token;
  if (!email || !verifyPreferenceToken(email, token)) return null;
  return email;
};

// Only alerts that have NOT been sent yet are actionable — a notified row is history, and
// unsubscribing from it would stop nothing.
const pendingAlertsFor = (email) => StockNotification.findAll({
  where: { email: { [Op.iLike]: email }, notified_at: null },
  include: [{ model: Product, attributes: ['id', 'name', 'slug'], required: false }],
  order: [['created_at', 'DESC']],
});

exports.getPreferences = async (req, res) => {
  try {
    const email = authorise(req);
    if (!email) {
      return res.status(403).json({ success: false, message: 'This unsubscribe link is invalid or has expired.' });
    }

    const [subscriber, alerts] = await Promise.all([
      NewsletterSubscriber.findOne({ where: { email } }),
      pendingAlertsFor(email),
    ]);

    return res.status(200).json({
      success: true,
      email,
      newsletter: Boolean(subscriber?.is_active),
      // A row whose product was since deleted still counts — the customer is on the list and
      // must be able to come off it, named or not.
      stockAlerts: alerts.map((row) => ({
        id: row.id,
        productId: row.product_id,
        productName: row.Product?.name || 'A saree you were waiting for',
        slug: row.Product?.slug || null,
      })),
    });
  } catch (error) {
    console.error('EmailPreference getPreferences error:', error);
    return res.status(500).json({ success: false, message: 'Could not load your email preferences.' });
  }
};

exports.updatePreferences = async (req, res) => {
  try {
    const email = authorise(req);
    if (!email) {
      return res.status(403).json({ success: false, message: 'This unsubscribe link is invalid or has expired.' });
    }

    const { newsletter, stockAlertIds, unsubscribeAll } = req.body || {};

    if (unsubscribeAll === true) {
      await NewsletterSubscriber.update({ is_active: false }, { where: { email } });
      await StockNotification.destroy({ where: { email: { [Op.iLike]: email }, notified_at: null } });
      return res.status(200).json({ success: true, message: 'You have been unsubscribed from everything.' });
    }

    if (typeof newsletter === 'boolean') {
      const existing = await NewsletterSubscriber.findOne({ where: { email } });
      if (existing) {
        await existing.update({ is_active: newsletter });
      } else if (newsletter) {
        // Re-subscribing from the preference centre is legitimate — the token proves the
        // address is theirs, which is the same bar the signup form clears.
        await NewsletterSubscriber.create({ email, is_active: true });
      }
    }

    // The ids sent are the ones to KEEP. Anything pending and not listed is being switched
    // off, so it is deleted rather than flagged — a stock alert has no "inactive" state, and
    // asking again simply creates a fresh row.
    if (Array.isArray(stockAlertIds)) {
      const keep = stockAlertIds.map(Number).filter(Number.isInteger);
      await StockNotification.destroy({
        where: {
          email: { [Op.iLike]: email },
          notified_at: null,
          ...(keep.length ? { id: { [Op.notIn]: keep } } : {}),
        },
      });
    }

    return res.status(200).json({ success: true, message: 'Your email preferences have been saved.' });
  } catch (error) {
    console.error('EmailPreference updatePreferences error:', error);
    return res.status(500).json({ success: false, message: 'Could not save your email preferences.' });
  }
};
