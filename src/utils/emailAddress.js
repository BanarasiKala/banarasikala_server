/**
 * One definition of "is this an email address, and which mailbox is it".
 *
 * Two places now decide whether a saved address carries a usable receiver email — the
 * address API and order placement — and a third (EmailService) has to decide whether the
 * receiver's mailbox is the same one the buyer already got the mail at. If those three
 * disagreed about case or whitespace, "Aditya@x.com " and "aditya@x.com" would count as
 * two different people and every order to your own address would send two identical
 * receipts.
 *
 * Lower-cased on the way in. The local part of an address is technically case-sensitive,
 * but no mail host anyone here uses treats it that way, and the alternative is a customer
 * being emailed twice because they capitalised their own name.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed and lower-cased, or null when the input is not an address at all. */
const normalizeEmail = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  return EMAIL_PATTERN.test(text) ? text : null;
};

/** Do these two point at the same mailbox? Two blanks are NOT the same mailbox. */
const isSameEmail = (left, right) => {
  const a = normalizeEmail(left);
  return Boolean(a) && a === normalizeEmail(right);
};

module.exports = { normalizeEmail, isSameEmail };
