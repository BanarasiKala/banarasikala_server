const { Op } = require('sequelize');
const SupportTicket = require('../models/SupportTicket');
const SupportTicketMessage = require('../models/SupportTicketMessage');
const Order = require('../models/Order');
const EmailService = require('../services/EmailService');

// Kept in sync with TICKET_CATEGORIES in the client's support modal.
const TICKET_CATEGORIES = [
  'Delivery or shipping issue',
  'Payment or refund issue',
  'Damaged or defective product',
  'Wrong or missing item',
  'Return or exchange help',
  'Other',
];

const TICKET_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const OPEN_STATUSES = ['Open', 'In Progress'];

// A closed ticket is the end of the conversation — reopening means raising a new one.
// Everything else (Open / In Progress / Resolved) can still be replied to, so a customer
// who says "that didn't work" after a Resolved isn't stranded.
const isThreadClosed = (ticket) => String(ticket?.status || '') === 'Closed';

const MAX_MESSAGE_LENGTH = 2000;
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

const publicMessage = (row) => ({
  id: row.id,
  sender: row.sender,
  sender_name: row.sender_name,
  message: row.message,
  createdAt: row.createdAt,
});

// The ticket's own `message` is the FIRST message of the thread — it is rendered as such,
// not as a separate field, so the client only ever walks one list.
const threadOf = (ticket) => {
  const opening = {
    id: `ticket-${ticket.id}`,
    sender: 'customer',
    sender_name: ticket.name,
    message: ticket.message,
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
  status: ticket.status,
  resolved_at: ticket.resolved_at,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
  can_reply: !isThreadClosed(ticket),
  ...(withThread ? { messages: threadOf(ticket) } : {}),
});

exports.TICKET_CATEGORIES = TICKET_CATEGORIES;
exports.TICKET_STATUSES = TICKET_STATUSES;

exports.createTicket = async (req, res) => {
  try {
    if (!req.user?.id || req.userRole === 'admin') {
      return res.status(401).json({ message: 'Customer authentication required' });
    }

    const { orderId, category, message, phone } = req.body;
    const cleanCategory = String(category || '').trim();
    const cleanMessage = String(message || '').trim();

    if (!orderId) return res.status(400).json({ message: 'An order is required to raise a ticket.' });
    if (!TICKET_CATEGORIES.includes(cleanCategory)) {
      return res.status(400).json({ message: 'Please choose what your query is about.' });
    }
    if (cleanMessage.length < 10) {
      return res.status(400).json({ message: 'Please describe your issue in a little more detail.' });
    }
    if (cleanMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ message: `Please keep your message under ${MAX_MESSAGE_LENGTH} characters.` });
    }

    const order = await findOwnedOrder(orderId, req.user);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // ONE ticket per order. A follow-up is a message on the existing thread, not a new
    // ticket — otherwise the same conversation fragments across several tickets and nobody
    // (customer or support) can see the whole story in one place.
    const existing = await SupportTicket.findOne({ where: { order_id: order.id } });
    if (existing) {
      return res.status(409).json({
        message: `You already have ticket ${existing.ticket_number} for this order — continue the conversation there.`,
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
      status: 'Open',
    });
    await ticket.update({ ticket_number: `TKT${String(ticket.id).padStart(6, '0')}` });

    // Support must hear about it; the customer gets a receipt. Neither failing is a
    // reason to lose the ticket that is already saved.
    EmailService.sendSupportTicketRaised(ticket, order).catch((error) => {
      console.error('SupportController: ticket email failed:', error.message);
    });

    return res.status(201).json({
      success: true,
      message: `Ticket ${ticket.ticket_number} raised. Our support team will reach out soon.`,
      ticket: publicTicket(ticket),
    });
  } catch (error) {
    console.error('SupportController.createTicket error:', error);
    return res.status(500).json({ message: 'Unable to raise your ticket right now. Please try again.' });
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
    return res.status(500).json({ message: 'Unable to fetch your tickets.' });
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
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    return res.json(publicTicket(ticket, { withThread: true }));
  } catch (error) {
    console.error('SupportController.getTicket error:', error);
    return res.status(500).json({ message: 'Unable to fetch this ticket.' });
  }
};

// Post a follow-up. The same handler serves both sides — who is speaking comes from the
// authenticated role, never from the request body.
exports.addMessage = async (req, res) => {
  try {
    const isAdmin = req.userRole === 'admin';
    if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });

    const cleanMessage = String(req.body.message || '').trim();
    if (cleanMessage.length < 1) {
      return res.status(400).json({ message: 'Please type a message.' });
    }
    if (cleanMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ message: `Please keep your message under ${MAX_MESSAGE_LENGTH} characters.` });
    }

    const where = { id: req.params.id };
    if (!isAdmin) where.customer_id = req.user.id;

    const ticket = await SupportTicket.findOne({ where, include: [{ model: Order }] });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    if (isThreadClosed(ticket)) {
      return res.status(409).json({
        message: 'This ticket is closed. Please raise a new one if you still need help.',
      });
    }

    const sender = isAdmin ? 'admin' : 'customer';
    const recent = await SupportTicketMessage.findOne({
      where: {
        ticket_id: ticket.id,
        sender,
        message: cleanMessage,
        createdAt: { [Op.gte]: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
    });
    if (recent) return res.status(201).json({ success: true, message: publicMessage(recent) });

    const row = await SupportTicketMessage.create({
      ticket_id: ticket.id,
      sender,
      sender_name: isAdmin ? (req.user.name || 'Banarasi Kala Support') : ticket.name,
      message: cleanMessage,
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
      EmailService.sendSupportTicketReply(ticket, ticket.Order, cleanMessage).catch((error) => {
        console.error('SupportController: reply email failed:', error.message);
      });
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
