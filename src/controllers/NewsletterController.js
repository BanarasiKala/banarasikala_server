const NewsletterSubscriber = require('../models/NewsletterSubscriber');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      return res.status(200).json({
        success: true,
        message: "Welcome back! You've been re-subscribed to our newsletter.",
      });
    }

    await NewsletterSubscriber.create({ email });

    return res.status(201).json({
      success: true,
      message: "You're subscribed! Stay tuned for exclusive Banarasi Kala updates.",
    });
  } catch (error) {
    console.error('Newsletter subscribe error:', error);
    return res.status(500).json({ success: false, message: 'Could not subscribe right now. Please try again.' });
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
