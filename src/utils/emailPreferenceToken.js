const crypto = require('crypto');
const { config } = require('../config/env');

/**
 * Unsubscribe links have to work from an email client, where there is no session and no
 * login — so the link itself must carry proof that the person holding it owns the address.
 *
 * The token is an HMAC of the address, keyed with a server secret. That gives us:
 *   • unguessable — you cannot enumerate other people's addresses and unsubscribe them;
 *   • stateless — no token column, no expiry sweep, no extra write on every send;
 *   • stable — a link in an email from six months ago still works, which is exactly what
 *     an unsubscribe link has to do (and what a one-shot token would get wrong).
 *
 * Deliberately NOT reused for anything that grants account access. It only ever authorises
 * managing email preferences for one address.
 */
const SECRET = `${config.jwtSecret}:email-preferences`;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const createPreferenceToken = (email) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return crypto.createHmac('sha256', SECRET).update(normalized).digest('hex');
};

/** Constant-time compare, so a wrong token cannot be narrowed down by timing the response. */
const verifyPreferenceToken = (email, token) => {
  const expected = createPreferenceToken(email);
  const provided = String(token || '');
  if (!expected || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
};

/** The link dropped into an email footer. */
const buildPreferenceUrl = (email) => {
  const normalized = normalizeEmail(email);
  const token = createPreferenceToken(normalized);
  if (!normalized || !token) return null;
  const base = (config.frontendUrl || 'https://banarasikala.com').replace(/\/$/, '');
  return `${base}/email-preferences?email=${encodeURIComponent(normalized)}&token=${token}`;
};

module.exports = { createPreferenceToken, verifyPreferenceToken, buildPreferenceUrl, normalizeEmail };
