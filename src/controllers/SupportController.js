const { Op } = require('sequelize');
const SupportTicket = require('../models/SupportTicket');
const SupportTicketMessage = require('../models/SupportTicketMessage');
const Order = require('../models/Order');
const EmailService = require('../services/EmailService');
const Realtime = require('../services/SupportRealtime');
const { generateUploadSignature } = require('../config/cloudinary');

/**
 * Legacy categories.
 *
 * The storefront no longer asks the customer to pick one — the form is a description plus
 * photos — so new queries are stored as DEFAULT_CATEGORY. The list stays because rows
 * raised before the change still carry these values and the admin console filters on them;
 * a submitted category is still accepted and validated if one arrives.
 */
const TICKET_CATEGORIES = [
  'Delivery or shipping issue',
  'Payment or refund issue',
  'Damaged or defective product',
  'Wrong or missing item',
  'Return or exchange help',
  'Other',
];
const DEFAULT_CATEGORY = 'Other';

const TICKET_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const OPEN_STATUSES = ['Open', 'In Progress'];

// A closed ticket is the end of the conversation — reopening means raising a new one.
// Everything else (Open / In Progress / Resolved) can still be replied to, so a customer
// who says "that didn't work" after a Resolved isn't stranded.
const isThreadClosed = (ticket) => String(ticket?.status || '') === 'Closed';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_ATTACHMENTS = 5;

// Uploads go straight from the browser to Cloudinary (signed), so the server only ever
// receives the resulting URL. This is the one shape it will store or serve.
const CLOUDINARY_URL = /^https:\/\/res\.cloudinary\.com\//i;

/**
 * Sanitise an attachments array arriving from a client.
 *
 * The upload itself goes straight from the browser to Cloudinary (signed), so the server
 * only ever sees the resulting URLs — which means it must not trust them. Anything that is
 * not an https Cloudinary URL is discarded, and only url/public_id are kept, so a caller
 * cannot smuggle extra keys or a `javascript:`/`data:` URL into a column that later ends up
 * inside an <img src> on the admin console.
 */
const sanitizeAttachments = (value) => (Array.isArray(value) ? value : [])
  .filter((item) => item && typeof item.url === 'string' && CLOUDINARY_URL.test(item.url))
  .slice(0, MAX_ATTACHMENTS)
  .map((item) => ({
    url: item.url,
    public_id: String(item.public_id || '').slice(0, 255),
  }));
// A double-submit (impatient click, retried request) must not create a second row — the
// same text on the same thread inside this window is treated as the one message it is.
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

const normalizePhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  const stripped = digits.replace(/^(91|0)+/, '');
  return stripped.length > 10 ? stripped.slice(-10) : stripped;
};

// Guest orders (customer_id null) are matched by email, the same rule the rest of
// the customer order endpoints use.
const findOwnedOrder = (orderId, user) => Order.findOne({
  where: {
    id: orderId,
    [Op.or]: [
      { customer_id: user.id },
      { customer_id: null, customer_email: user.email },
    ],
  },
});

/**
 * Attachments as the client is allowed to see them.
 *
 * Re-filtered on the way OUT as well as in: the column is JSONB, so rows written before
 * sanitizeAttachments existed — or by anything other than this controller — are not
 * guaranteed to hold the shape this claims to return. Reusing the same rule in both
 * directions means a bad row is inert rather than rendered into an <img>.
 */
const publicAttachments = sanitizeAttachments;

const publicMessage = (row) => ({
  id: row.id,
  sender: row.sender,
  sender_name: row.sender_name,
  message: row.message,
  attachments: publicAttachments(row.attachments),
  createdAt: row.createdAt,
  // Drives the middle tick. Read (blue) is derived client-side from the ticket's read
  // watermark, so it isn't repeated per message.
  delivered_at: row.delivered_at || null,
});

/**
 * Mark every message from `fromSide` on this ticket as delivered, and tell the sender.
 *
 * Called when the OTHER side's client connects — that connection is the moment the
 * messages genuinely reached their browser. Idempotent: only rows still null are touched,
 * so a reconnect loop can't churn the table or re-emit.
 */
const markDelivered = async (ticketId, fromSide) => {
  try {
    const deliveredAt = new Date();
    const ids = [];

    const pending = await SupportTicketMessage.findAll({
      where: { ticket_id: ticketId, sender: fromSide, delivered_at: null },
      attributes: ['id'],
    });
    if (pending.length) {
      ids.push(...pending.map((row) => row.id));
      await SupportTicketMessage.update(
        { delivered_at: deliveredAt },
        { where: { id: ids }, silent: true },
      );
    }

    // The opening message is the ticket row itself, so it is stamped here too — it is a
    // customer message, and it reaches the admin at the same moment the rest do. Its id in
    // the thread is the synthetic `ticket-<id>`, which is what the client keys ticks by.
    if (fromSide === 'customer') {
      const [stamped] = await SupportTicket.update(
        { opening_delivered_at: deliveredAt },
        { where: { id: ticketId, opening_delivered_at: null }, silent: true },
      );
      if (stamped) ids.push(`ticket-${ticketId}`);
    }

    if (!ids.length) return;
    Realtime.emitDelivered(ticketId, ids, deliveredAt);
  } catch (error) {
    // A delivery receipt is cosmetic — never let it break the stream it rides on.
    console.error('SupportController.markDelivered error:', error.message);
  }
};

// The ticket's own `message` is the FIRST message of the thread — it is rendered as such,
// not as a separate field, so the client only ever walks one list.
const threadOf = (ticket) => {
  const opening = {
    id: `ticket-${ticket.id}`,
    sender: 'customer',
    sender_name: ticket.name,
    message: ticket.message,
    // The photos raised WITH the query belong to its opening message, which is where the
    // customer attached them.
    attachments: publicAttachments(ticket.attachments),
    // Same tick states as any other message — see opening_delivered_at on the model.
    delivered_at: ticket.opening_delivered_at || null,
    createdAt: ticket.createdAt,
  };
  const replies = (ticket.Messages || []).map(publicMessage);
  return [opening, ...replies].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
};

const publicTicket = (ticket, { withThread = false } = {}) => ({
  id: ticket.id,
  ticket_number: ticket.ticket_number,
  order_id: ticket.order_id,
  order_number: ticket.Order?.order_number || null,
  category: ticket.category,
  message: ticket.message,
  attachments: publicAttachments(ticket.attachments),
  status: ticket.status,
  resolved_at: ticket.resolved_at,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
  can_reply: !isThreadClosed(ticket),
  // Read receipts. `*_read_at` is when THAT side last opened the thread; the client uses
  // the other side's watermark to render "Seen" under its own last message.
  customer_read_at: ticket.customer_read_at || null,
  admin_read_at: ticket.admin_read_at || null,
  ...(withThread ? { messages: threadOf(ticket) } : {}),
});

// Messages from `side` that landed after the other side last read the thread. Drives the
// unread badge without a per-message read flag.
const unreadFor = (ticket, viewer) => {
  const watermark = viewer === 'admin' ? ticket.admin_read_at : ticket.customer_read_at;
  const fromOther = viewer === 'admin' ? 'customer' : 'admin';
  const messages = ticket.Messages || [];

  // The ticket's opening message is itself a customer message an admin may not have read.
  const opening = fromOther === 'customer'
    && (!watermark || new Date(ticket.createdAt) > new Date(watermark)) ? 1 : 0;

  return opening + messages.filter((m) => m.sender === fromOther
    && (!watermark || new Date(m.created_at || m.createdAt) > new Date(watermark))).length;
};

/**
 * What to call this thing in a message the caller will read.
 *
 * Support staff call these tickets and the admin console says "ticket" throughout; the
 * storefront calls them queries end to end ("Query Us", "Raise Query", "My Queries").
 * getTicket and addMessage serve BOTH sides from one handler, so the noun is chosen from
 * the caller's role rather than hard-coded — otherwise one audience is always shown the
 * other's vocabulary. Takes `req` (not a boolean) so it is safe to call from a catch block,
 * where the handler's own `isAdmin` is out of scope.
 */
const noun = (req) => (req.userRole === 'admin' ? 'ticket' : 'query');
const Noun = (req) => (req.userRole === 'admin' ? 'Ticket' : 'Query');

exports.TICKET_CATEGORIES = TICKET_CATEGORIES;
exports.TICKET_STATUSES = TICKET_STATUSES;
exports.MAX_ATTACHMENTS = MAX_ATTACHMENTS;

/**
 * Signed Cloudinary upload credentials for support photos.
 *
 * The browser uploads straight to Cloudinary; this endpoint is what makes that safe — the
 * API secret never leaves the server, and the signature it returns is scoped to one folder.
 * Behind auth for the same reason: an open signature endpoint is an open upload bucket.
 * Both sides use it, so support staff can attach photos to a reply too.
 */
exports.getUploadSignature = (req, res) => {
  if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
  const signature = generateUploadSignature('vns-saree/support');
  return res.json({ ...signature, resourceType: 'image' });
};

exports.createTicket = async (req, res) => {
  try {
    if (!req.user?.id || req.userRole === 'admin') {
      return res.status(401).json({ message: 'Customer authentication required' });
    }

    const { orderId, category, message, phone } = req.body;
    // The storefront no longer collects a category. Absent means DEFAULT_CATEGORY; a value
    // that IS sent still has to be one of the known ones.
    const cleanCategory = String(category || '').trim() || DEFAULT_CATEGORY;
    const cleanMessage = String(message || '').trim();
    const attachments = sanitizeAttachments(req.body.attachments);

    // Customer-facing copy says "query", not "ticket" — the storefront calls this a query
    // end to end (My Orders shows "Query Us" / "Raise Query"), and these messages are shown
    // to the customer verbatim as a toast. Admin-facing responses further down keep "ticket",
    // which is what support staff and the admin console call it.
    if (!orderId) return res.status(400).json({ message: 'An order is required to raise a query.' });
    if (!TICKET_CATEGORIES.includes(cleanCategory)) {
      return res.status(400).json({ message: 'That query type is not recognised.' });
    }
    if (cleanMessage.length < 10) {
      return res.status(400).json({ message: 'Please describe your issue in a little more detail.' });
    }
    if (cleanMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ message: `Please keep your message under ${MAX_MESSAGE_LENGTH} characters.` });
    }

    const order = await findOwnedOrder(orderId, req.user);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // One OPEN ticket per order — not one ticket per order ever.
    //
    // While a thread is live (Open / In Progress / Resolved), a follow-up belongs on it, not
    // in a new ticket: otherwise the same conversation fragments and neither the customer nor
    // support can see the whole story in one place. Resolved is deliberately included — a
    // customer replying "that didn't work" should land back in the original thread.
    //
    // But a CLOSED thread cannot be replied to (see isThreadClosed in the reply handler), so
    // matching on it regardless of status left the customer with no route at all: no reply,
    // no new ticket. A saree that arrives damaged a week after a shipping query was closed is
    // a genuinely new issue and deserves its own thread.
    const existing = await SupportTicket.findOne({
      where: { order_id: order.id, status: { [Op.ne]: 'Closed' } },
      order: [['id', 'DESC']],
    });
    if (existing) {
      return res.status(409).json({
        message: `You already have an open query (${existing.ticket_number}) for this order — continue the conversation there.`,
        ticket: publicTicket(existing),
      });
    }

    const ticket = await SupportTicket.create({
      order_id: order.id,
      customer_id: req.user.id,
      name: req.user.name || order.customer_name,
      email: req.user.email || order.customer_email,
      phone: normalizePhone(phone) || null,
      category: cleanCategory,
      message: cleanMessage,
      attachments,
      status: 'Open',
    });
    await ticket.update({ ticket_number: `TKT${String(ticket.id).padStart(6, '0')}` });

    // Support must hear about it; the customer gets a receipt. Neither failing is a
    // reason to lose the ticket that is already saved.
    EmailService.sendSupportTicketRaised(ticket, order).catch((error) => {
      console.error('SupportController: ticket email failed:', error.message);
    });

    // Admin inbox only — the customer who raised it already has it on screen.
    Realtime.emitTicketCreated({
      ...publicTicket(ticket),
      name: ticket.name,
      email: ticket.email,
      Order: { id: order.id, order_number: order.order_number },
      message_count: 1,
      awaiting_reply: true,
    });

    return res.status(201).json({
      success: true,
      message: `Query ${ticket.ticket_number} raised. Our support team will reach out soon.`,
      ticket: publicTicket(ticket),
    });
  } catch (error) {
    console.error('SupportController.createTicket error:', error);
    return res.status(500).json({ message: 'Unable to raise your query right now. Please try again.' });
  }
};

// Every ticket the logged-in customer has raised. My Orders uses ?orderId= to show the live
// status on the order it belongs to; the Tickets page lists them all.
exports.listMyTickets = async (req, res) => {
  try {
    if (!req.user?.id || req.userRole === 'admin') {
      return res.status(401).json({ message: 'Customer authentication required' });
    }
    const where = { customer_id: req.user.id };
    if (req.query.orderId) where.order_id = req.query.orderId;

    const tickets = await SupportTicket.findAll({
      where,
      include: [{ model: Order, attributes: ['id', 'order_number'] }],
      order: [['createdAt', 'DESC']],
    });
    return res.json(tickets.map((ticket) => publicTicket(ticket)));
  } catch (error) {
    console.error('SupportController.listMyTickets error:', error);
    return res.status(500).json({ message: 'Unable to fetch your queries.' });
  }
};

// One ticket with its full conversation. Customers may only open their own.
exports.getTicket = async (req, res) => {
  try {
    const isAdmin = req.userRole === 'admin';
    const where = { id: req.params.id };
    if (!isAdmin) {
      if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
      where.customer_id = req.user.id;
    }

    const ticket = await SupportTicket.findOne({
      where,
      include: [
        { model: Order, attributes: ['id', 'order_number', 'status', 'payment_method'] },
        { model: SupportTicketMessage, as: 'Messages' },
      ],
      order: [[{ model: SupportTicketMessage, as: 'Messages' }, 'created_at', 'ASC']],
    });
    if (!ticket) return res.status(404).json({ message: `${Noun(req)} not found` });

    // Fetching the thread is itself a delivery: these messages are now on this side's
    // client. Covers the case where the reader never opens a stream at all.
    markDelivered(ticket.id, req.userRole === 'admin' ? 'customer' : 'admin');

    return res.json(publicTicket(ticket, { withThread: true }));
  } catch (error) {
    console.error('SupportController.getTicket error:', error);
    return res.status(500).json({ message: `Unable to fetch this ${noun(req)}.` });
  }
};

// Post a follow-up. The same handler serves both sides — who is speaking comes from the
// authenticated role, never from the request body.
exports.addMessage = async (req, res) => {
  try {
    const isAdmin = req.userRole === 'admin';
    if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });

    const cleanMessage = String(req.body.message || '').trim();
    const attachments = sanitizeAttachments(req.body.attachments);
    // A photo on its own is a complete message — "here is what arrived damaged" needs no
    // caption. Only a message with neither text nor an image is rejected.
    if (!cleanMessage && !attachments.length) {
      return res.status(400).json({ message: 'Please type a message or attach a photo.' });
    }
    if (cleanMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ message: `Please keep your message under ${MAX_MESSAGE_LENGTH} characters.` });
    }

    const where = { id: req.params.id };
    if (!isAdmin) where.customer_id = req.user.id;

    const ticket = await SupportTicket.findOne({ where, include: [{ model: Order }] });
    if (!ticket) return res.status(404).json({ message: `${Noun(req)} not found` });

    if (isThreadClosed(ticket)) {
      return res.status(409).json({
        message: `This ${noun(req)} is closed. Please raise a new one if you still need help.`,
      });
    }

    const sender = isAdmin ? 'admin' : 'customer';
    // Double-submit guard. Skipped when photos are attached: two image messages sent in
    // quick succession legitimately share the same (often empty) text, and collapsing them
    // would silently swallow the second batch of photos.
    const recent = attachments.length ? null : await SupportTicketMessage.findOne({
      where: {
        ticket_id: ticket.id,
        sender,
        message: cleanMessage,
        createdAt: { [Op.gte]: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
    });
    if (recent) return res.status(201).json({ success: true, message: publicMessage(recent) });

    // If the recipient already has a live connection, this message reaches their browser
    // in the same breath as it is saved — so it is delivered on arrival (✓✓ immediately,
    // no round trip). An admin sitting on the Tickets page is the common case.
    const deliveredNow = Realtime.recipientIsPresent(sender, ticket.id) ? new Date() : null;

    const row = await SupportTicketMessage.create({
      ticket_id: ticket.id,
      sender,
      sender_name: isAdmin ? (req.user.name || 'Banarasi Kala Support') : ticket.name,
      message: cleanMessage,
      attachments,
      delivered_at: deliveredNow,
    });

    // An admin replying to an Open ticket moves it along on its own — support has picked it
    // up. A customer replying never changes the status; that stays the admin's call.
    if (isAdmin && ticket.status === 'Open') {
      await ticket.update({ status: 'In Progress' });
    }
    // Bump the ticket so "last activity" ordering is honest even though the reply lives on
    // another table.
    await ticket.changed('updatedAt', true);
    await ticket.save({ silent: false });

    if (isAdmin) {
      // An image-only reply has no text to quote, so the email says what arrived instead of
      // going out with an empty body.
      const emailBody = cleanMessage
        || `${attachments.length} photo${attachments.length === 1 ? '' : 's'} attached — open the ${noun(req)} to view.`;
      EmailService.sendSupportTicketReply(ticket, ticket.Order, emailBody).catch((error) => {
        console.error('SupportController: reply email failed:', error.message);
      });
    }

    // Push to anyone watching this thread, and to the admin inbox. Sending necessarily means
    // you have stopped typing — clear it first, or the indicator lingers underneath the
    // message that just arrived.
    Realtime.clearTyping({ ticketId: ticket.id, side: sender });
    Realtime.emitMessage(ticket.id, publicMessage(row));
    if (isAdmin && ticket.status === 'In Progress') {
      Realtime.emitStatusChange(ticket.id, 'In Progress', !isThreadClosed(ticket));
    }

    return res.status(201).json({ success: true, message: publicMessage(row) });
  } catch (error) {
    console.error('SupportController.addMessage error:', error);
    return res.status(500).json({ message: 'Unable to send your message right now.' });
  }
};

exports.listTickets = async (req, res) => {
  try {
    const where = {};
    if (req.query.status && req.query.status !== 'all') where.status = req.query.status;
    if (req.query.open === 'true') where.status = { [Op.in]: OPEN_STATUSES };

    const tickets = await SupportTicket.findAll({
      where,
      include: [
        {
          model: Order,
          attributes: ['id', 'order_number', 'status', 'payment_method', 'customer_name', 'customer_email'],
        },
        { model: SupportTicketMessage, as: 'Messages', attributes: ['id', 'sender', 'created_at'] },
      ],
      // The Messages order matters: awaiting_reply is read off the LAST one.
      order: [
        ['updated_at', 'DESC'],
        [{ model: SupportTicketMessage, as: 'Messages' }, 'created_at', 'ASC'],
      ],
    });

    return res.json(tickets.map((ticket) => {
      const messages = ticket.Messages || [];
      const last = messages[messages.length - 1] || null;
      return {
        ...publicTicket(ticket),
        name: ticket.name,
        email: ticket.email,
        phone: ticket.phone,
        Order: ticket.Order,
        message_count: messages.length + 1, // + the opening message on the ticket itself
        // Whose turn it is: the customer spoke last and nobody has answered.
        awaiting_reply: !last || last.sender === 'customer',
        // Drives the per-row unread badge in the admin inbox.
        unread_count: unreadFor(ticket, 'admin'),
      };
    }));
  } catch (error) {
    console.error('SupportController.listTickets error:', error);
    return res.status(500).json({ message: 'Unable to fetch tickets.' });
  }
};

// Admin-only: move the ticket along its lifecycle. Replies are messages (addMessage), not
// status changes, so this only ever touches the status.
exports.updateTicket = async (req, res) => {
  try {
    const ticket = await SupportTicket.findByPk(req.params.id, { include: [{ model: Order }] });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    const { status } = req.body;
    if (!TICKET_STATUSES.includes(status)) {
      return res.status(400).json({ message: `Status must be one of: ${TICKET_STATUSES.join(', ')}` });
    }

    await ticket.update({
      status,
      resolved_at: status === 'Resolved' || status === 'Closed' ? new Date() : null,
    });

    // The customer's composer must disable itself the moment support closes the thread —
    // otherwise they type a reply into a box that will reject it.
    Realtime.emitStatusChange(ticket.id, status, !isThreadClosed(ticket));

    if (status === 'Resolved' || status === 'Closed') {
      EmailService.sendSupportTicketUpdate(ticket, ticket.Order).catch((error) => {
        console.error('SupportController: ticket update email failed:', error.message);
      });
    }

    return res.json({ success: true, ticket: publicTicket(ticket) });
  } catch (error) {
    console.error('SupportController.updateTicket error:', error);
    return res.status(500).json({ message: 'Unable to update the ticket.' });
  }
};

// ── Realtime ──────────────────────────────────────────────────────────────────────────
// Everything below powers the live thread and the live admin inbox. See
// services/SupportRealtime.js for why this is SSE and not WebSockets, and for the
// single-instance caveat.

/**
 * Mint a short-lived credential for the SSE connection.
 *
 * EventSource cannot set an Authorization header, so the stream itself cannot carry the
 * normal Bearer token. This endpoint CAN (it is a normal POST behind authMiddleware), so
 * the client trades its real JWT for a 60-second single-use token and puts that in the
 * stream URL instead. See issueStreamTicket for the reasoning.
 */
exports.streamTicket = async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
  return res.json({
    token: Realtime.issueStreamTicket({ userId: req.user.id, role: req.userRole || 'customer' }),
  });
};

/**
 * The SSE stream.
 *
 * Customers subscribe to ONE ticket (theirs, ownership verified below). Admins subscribe to
 * the shared inbox firehose and filter client-side.
 *
 * Auth is the stream ticket in the query string — this route is deliberately NOT behind
 * authMiddleware, because the browser cannot send the header here.
 */
exports.stream = async (req, res) => {
  const identity = Realtime.redeemStreamTicket(req.query.token);
  if (!identity) return res.status(401).json({ message: 'Invalid or expired stream token.' });

  const isAdmin = identity.role === 'admin';
  const ticketId = req.params.id ? Number(req.params.id) : null;

  // Ownership: a customer may only ever stream a ticket that is theirs. Without this,
  // any signed-in customer could stream any ticket id and read another person's support
  // conversation — which contains order numbers, names and complaint details.
  if (!isAdmin) {
    if (!ticketId) return res.status(400).json({ message: 'A ticket is required.' });
    const owned = await SupportTicket.findOne({
      where: { id: ticketId, customer_id: identity.userId },
      attributes: ['id'],
    });
    if (!owned) return res.status(404).json({ message: 'Ticket not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx must not buffer a stream
  res.flushHeaders?.();

  const send = (payload) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: 'connected' });

  // Channel follows the ROUTE, not the role: /stream/admin is the inbox firehose,
  // /tickets/:id/stream is one thread. An admin with a thread open wants that thread's
  // events, not every ticket in the system.
  const channel = ticketId ? Realtime.ticketChannel(ticketId) : Realtime.ADMIN_CHANNEL;
  const unsubscribe = Realtime.subscribe(channel, send);

  // Presence drives the middle tick — see SupportRealtime. Registered against the side
  // that is watching, so a message written while they're connected is delivered on arrival.
  const side = isAdmin ? 'admin' : 'customer';
  Realtime.addPresence(side, ticketId);

  // Anything the other side sent before this connection opened has now reached us too.
  // For the admin inbox (no ticketId) this is skipped: sweeping every open ticket on each
  // connect would be an unbounded query, and the per-ticket stream covers it when a thread
  // is actually opened.
  if (ticketId) {
    markDelivered(ticketId, isAdmin ? 'customer' : 'admin');
  }

  // Idle proxies and load balancers close a connection with no traffic, typically at 60s.
  // A comment line is a valid SSE no-op that keeps it alive without reaching the client's
  // message handler.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 25000);

  let cleanedUp = false;
  const cleanup = () => {
    // 'close' and 'error' can both fire — without this guard the presence count would be
    // decremented twice and the recipient would look absent while still connected.
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    unsubscribe();
    Realtime.dropPresence(side, ticketId);
    if (!res.writableEnded) res.end();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
};

/**
 * "X is typing" — ephemeral, never persisted.
 *
 * The client pings this while the composer has focus and text; the server re-arms a short
 * TTL. Nothing is written to the database, because the fact is worthless a second later.
 */
exports.typing = async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
  const isAdmin = req.userRole === 'admin';

  const where = { id: req.params.id };
  if (!isAdmin) where.customer_id = req.user.id;
  const ticket = await SupportTicket.findOne({ where, attributes: ['id', 'name'] });
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

  Realtime.setTyping({
    ticketId: ticket.id,
    side: isAdmin ? 'admin' : 'customer',
    name: isAdmin ? (req.user.name || 'Support') : ticket.name,
  });
  return res.status(204).end();
};

/**
 * Mark the thread read up to now, and tell the other side.
 *
 * A per-side watermark rather than a flag per message: one write on open instead of N, and
 * it answers the unread-badge question for free (messages from the other side newer than
 * my watermark).
 */
exports.markRead = async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
    const isAdmin = req.userRole === 'admin';

    const where = { id: req.params.id };
    if (!isAdmin) where.customer_id = req.user.id;
    const ticket = await SupportTicket.findOne({ where });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    const readAt = new Date();
    // silent: this is a read receipt, not activity — bumping updated_at would reorder the
    // admin inbox (sorted by updated_at DESC) every time someone merely opened a thread.
    await ticket.update(
      isAdmin ? { admin_read_at: readAt } : { customer_read_at: readAt },
      { silent: true },
    );

    Realtime.emitRead(ticket.id, isAdmin ? 'admin' : 'customer', readAt);
    return res.json({ success: true, read_at: readAt });
  } catch (error) {
    console.error('SupportController.markRead error:', error);
    return res.status(500).json({ message: 'Unable to update read status.' });
  }
};
