const { Op } = require('sequelize');
const SupportConversation = require('../models/SupportConversation');
const SupportTopic = require('../models/SupportTopic');
const SupportMessage = require('../models/SupportMessage');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const EmailService = require('../services/EmailService');
const Realtime = require('../services/SupportRealtime');
const { loadOrderCard } = require('../services/SupportOrderCard');
const { generateUploadSignature } = require('../config/cloudinary');

/**
 * Support chat.
 *
 * One conversation per customer, for life — the relationship is the unit. Inside it, one
 * TOPIC per order (see models/SupportTopic): every message names its topic outright, and each
 * topic carries its own status, so the torn saree can be resolved while the missing parcel
 * stays open.
 *
 * The customer sees one topic at a time — opening support from an order shows that order's
 * strand and nothing else. Support sees either: one strand, or the whole relationship in
 * order, which is the view a ticket queue could never give them.
 *
 * The same handlers serve both sides where the logic is identical — who is speaking always
 * comes from the authenticated role, never from the request body.
 */

const STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
// Statuses that mean "we consider this handled". A customer writing again reopens the topic:
// there is no second thread for them to start, so a settled strand has to be able to wake up.
const SETTLED = new Set(['Resolved', 'Closed']);

const MAX_MESSAGE_LENGTH = 2000;
const MAX_ATTACHMENTS = 5;

// A double-submit (impatient click, retried request) must not create a second row — the same
// text on the same topic inside this window is treated as the one message it is.
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

// Uploads go straight from the browser to Cloudinary (signed), so the server only ever
// receives the resulting URL. This is the one shape it will store or serve.
const CLOUDINARY_URL = /^https:\/\/res\.cloudinary\.com\//i;

/**
 * Sanitise an attachments array arriving from a client.
 *
 * The upload goes browser -> Cloudinary directly, which means the server only ever sees URLs
 * — and must not trust them. Anything that is not an https Cloudinary URL is discarded, and
 * only url/public_id are kept, so a caller cannot smuggle extra keys or a `javascript:` URL
 * into a column that later ends up inside an <img src> on the admin console.
 *
 * Re-applied on the way OUT as well as in: the column is JSONB, so rows written by anything
 * other than this controller are not guaranteed to hold the shape it claims to return.
 */
const sanitizeAttachments = (value) => (Array.isArray(value) ? value : [])
  .filter((item) => item && typeof item.url === 'string' && CLOUDINARY_URL.test(item.url))
  .slice(0, MAX_ATTACHMENTS)
  .map((item) => ({
    url: item.url,
    public_id: String(item.public_id || '').slice(0, 255),
  }));

const normalizePhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  const stripped = digits.replace(/^(91|0)+/, '');
  return stripped.length > 10 ? stripped.slice(-10) : stripped;
};

const publicMessage = (row) => ({
  id: row.id,
  topic_id: row.topic_id,
  sender: row.sender,
  sender_name: row.sender_name,
  type: row.type,
  body: row.body,
  attachments: sanitizeAttachments(row.attachments),
  // Drives the middle tick. Read (blue) is derived client-side from the conversation's read
  // watermark, so it isn't repeated per message.
  delivered_at: row.delivered_at || null,
  createdAt: row.createdAt,
});

const publicTopic = (topic) => ({
  id: topic.id,
  order_id: topic.order_id,
  order: topic.order_snapshot || null,
  status: topic.status,
  last_message_at: topic.last_message_at,
  createdAt: topic.createdAt,
});

const publicConversation = (conversation) => ({
  id: conversation.id,
  createdAt: conversation.createdAt,
  last_message_at: conversation.last_message_at,
  // Read receipts. `*_read_at` is when THAT side last opened the chat; each client uses the
  // other side's watermark to turn its own ticks blue. Deliberately per CONVERSATION and not
  // per topic: they describe a person's attention, and a person reads a screen, not a strand.
  customer_read_at: conversation.customer_read_at || null,
  admin_read_at: conversation.admin_read_at || null,
});

// Messages from the other side that landed after `viewer` last read. Drives the unread badge
// without a per-message read flag. System lines are excluded — nobody owes the machine a read.
const unreadFor = (conversation, messages, viewer) => {
  const watermark = viewer === 'admin' ? conversation.admin_read_at : conversation.customer_read_at;
  const fromOther = viewer === 'admin' ? 'customer' : 'admin';
  return (messages || []).filter((m) => m.sender === fromOther
    && (!watermark || new Date(m.created_at || m.createdAt) > new Date(watermark))).length;
};

/**
 * Mark every message from `fromSide` as delivered, and tell the sender.
 *
 * Called when the OTHER side's client connects or loads the chat — that is the moment the
 * messages genuinely reached their browser. Idempotent: only rows still null are touched, so
 * a reconnect loop can't churn the table or re-emit.
 */
const markDelivered = async (conversationId, fromSide) => {
  try {
    const deliveredAt = new Date();
    const pending = await SupportMessage.findAll({
      where: { conversation_id: conversationId, sender: fromSide, delivered_at: null },
      attributes: ['id'],
    });
    if (!pending.length) return;

    const ids = pending.map((row) => row.id);
    await SupportMessage.update(
      { delivered_at: deliveredAt },
      { where: { id: ids }, silent: true },
    );
    Realtime.emitDelivered(conversationId, ids, deliveredAt);
  } catch (error) {
    // A delivery receipt is cosmetic — never let it break the stream it rides on.
    console.error('SupportController.markDelivered error:', error.message);
  }
};

const findConversation = (customerId) => SupportConversation.findOne({
  where: { customer_id: customerId },
});

/**
 * Find this customer's conversation, or open one.
 *
 * Only ever called from a write path. Opening the chat to read must NOT create a row: an
 * inbox full of customers who opened support, looked, and closed it again is worse than an
 * empty one — every blank row costs an agent the time to check it.
 *
 * The unique constraint on customer_id is the real guard: two tabs sending a first message at
 * once both reach this, and the loser of that race gets a constraint violation rather than a
 * second conversation. Re-reading on failure resolves it to the row that won.
 */
const openConversation = async (user) => {
  const existing = await findConversation(user.id);
  if (existing) return existing;

  try {
    return await SupportConversation.create({
      customer_id: user.id,
      name: user.name || 'Customer',
      email: user.email,
      phone: normalizePhone(user.phone) || null,
    });
  } catch (error) {
    const raced = await findConversation(user.id);
    if (raced) return raced;
    throw error;
  }
};

/**
 * The strand a message belongs to.
 *
 * `orderId` null means the general strand — someone asking a question that is not about any
 * order. Ownership is checked here and nowhere else: a customer may only ever open a topic on
 * an order that is theirs, and the card is built from the database rather than accepted from
 * the client, because that card is what an agent reads before authorising a refund.
 *
 * Guest orders (customer_id null) match on email, the same rule the order endpoints use.
 */
const resolveTopic = async (conversation, user, orderId) => {
  let ownedOrderId = null;

  if (orderId) {
    const owned = await Order.findOne({
      where: {
        id: orderId,
        [Op.or]: [
          { customer_id: user.id },
          { customer_id: null, customer_email: user.email },
        ],
      },
      attributes: ['id'],
    });
    // An order that is not theirs falls back to the general strand rather than erroring: the
    // message is still worth having, it just does not get filed against someone else's order.
    if (owned) ownedOrderId = owned.id;
  }

  const existing = await SupportTopic.findOne({
    where: { conversation_id: conversation.id, order_id: ownedOrderId },
  });
  if (existing) return existing;

  const card = ownedOrderId ? await loadOrderCard(ownedOrderId) : null;
  try {
    return await SupportTopic.create({
      conversation_id: conversation.id,
      order_id: ownedOrderId,
      order_snapshot: card ? card.snapshot : null,
      status: 'Open',
    });
  } catch (error) {
    // Same race as the conversation: two tabs opening the same strand at once. The unique
    // index decides, and the loser re-reads the winner's row.
    const raced = await SupportTopic.findOne({
      where: { conversation_id: conversation.id, order_id: ownedOrderId },
    });
    if (raced) return raced;
    throw error;
  }
};

// System lines are messages, not metadata: they render in the strand where they happened,
// which is the whole reason the customer ever sees a status change at all.
const writeSystemLine = async (topic, body) => {
  const row = await SupportMessage.create({
    conversation_id: topic.conversation_id,
    topic_id: topic.id,
    sender: 'system',
    type: 'status',
    body,
    attachments: [],
  });
  Realtime.emitMessage(topic.conversation_id, publicMessage(row));
  return row;
};

exports.STATUSES = STATUSES;
exports.MAX_ATTACHMENTS = MAX_ATTACHMENTS;

/**
 * Signed Cloudinary upload credentials for support photos.
 *
 * The browser uploads straight to Cloudinary; this endpoint is what makes that safe — the API
 * secret never leaves the server, and the signature it returns is scoped to one folder. Behind
 * auth for the same reason: an open signature endpoint is an open upload bucket. Both sides
 * use it, so support can attach photos to a reply too.
 */
exports.getUploadSignature = (req, res) => {
  if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
  const signature = generateUploadSignature('vns-saree/support');
  return res.json({ ...signature, resourceType: 'image' });
};

// ── Customer ──────────────────────────────────────────────────────────────────────────

/**
 * The customer's chat.
 *
 * `?orderId=` scopes it to one strand — which is what the sheet on an order opens. Without it
 * the whole relationship comes back, which is what /support shows. Either way the topics are
 * listed, so the client can offer the strand switcher without a second request.
 *
 * Returns a renderable empty shape rather than a 404 when they have never written: "you have
 * no support history" is not an error, and the client should not special-case its first
 * message.
 */
exports.getMyConversation = async (req, res) => {
  try {
    if (!req.user?.id || req.userRole === 'admin') {
      return res.status(401).json({ message: 'Customer authentication required' });
    }

    const conversation = await findConversation(req.user.id);
    if (!conversation) {
      return res.json({
        id: null, topics: [], messages: [], topic: null,
        customer_read_at: null, admin_read_at: null, last_message_at: null, unread_count: 0,
      });
    }

    const topics = await SupportTopic.findAll({
      where: { conversation_id: conversation.id },
      order: [['last_message_at', 'DESC NULLS LAST'], ['id', 'DESC']],
    });

    /**
     * Two ways to name a strand, because the callers know different things.
     *
     * `orderId` is for the sheet opened from an order: it knows the order and nothing else,
     * and requiring it to discover a topic id first would be a round trip to learn a number
     * it only needs to hand straight back. `topicId` is for the /support list, which has
     * already been given the topics and is the only caller that can address the general
     * strand — that one has no order to name it by.
     *
     * Neither means "everything", which is what the list view itself renders.
     */
    const orderId = req.query.orderId ? Number(req.query.orderId) : null;
    const topicId = req.query.topicId ? Number(req.query.topicId) : null;

    const scoped = topicId
      ? topics.find((t) => t.id === topicId) || null
      : (orderId ? topics.find((t) => Number(t.order_id) === orderId) || null : null);

    // A strand that does not exist yet is not an error — the customer opened support on an
    // order they have never written about. Scoped and empty is the honest answer; the client
    // renders its own pending card and the first message brings the strand into being.
    const scopeRequested = Boolean(orderId || topicId);
    const messages = await SupportMessage.findAll({
      where: {
        conversation_id: conversation.id,
        ...(scopeRequested ? { topic_id: scoped ? scoped.id : -1 } : {}),
      },
      order: [['created_at', 'ASC'], ['id', 'ASC']],
    });

    // Loading the chat is itself a delivery: support's messages are now on this client.
    markDelivered(conversation.id, 'admin');

    return res.json({
      ...publicConversation(conversation),
      topics: topics.map(publicTopic),
      // The strand being shown, if scoped. Null when the customer opened an order they have
      // never written about — the client renders its own pending card from what it knows.
      topic: scoped ? publicTopic(scoped) : null,
      messages: messages.map(publicMessage),
      unread_count: unreadFor(conversation, messages, 'customer'),
    });
  } catch (error) {
    console.error('SupportController.getMyConversation error:', error);
    return res.status(500).json({ message: 'Unable to load your support chat.' });
  }
};

/**
 * Unread count only — for the header badge, which every page mounts.
 *
 * A separate endpoint rather than a flag on the full fetch: the badge needs one number, and
 * making every page pull an entire conversation to render it would be the most expensive
 * thing on the site.
 */
exports.getMyUnreadCount = async (req, res) => {
  try {
    if (!req.user?.id || req.userRole === 'admin') {
      return res.json({ unread_count: 0, conversation_id: null });
    }

    const conversation = await SupportConversation.findOne({
      where: { customer_id: req.user.id },
      attributes: ['id', 'customer_read_at'],
    });
    // Null for someone who has never written, and the client uses that to know there is no
    // stream to open yet — otherwise every signed-in customer who has never contacted support
    // would hold a reconnect loop against an endpoint that can only 404.
    if (!conversation) return res.json({ unread_count: 0, conversation_id: null });

    const unread_count = await SupportMessage.count({
      where: {
        conversation_id: conversation.id,
        sender: 'admin',
        ...(conversation.customer_read_at
          ? { created_at: { [Op.gt]: conversation.customer_read_at } }
          : {}),
      },
    });
    return res.json({ unread_count, conversation_id: conversation.id });
  } catch (error) {
    console.error('SupportController.getMyUnreadCount error:', error);
    return res.json({ unread_count: 0, conversation_id: null });
  }
};

// ── Sending ───────────────────────────────────────────────────────────────────────────

const readDraft = (req) => ({
  body: String(req.body.message || '').trim(),
  attachments: sanitizeAttachments(req.body.attachments),
});

/**
 * Validate before anything is written.
 *
 * Split out so the customer path can check it BEFORE opening a conversation. Opening one for
 * a message that then fails validation would leave a customer sitting in the support inbox
 * having said nothing.
 *
 * @returns {string|null} The message to show the sender, or null when the draft is fine.
 */
const draftError = ({ body, attachments }) => {
  // A photo on its own is a complete message — "here is what arrived damaged" needs no
  // caption. Only a message with neither text nor an image is rejected.
  if (!body && !attachments.length) return 'Please type a message or attach a photo.';
  if (body.length > MAX_MESSAGE_LENGTH) {
    return `Please keep your message under ${MAX_MESSAGE_LENGTH} characters.`;
  }
  return null;
};

/** Post a message into a topic. Both sides land here; the role decides who is speaking. */
const postMessage = async (req, res, { conversation, topic, isAdmin }) => {
  const { body, attachments } = readDraft(req);
  const invalid = draftError({ body, attachments });
  if (invalid) return res.status(400).json({ message: invalid });

  const sender = isAdmin ? 'admin' : 'customer';

  // Double-submit guard. Skipped when photos are attached: two image messages sent in quick
  // succession legitimately share the same (often empty) text, and collapsing them would
  // silently swallow the second batch of photos.
  const recent = attachments.length ? null : await SupportMessage.findOne({
    where: {
      topic_id: topic.id,
      sender,
      type: 'text',
      body,
      created_at: { [Op.gte]: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    },
  });
  if (recent) {
    return res.status(201).json({ success: true, topic: publicTopic(topic), message: publicMessage(recent) });
  }

  // If the recipient already has a live connection, this reaches their browser in the same
  // breath as it is saved — so it is delivered on arrival (✓✓ immediately, no round trip).
  const deliveredNow = Realtime.recipientIsPresent(sender, conversation.id) ? new Date() : null;

  const row = await SupportMessage.create({
    conversation_id: conversation.id,
    topic_id: topic.id,
    sender,
    sender_name: isAdmin ? (req.user.name || 'Banarasi Kala Support') : conversation.name,
    type: 'text',
    body: body || null,
    attachments,
    delivered_at: deliveredNow,
  });

  /**
   * Status transitions the message itself implies, applied to THIS strand only.
   *
   * A customer writing into a settled strand reopens that strand — there is no second thread
   * to start, so the alternative is a message nobody is assigned to answer. An admin replying
   * to an Open strand moves it along: support has picked it up. Neither touches the other
   * orders, which is the entire point of the topic carrying its own status.
   */
  const previousStatus = topic.status;
  let nextStatus = previousStatus;
  if (!isAdmin && SETTLED.has(previousStatus)) nextStatus = 'Open';
  else if (isAdmin && previousStatus === 'Open') nextStatus = 'In Progress';

  await topic.update({ status: nextStatus, last_message_at: row.createdAt });
  await conversation.update({ last_message_at: row.createdAt });

  // Sending necessarily means you have stopped typing — clear it before the broadcast, or the
  // indicator lingers underneath the message that just arrived.
  Realtime.clearTyping({ conversationId: conversation.id, side: sender });
  Realtime.emitMessage(conversation.id, publicMessage(row));

  if (nextStatus !== previousStatus) {
    // Only the customer's reopen earns a line in the thread. An admin reply moving Open to In
    // Progress is bookkeeping the customer has no use for — they can see the reply.
    if (!isAdmin) await writeSystemLine(topic, 'Conversation reopened');
    Realtime.emitStatusChange(conversation.id, topic.id, nextStatus);
  }

  /**
   * Email only ever travels one way: outward, to the customer.
   *
   * They are usually not on the site when support answers, so a reply that only existed in
   * the chat would go unseen for hours. Support is the opposite case — they live in the admin
   * console, where a customer message already arrives as a live row, a toast and an unread
   * badge. Mailing them as well turned every message in a back-and-forth into an inbox item
   * about something they were already looking at.
   */
  if (isAdmin) {
    const text = body || `${attachments.length} photo${attachments.length === 1 ? '' : 's'} attached`;
    EmailService.sendSupportReplyToCustomer(conversation, text).catch((error) => {
      console.error('SupportController: reply email failed:', error.message);
    });
  }

  return res.status(201).json({
    success: true,
    conversation_id: conversation.id,
    topic: publicTopic(topic),
    message: publicMessage(row),
  });
};

exports.sendMyMessage = async (req, res) => {
  try {
    if (!req.user?.id || req.userRole === 'admin') {
      return res.status(401).json({ message: 'Customer authentication required' });
    }

    // Checked BEFORE anything is opened. A rejected first message must not leave a customer
    // in the support inbox having said nothing.
    const invalid = draftError(readDraft(req));
    if (invalid) return res.status(400).json({ message: invalid });

    const existed = await findConversation(req.user.id);
    const conversation = existed || await openConversation(req.user);
    const topic = await resolveTopic(conversation, req.user, req.body.orderId);
    const isNewTopic = !topic.last_message_at;

    await postMessage(req, res, { conversation, topic, isAdmin: false });

    // A customer who has never written before is a new row in the inbox; a new strand on an
    // existing customer is a new chip on the row they already have. Emitted after the message
    // so the admin's list has something to show on arrival.
    if (res.statusCode === 201 && (!existed || isNewTopic)) {
      Realtime.emitConversationStarted({
        ...publicConversation(conversation),
        name: conversation.name,
        email: conversation.email,
        phone: conversation.phone,
        is_new_customer: !existed,
        topic: publicTopic(topic),
        preview: readDraft(req).body.slice(0, 140),
      });
    }
    return undefined;
  } catch (error) {
    console.error('SupportController.sendMyMessage error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Unable to send your message right now.' });
    }
    return undefined;
  }
};

// ── Receipts ──────────────────────────────────────────────────────────────────────────

/**
 * Mark the chat read up to now, and tell the other side.
 *
 * Per SIDE, not per topic. A watermark describes a person's attention, and a person reads a
 * screen — splitting it per strand would mean the customer who opened one order's chat had
 * somehow not seen the reply sitting in another.
 */
const markRead = async (conversation, isAdmin) => {
  const readAt = new Date();
  // silent: a read receipt is not activity. Bumping updated_at would reorder the admin inbox
  // every time someone merely opened a chat — and last_message_at, which the inbox actually
  // sorts by, is deliberately untouched here.
  await conversation.update(
    isAdmin ? { admin_read_at: readAt } : { customer_read_at: readAt },
    { silent: true },
  );
  Realtime.emitRead(conversation.id, isAdmin ? 'admin' : 'customer', readAt);
  return readAt;
};

exports.markMyRead = async (req, res) => {
  try {
    if (!req.user?.id || req.userRole === 'admin') {
      return res.status(401).json({ message: 'Customer authentication required' });
    }
    const conversation = await findConversation(req.user.id);
    // Nothing to mark read is a success, not a 404 — the client fires this on open and has no
    // way to know whether a conversation exists yet.
    if (!conversation) return res.json({ success: true, read_at: null });

    const readAt = await markRead(conversation, false);
    return res.json({ success: true, read_at: readAt });
  } catch (error) {
    console.error('SupportController.markMyRead error:', error);
    return res.status(500).json({ message: 'Unable to update read status.' });
  }
};

/**
 * "X is typing" — ephemeral, never persisted.
 *
 * The client pings this while the composer has focus and text; the server re-arms a short TTL.
 * Nothing is written to the database, because the fact is worthless a second later.
 */
exports.typing = async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
    const isAdmin = req.userRole === 'admin';

    const conversation = isAdmin
      ? await SupportConversation.findByPk(req.params.id)
      : await findConversation(req.user.id);
    if (!conversation) return res.status(204).end();

    Realtime.setTyping({
      conversationId: conversation.id,
      side: isAdmin ? 'admin' : 'customer',
      name: isAdmin ? (req.user.name || 'Support') : conversation.name,
    });
    return res.status(204).end();
  } catch (error) {
    console.error('SupportController.typing error:', error);
    return res.status(204).end();
  }
};

// ── Admin ─────────────────────────────────────────────────────────────────────────────

/**
 * The inbox: one row per customer, carrying their strands.
 *
 * Deliberately per CUSTOMER and not per strand. An agent answers a person, and a queue that
 * listed the same person three times was the thing the ticket rewrite set out to remove — the
 * strands ride along as chips so the row still shows what needs doing.
 *
 * A status filter therefore matches a customer with ANY strand in that state; the row reports
 * which, so nobody has to open it to find out.
 */
exports.listConversations = async (req, res) => {
  try {
    const conversations = await SupportConversation.findAll({
      include: [{ model: SupportTopic, as: 'Topics' }],
      order: [['last_message_at', 'DESC NULLS LAST'], ['id', 'DESC']],
    });

    const wanted = req.query.open === 'true'
      ? ['Open', 'In Progress']
      : (req.query.status && req.query.status !== 'all' ? [req.query.status] : null);

    const rows = [];
    for (const conversation of conversations) {
      const topics = conversation.Topics || [];
      if (wanted && !topics.some((t) => wanted.includes(t.status))) continue;

      const messages = await SupportMessage.findAll({
        where: { conversation_id: conversation.id },
        order: [['created_at', 'ASC'], ['id', 'ASC']],
      });
      // The preview is the last thing a PERSON said. A status line as the preview would tell
      // the agent scanning the queue only what they themselves just did.
      const lastSpoken = [...messages].reverse().find((m) => m.sender !== 'system') || null;

      rows.push({
        ...publicConversation(conversation),
        name: conversation.name,
        email: conversation.email,
        phone: conversation.phone,
        topics: topics
          .slice()
          .sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0))
          .map(publicTopic),
        message_count: messages.length,
        preview: lastSpoken?.body || (lastSpoken?.attachments?.length ? 'Photo' : ''),
        // Whose turn it is: the customer spoke last and nobody has answered.
        awaiting_reply: !lastSpoken || lastSpoken.sender === 'customer',
        unread_count: unreadFor(conversation, messages, 'admin'),
      });
    }

    return res.json(rows);
  } catch (error) {
    console.error('SupportController.listConversations error:', error);
    return res.status(500).json({ message: 'Unable to fetch conversations.' });
  }
};

/** One customer's whole chat, with its strands. `?topicId=` narrows the messages to one. */
exports.getConversation = async (req, res) => {
  try {
    const conversation = await SupportConversation.findByPk(req.params.id);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const topics = await SupportTopic.findAll({
      where: { conversation_id: conversation.id },
      order: [['last_message_at', 'DESC NULLS LAST'], ['id', 'DESC']],
    });

    const topicId = req.query.topicId ? Number(req.query.topicId) : null;
    const messages = await SupportMessage.findAll({
      where: {
        conversation_id: conversation.id,
        ...(topicId ? { topic_id: topicId } : {}),
      },
      order: [['created_at', 'ASC'], ['id', 'ASC']],
    });

    // Fetching the thread is itself a delivery: these messages are now on this client.
    markDelivered(conversation.id, 'customer');

    const customer = await Customer.findByPk(conversation.customer_id, {
      attributes: ['id', 'name', 'email', 'phone', 'createdAt'],
    });

    return res.json({
      ...publicConversation(conversation),
      name: conversation.name,
      email: conversation.email,
      phone: conversation.phone,
      topics: topics.map(publicTopic),
      messages: messages.map(publicMessage),
      customer: customer
        ? { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone, since: customer.createdAt }
        : null,
    });
  } catch (error) {
    console.error('SupportController.getConversation error:', error);
    return res.status(500).json({ message: 'Unable to open this conversation.' });
  }
};

exports.sendAdminMessage = async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
    const conversation = await SupportConversation.findByPk(req.params.id);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    // Support always replies INTO a strand — the one they are reading. Falling back to the
    // most recent keeps a reply from vanishing if the client somehow sends none.
    const topic = req.body.topicId
      ? await SupportTopic.findOne({
        where: { id: req.body.topicId, conversation_id: conversation.id },
      })
      : await SupportTopic.findOne({
        where: { conversation_id: conversation.id },
        order: [['last_message_at', 'DESC NULLS LAST'], ['id', 'DESC']],
      });
    if (!topic) return res.status(404).json({ message: 'Nothing to reply to yet.' });

    return await postMessage(req, res, { conversation, topic, isAdmin: true });
  } catch (error) {
    console.error('SupportController.sendAdminMessage error:', error);
    return res.status(500).json({ message: 'Unable to send your message right now.' });
  }
};

exports.markAdminRead = async (req, res) => {
  try {
    const conversation = await SupportConversation.findByPk(req.params.id);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    const readAt = await markRead(conversation, true);
    return res.json({ success: true, read_at: readAt });
  } catch (error) {
    console.error('SupportController.markAdminRead error:', error);
    return res.status(500).json({ message: 'Unable to update read status.' });
  }
};

/**
 * Move ONE strand along its lifecycle.
 *
 * Per topic, which is the whole reason topics exist: the damaged saree can be resolved while
 * the parcel that never arrived stays open, and neither says anything about the other.
 *
 * The change is written INTO the strand as a system message — the customer watches "Marked
 * resolved by support" appear where that conversation was, in the same second the agent clicks
 * it. A badge changing colour on a page they are not looking at is not a notification.
 *
 * Closing never locks the composer. Writing into a settled strand reopens it (see
 * postMessage), because the customer has nowhere else to go.
 */
exports.updateTopic = async (req, res) => {
  try {
    const conversation = await SupportConversation.findByPk(req.params.id);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const topic = await SupportTopic.findOne({
      where: { id: req.params.topicId, conversation_id: conversation.id },
    });
    if (!topic) return res.status(404).json({ message: 'Conversation topic not found' });

    const { status } = req.body;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ message: `Status must be one of: ${STATUSES.join(', ')}` });
    }
    if (status === topic.status) {
      return res.json({ success: true, topic: publicTopic(topic) });
    }

    await topic.update({ status });

    const line = {
      Open: 'Conversation reopened by support',
      'In Progress': 'Support is looking into this',
      Resolved: 'Marked resolved by support',
      Closed: 'Conversation closed by support',
    }[status];
    await writeSystemLine(topic, line);
    Realtime.emitStatusChange(conversation.id, topic.id, status);

    if (SETTLED.has(status)) {
      EmailService.sendSupportStatusToCustomer(conversation, status).catch((error) => {
        console.error('SupportController: status email failed:', error.message);
      });
    }

    return res.json({ success: true, topic: publicTopic(topic) });
  } catch (error) {
    console.error('SupportController.updateTopic error:', error);
    return res.status(500).json({ message: 'Unable to update the conversation.' });
  }
};

// ── Realtime plumbing ─────────────────────────────────────────────────────────────────

/**
 * Mint a short-lived credential for the SSE connection.
 *
 * EventSource cannot set an Authorization header, so the stream itself cannot carry the normal
 * Bearer token. This endpoint CAN (it is a normal POST behind authMiddleware), so the client
 * trades its real JWT for a 60-second single-use token and puts that in the stream URL
 * instead. See Realtime.issueStreamToken for the reasoning.
 */
exports.streamToken = async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
  return res.json({
    token: Realtime.issueStreamToken({ userId: req.user.id, role: req.userRole || 'customer' }),
  });
};

/**
 * The SSE stream.
 *
 * A customer subscribes to their OWN conversation — resolved from the token's identity, never
 * from a path parameter, so there is no id for anyone to tamper with. Admins subscribe either
 * to one conversation or to the shared inbox firehose.
 *
 * Per conversation and not per topic: a customer has one connection open, and it has to carry
 * a reply about any of their orders. The client filters by `topic_id` on the event, which is
 * cheaper than holding a stream per strand.
 *
 * Deliberately NOT behind authMiddleware: the browser cannot send the header here. The stream
 * token in the query string is the auth.
 */
exports.stream = async (req, res) => {
  const identity = Realtime.redeemStreamToken(req.query.token);
  if (!identity) return res.status(401).json({ message: 'Invalid or expired stream token.' });

  const isAdmin = identity.role === 'admin';
  let conversationId = null;

  if (isAdmin) {
    conversationId = req.params.id ? Number(req.params.id) : null;
  } else {
    const own = await SupportConversation.findOne({
      where: { customer_id: identity.userId },
      attributes: ['id'],
    });
    if (!own) return res.status(404).json({ message: 'No conversation yet.' });
    conversationId = own.id;
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

  send({ type: 'connected', conversation_id: conversationId });

  const channel = conversationId
    ? Realtime.conversationChannel(conversationId)
    : Realtime.ADMIN_CHANNEL;
  const unsubscribe = Realtime.subscribe(channel, send);

  // Presence drives the middle tick — see SupportRealtime. Registered against the side that
  // is watching, so a message written while they're connected is delivered on arrival.
  const side = isAdmin ? 'admin' : 'customer';
  Realtime.addPresence(side, conversationId);

  // Anything the other side sent before this connection opened has now reached us too. The
  // admin inbox (no conversationId) is skipped: sweeping every conversation on each connect
  // would be an unbounded query, and the per-conversation stream covers it when one is open.
  if (conversationId) {
    markDelivered(conversationId, isAdmin ? 'customer' : 'admin');
  }

  // Idle proxies and load balancers close a connection with no traffic, typically at 60s. A
  // comment line is a valid SSE no-op that keeps it alive without reaching the client's
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
    Realtime.dropPresence(side, conversationId);
    if (!res.writableEnded) res.end();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
};
