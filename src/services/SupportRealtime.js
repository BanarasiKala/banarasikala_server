const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * Realtime fan-out for support conversations.
 *
 * Three concerns live here, deliberately together, because they share one lifecycle:
 *   1. the event bus  — who gets told when a message/status/receipt changes
 *   2. typing state   — ephemeral, never persisted
 *   3. stream tokens  — short-lived credentials for the SSE connection
 *
 * ── Why SSE and not WebSockets ──────────────────────────────────────────────────────────
 * Support messaging is server -> client notification. Both sides SEND over the normal POST
 * that already exists; they only need to RECEIVE pushes. WebSockets would buy bidirectional
 * frames we never use, at the cost of a second protocol, a separate auth path, and
 * hand-written reconnect logic. SSE is plain HTTP and EventSource reconnects natively.
 *
 * ── The single-instance caveat ─────────────────────────────────────────────────────────
 * This EventEmitter is IN-PROCESS. With two Node instances behind a load balancer, a
 * customer connected to instance A never sees a message written on instance B. That is a
 * real limitation, not a theoretical one — it appears the moment you scale out.
 *
 * The fix is to replace the two functions marked TRANSPORT BOUNDARY below with Postgres
 * LISTEN/NOTIFY (no new infrastructure — Postgres is already here) or Redis pub/sub.
 * Everything else talks to `publish()` / `subscribe()` and does not care.
 */

const bus = new EventEmitter();
// Every open SSE connection is a listener; a busy admin desk plus customers will exceed the
// default cap of 10 and print a spurious leak warning.
bus.setMaxListeners(0);

// ── TRANSPORT BOUNDARY ────────────────────────────────────────────────────────────────
// Swap these two for LISTEN/NOTIFY or Redis to go multi-instance. Nothing else changes.
const publish = (channel, payload) => bus.emit(channel, payload);
const subscribe = (channel, handler) => {
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
};
// ──────────────────────────────────────────────────────────────────────────────────────

// Channels. A customer gets the one channel for their own conversation (they must never
// receive anyone else's traffic); admins share one firehose for the inbox.
const conversationChannel = (conversationId) => `conversation:${conversationId}`;
const ADMIN_CHANNEL = 'admin:inbox';

/**
 * Presence — who currently has a live connection.
 *
 * This is what makes the middle tick honest. Without it "delivered" would either be a lie
 * (always ✓✓ the moment we save) or indistinguishable from "read" (only set when they open
 * the thread, by which point it's read anyway) — and the three-state tick would collapse
 * into two.
 *
 * An admin sitting on the Support page holds the inbox stream open, so a customer message is
 * genuinely delivered to their browser the instant it is written, well before anyone opens
 * the thread. That is exactly the ✓✓-but-not-blue window.
 *
 * Counted, not boolean: the same person may have two tabs open, and the first one closing
 * must not mark them absent.
 */
const adminConnections = { count: 0 };
const customerConnections = new Map(); // conversationId -> count

const addPresence = (side, conversationId) => {
  if (side === 'admin') {
    adminConnections.count += 1;
    return;
  }
  const key = Number(conversationId);
  customerConnections.set(key, (customerConnections.get(key) || 0) + 1);
};

const dropPresence = (side, conversationId) => {
  if (side === 'admin') {
    adminConnections.count = Math.max(0, adminConnections.count - 1);
    return;
  }
  const key = Number(conversationId);
  const next = (customerConnections.get(key) || 1) - 1;
  if (next <= 0) customerConnections.delete(key);
  else customerConnections.set(key, next);
};

// Is the RECIPIENT of a message from `sender` currently connected?
const recipientIsPresent = (sender, conversationId) => (sender === 'customer'
  ? adminConnections.count > 0
  : (customerConnections.get(Number(conversationId)) || 0) > 0);

/**
 * Stream tokens — the answer to "EventSource cannot send headers".
 *
 * The browser's EventSource API has no way to set an Authorization header, so the only
 * native options are a cookie or the query string. Putting the real JWT in the query string
 * would write a long-lived credential into nginx access logs, browser history, and any proxy
 * in between — a genuinely bad trade for a convenience.
 *
 * Instead the client calls POST /stream-token with its normal Bearer header and gets a
 * single-purpose token back: random, 60-second TTL, single-use, scoped to one identity. Even
 * if it leaks it grants nothing but a read-only event stream, and only for a minute.
 */
const STREAM_TOKEN_TTL_MS = 60 * 1000;
const streamTokens = new Map(); // token -> { userId, role, expiresAt }

const issueStreamToken = ({ userId, role }) => {
  const token = crypto.randomBytes(32).toString('hex');
  streamTokens.set(token, { userId, role, expiresAt: Date.now() + STREAM_TOKEN_TTL_MS });
  return token;
};

// Single-use: consumed on redemption so a token captured from a log can't be replayed.
const redeemStreamToken = (token) => {
  const entry = streamTokens.get(String(token || ''));
  if (!entry) return null;
  streamTokens.delete(token);
  if (Date.now() > entry.expiresAt) return null;
  return { userId: entry.userId, role: entry.role };
};

/**
 * Typing state — deliberately never touches the database.
 *
 * "X is typing" is worthless a second after it was true, so persisting it would be pure
 * write amplification on a table that matters. It lives in memory with a short TTL and is
 * allowed to be lost on restart.
 *
 * The TTL is what makes this robust: a client that closes its laptop mid-message never sends
 * the "stopped" signal, so the indicator has to expire on its own rather than stick forever.
 * Every ping re-arms it.
 */
const TYPING_TTL_MS = 6 * 1000;
const typingState = new Map(); // `${conversationId}:${side}` -> timeout handle

const emitTyping = (conversationId, side, name, typing) => {
  publish(conversationChannel(conversationId), { type: 'typing', side, name, typing });
  // The inbox shows "typing" against a row, which is only ever the customer's.
  if (side === 'customer') {
    publish(ADMIN_CHANNEL, {
      type: 'typing', conversation_id: conversationId, side, name, typing,
    });
  }
};

const setTyping = ({ conversationId, side, name }) => {
  const key = `${conversationId}:${side}`;
  clearTimeout(typingState.get(key));
  emitTyping(conversationId, side, name, true);
  typingState.set(key, setTimeout(() => {
    typingState.delete(key);
    emitTyping(conversationId, side, name, false);
  }, TYPING_TTL_MS));
};

// Sending a message means you have, by definition, stopped typing. Without this the
// indicator lingers for the rest of the TTL underneath the message that just arrived.
const clearTyping = ({ conversationId, side }) => {
  const key = `${conversationId}:${side}`;
  if (!typingState.has(key)) return;
  clearTimeout(typingState.get(key));
  typingState.delete(key);
  emitTyping(conversationId, side, null, false);
};

// ── Emitters used by the controller ───────────────────────────────────────────────────

const emitMessage = (conversationId, message) => {
  publish(conversationChannel(conversationId), { type: 'message', message });
  publish(ADMIN_CHANNEL, { type: 'message', conversation_id: conversationId, message });
};

// A customer who has never written is a new row in the inbox; a new strand on someone who
// has is a new chip on the row they already occupy. Both arrive here — the payload's
//  says which, so the inbox can add or merge without guessing.
const emitConversationStarted = (conversation) => {
  publish(ADMIN_CHANNEL, { type: 'conversation_started', conversation });
};

// Status belongs to ONE strand, so the event names it. A client showing a single order must
// be able to ignore a status change on another, and the admin inbox needs to know which chip
// to repaint rather than the whole row.
const emitStatusChange = (conversationId, topicId, status) => {
  publish(conversationChannel(conversationId), { type: 'status', topic_id: topicId, status });
  publish(ADMIN_CHANNEL, {
    type: 'status', conversation_id: conversationId, topic_id: topicId, status,
  });
};

/**
 * Read receipts: tell the OTHER side their message has been seen (blue ticks).
 *
 * `side` is who DID the reading, so the party that needs telling is the other one. The
 * conversation channel carries both directions — each side's open thread listens on it. The
 * admin inbox is a second listener, and the only read it can act on is the CUSTOMER's: it
 * renders support's own ticks. Mirroring the admin's own read back to the inbox would
 * announce something it already knew and leave it deaf to the one event it needs.
 */
const emitRead = (conversationId, side, readAt) => {
  publish(conversationChannel(conversationId), { type: 'read', side, read_at: readAt });
  if (side === 'customer') {
    publish(ADMIN_CHANNEL, {
      type: 'read', conversation_id: conversationId, side, read_at: readAt,
    });
  }
};

// Delivery receipts: the sender's ✓ becomes ✓✓. `ids` are the messages that just landed on
// the recipient's client.
const emitDelivered = (conversationId, ids, deliveredAt) => {
  if (!ids.length) return;
  publish(conversationChannel(conversationId), {
    type: 'delivered', ids, delivered_at: deliveredAt,
  });
  publish(ADMIN_CHANNEL, {
    type: 'delivered', conversation_id: conversationId, ids, delivered_at: deliveredAt,
  });
};

// Periodic sweep of expired stream tokens. Redemption deletes them, so this only collects
// tokens that were issued and never used (customer closed the tab mid-connect).
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of streamTokens) {
    if (now > entry.expiresAt) streamTokens.delete(token);
  }
}, 60 * 1000);
sweep.unref?.(); // never hold the process open

module.exports = {
  subscribe,
  conversationChannel,
  ADMIN_CHANNEL,
  issueStreamToken,
  redeemStreamToken,
  addPresence,
  dropPresence,
  recipientIsPresent,
  setTyping,
  clearTyping,
  emitMessage,
  emitConversationStarted,
  emitStatusChange,
  emitRead,
  emitDelivered,
};
