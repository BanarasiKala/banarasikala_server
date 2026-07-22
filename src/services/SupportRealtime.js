const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * Realtime fan-out for support tickets.
 *
 * Three concerns live here, deliberately together, because they share one lifecycle:
 *   1. the event bus  — who gets told when a message/ticket/status changes
 *   2. typing state   — ephemeral, never persisted
 *   3. stream tickets — short-lived credentials for the SSE connection
 *
 * ── Why SSE and not WebSockets ──────────────────────────────────────────────────────────
 * Support messaging is server -> client notification. The customer SENDS over the normal
 * POST that already exists; they only need to RECEIVE pushes. WebSockets would buy
 * bidirectional frames we never use, at the cost of a second protocol, a separate auth
 * path, and hand-written reconnect logic. SSE is plain HTTP: EventSource reconnects
 * natively, and the chatbot already proves the transport works through this stack.
 *
 * ── The single-instance caveat ─────────────────────────────────────────────────────────
 * This EventEmitter is IN-PROCESS. With two Node instances behind a load balancer, a
 * customer connected to instance A never sees a message written on instance B. That is a
 * real limitation, not a theoretical one — it appears the moment you scale out.
 *
 * The fix is to replace the two functions marked TRANSPORT BOUNDARY below with Postgres
 * LISTEN/NOTIFY (no new infrastructure — Postgres is already here) or Redis pub/sub.
 * Everything else in the codebase talks to `publish()` / `subscribe()` and does not care.
 */

const bus = new EventEmitter();
// Every open SSE connection is a listener; a busy admin desk plus customers will exceed
// the default cap of 10 and print a spurious leak warning.
bus.setMaxListeners(0);

// ── TRANSPORT BOUNDARY ────────────────────────────────────────────────────────────────
// Swap these two for LISTEN/NOTIFY or Redis to go multi-instance. Nothing else changes.
const publish = (channel, payload) => bus.emit(channel, payload);
const subscribe = (channel, handler) => {
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
};
// ──────────────────────────────────────────────────────────────────────────────────────

// Channels. Customers get one channel per ticket (they must never receive another
// customer's traffic); admins get one shared firehose for the inbox.
const ticketChannel = (ticketId) => `ticket:${ticketId}`;
const ADMIN_CHANNEL = 'admin:inbox';

/**
 * Presence — who currently has a live connection.
 *
 * This is what makes the middle tick honest. Without it "delivered" would either be a lie
 * (always ✓✓ the moment we save) or indistinguishable from "read" (only set when they open
 * the thread, by which point it's read anyway) — and the three-state tick would collapse
 * into two.
 *
 * An admin sitting on the Tickets page holds the inbox stream open, so a customer message
 * is genuinely delivered to their browser the instant it is written, well before anyone
 * opens the thread. That is exactly the ✓✓-but-not-blue window.
 *
 * Counted, not boolean: the same person may have two tabs open, and the first one closing
 * must not mark them absent.
 */
const adminConnections = { count: 0 };
const customerConnections = new Map(); // ticketId -> count

const addPresence = (side, ticketId) => {
  if (side === 'admin') {
    adminConnections.count += 1;
  } else {
    customerConnections.set(ticketId, (customerConnections.get(ticketId) || 0) + 1);
  }
};

const dropPresence = (side, ticketId) => {
  if (side === 'admin') {
    adminConnections.count = Math.max(0, adminConnections.count - 1);
    return;
  }
  const next = (customerConnections.get(ticketId) || 1) - 1;
  if (next <= 0) customerConnections.delete(ticketId);
  else customerConnections.set(ticketId, next);
};

// Is the RECIPIENT of a message from `sender` currently connected?
const recipientIsPresent = (sender, ticketId) => (sender === 'customer'
  ? adminConnections.count > 0
  : (customerConnections.get(Number(ticketId)) || 0) > 0);

/**
 * Stream tickets — the answer to "EventSource cannot send headers".
 *
 * The browser's EventSource API has no way to set an Authorization header, so the only
 * native options are a cookie or the query string. Putting the real JWT in the query
 * string would write a long-lived credential into nginx access logs, browser history, and
 * any proxy in between — a genuinely bad trade for a convenience.
 *
 * Instead the client calls POST /stream-ticket with its normal Bearer header, and gets a
 * single-purpose token back: random, 60-second TTL, single-use, and scoped to one identity.
 * Even if it leaks it grants nothing but a read-only event stream, and only for a minute.
 */
const STREAM_TICKET_TTL_MS = 60 * 1000;
const streamTickets = new Map(); // token -> { userId, role, expiresAt }

const issueStreamTicket = ({ userId, role }) => {
  const token = crypto.randomBytes(32).toString('hex');
  streamTickets.set(token, { userId, role, expiresAt: Date.now() + STREAM_TICKET_TTL_MS });
  return token;
};

// Single-use: consumed on redemption so a token captured from a log can't be replayed.
const redeemStreamTicket = (token) => {
  const entry = streamTickets.get(String(token || ''));
  if (!entry) return null;
  streamTickets.delete(token);
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
 * The TTL is what makes this robust: a client that closes its laptop mid-message never
 * sends the "stopped" signal, so the indicator has to expire on its own rather than stick
 * forever. Every ping re-arms it.
 */
const TYPING_TTL_MS = 6 * 1000;
const typingState = new Map(); // `${ticketId}:${side}` -> timeout handle

const setTyping = ({ ticketId, side, name }) => {
  const key = `${ticketId}:${side}`;
  clearTimeout(typingState.get(key));

  publish(ticketChannel(ticketId), { type: 'typing', side, name, typing: true });
  if (side === 'customer') {
    publish(ADMIN_CHANNEL, { type: 'typing', ticket_id: ticketId, side, name, typing: true });
  }

  typingState.set(key, setTimeout(() => {
    typingState.delete(key);
    publish(ticketChannel(ticketId), { type: 'typing', side, typing: false });
    if (side === 'customer') {
      publish(ADMIN_CHANNEL, { type: 'typing', ticket_id: ticketId, side, typing: false });
    }
  }, TYPING_TTL_MS));
};

// Sending a message means you have, by definition, stopped typing. Without this the
// indicator lingers for the rest of the TTL underneath the message that just arrived.
const clearTyping = ({ ticketId, side }) => {
  const key = `${ticketId}:${side}`;
  if (!typingState.has(key)) return;
  clearTimeout(typingState.get(key));
  typingState.delete(key);
  publish(ticketChannel(ticketId), { type: 'typing', side, typing: false });
  if (side === 'customer') {
    publish(ADMIN_CHANNEL, { type: 'typing', ticket_id: ticketId, side, typing: false });
  }
};

// ── Emitters used by the controller ───────────────────────────────────────────────────

const emitMessage = (ticketId, message) => {
  publish(ticketChannel(ticketId), { type: 'message', message });
  publish(ADMIN_CHANNEL, { type: 'message', ticket_id: ticketId, message });
};

const emitTicketCreated = (ticket) => {
  // Admin-only: the customer who just raised it already has it on screen.
  publish(ADMIN_CHANNEL, { type: 'ticket_created', ticket });
};

const emitStatusChange = (ticketId, status, canReply) => {
  publish(ticketChannel(ticketId), { type: 'status', status, can_reply: canReply });
  publish(ADMIN_CHANNEL, { type: 'status', ticket_id: ticketId, status });
};

// Read receipts: tell the OTHER side their message has been seen (blue ticks).
//
// `side` is who DID the reading, so the party that needs telling is the other one. The thread
// channel carries both directions — each side's open thread listens on it. The admin inbox is
// a second listener, and the only read it can act on is the CUSTOMER's: it renders support's
// own ticks. Mirroring the admin's own read back to the inbox announced something it already
// knew and left it deaf to the one event the channel exists to carry.
const emitRead = (ticketId, side, readAt) => {
  publish(ticketChannel(ticketId), { type: 'read', side, read_at: readAt });
  if (side === 'customer') {
    publish(ADMIN_CHANNEL, { type: 'read', ticket_id: ticketId, side, read_at: readAt });
  }
};

// Delivery receipts: the sender's ✓ becomes ✓✓. `ids` are the messages that just landed
// on the recipient's client.
const emitDelivered = (ticketId, ids, deliveredAt) => {
  if (!ids.length) return;
  publish(ticketChannel(ticketId), { type: 'delivered', ids, delivered_at: deliveredAt });
  publish(ADMIN_CHANNEL, { type: 'delivered', ticket_id: ticketId, ids, delivered_at: deliveredAt });
};

// Periodic sweep of expired stream tickets. Redemption deletes them, so this only collects
// tokens that were issued and never used (customer closed the tab mid-connect).
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of streamTickets) {
    if (now > entry.expiresAt) streamTickets.delete(token);
  }
}, 60 * 1000);
sweep.unref?.(); // never hold the process open

module.exports = {
  subscribe,
  ticketChannel,
  ADMIN_CHANNEL,
  issueStreamTicket,
  redeemStreamTicket,
  addPresence,
  dropPresence,
  recipientIsPresent,
  setTyping,
  clearTyping,
  emitMessage,
  emitTicketCreated,
  emitStatusChange,
  emitRead,
  emitDelivered,
};
