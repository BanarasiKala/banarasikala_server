const { Op } = require('sequelize');
const SupportTicket = require('../models/SupportTicket');
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

const MAX_TICKETS_PER_ORDER = 20;
// A double-submit (impatient click, retried request) must not create a second
// ticket — the same message on the same order inside this window returns the first.
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

const publicTicket = (ticket) => ({
  id: ticket.id,
  ticket_number: ticket.ticket_number,
  order_id: ticket.order_id,
  category: ticket.category,
  message: ticket.message,
  status: ticket.status,
  admin_response: ticket.admin_response,
  resolved_at: ticket.resolved_at,
  createdAt: ticket.createdAt,
});

exports.TICKET_CATEGORIES = TICKET_CATEGORIES;

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
    if (cleanMessage.length > 2000) {
      return res.status(400).json({ message: 'Please keep your message under 2000 characters.' });
    }

    const order = await findOwnedOrder(orderId, req.user);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const existing = await SupportTicket.findOne({
      where: {
        order_id: order.id,
        message: cleanMessage,
        createdAt: { [Op.gte]: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
    });
    if (existing) {
      return res.status(201).json({
        success: true,
        message: `We already have this request — ticket ${existing.ticket_number}.`,
        ticket: publicTicket(existing),
      });
    }

    const ticketCount = await SupportTicket.count({ where: { order_id: order.id } });
    if (ticketCount >= MAX_TICKETS_PER_ORDER) {
      return res.status(429).json({
        message: 'You have raised too many tickets for this order. Please reply to our email instead.',
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

// Every ticket the logged-in customer has raised, so My Orders can show the live
// status on the order it belongs to.
exports.listMyTickets = async (req, res) => {
  try {
    if (!req.user?.id || req.userRole === 'admin') {
      return res.status(401).json({ message: 'Customer authentication required' });
    }
    const where = { customer_id: req.user.id };
    if (req.query.orderId) where.order_id = req.query.orderId;

    const tickets = await SupportTicket.findAll({ where, order: [['createdAt', 'DESC']] });
    return res.json(tickets.map(publicTicket));
  } catch (error) {
    console.error('SupportController.listMyTickets error:', error);
    return res.status(500).json({ message: 'Unable to fetch your tickets.' });
  }
};

exports.listTickets = async (req, res) => {
  try {
    const where = {};
    if (req.query.status && req.query.status !== 'all') where.status = req.query.status;
    if (req.query.open === 'true') where.status = { [Op.in]: OPEN_STATUSES };

    const tickets = await SupportTicket.findAll({
      where,
      include: [{
        model: Order,
        attributes: ['id', 'order_number', 'status', 'payment_method', 'customer_name', 'customer_email'],
      }],
      order: [['createdAt', 'DESC']],
    });
    return res.json(tickets);
  } catch (error) {
    console.error('SupportController.listTickets error:', error);
    return res.status(500).json({ message: 'Unable to fetch tickets.' });
  }
};

exports.updateTicket = async (req, res) => {
  try {
    const ticket = await SupportTicket.findByPk(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    const { status, adminResponse } = req.body;
    const updates = {};

    if (status !== undefined) {
      if (!TICKET_STATUSES.includes(status)) {
        return res.status(400).json({ message: `Status must be one of: ${TICKET_STATUSES.join(', ')}` });
      }
      updates.status = status;
      updates.resolved_at = status === 'Resolved' || status === 'Closed' ? new Date() : null;
    }
    if (adminResponse !== undefined) updates.admin_response = String(adminResponse).trim() || null;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: 'Nothing to update.' });
    }

    await ticket.update(updates);

    // Tell the customer only when there is something to read or the ticket closed out.
    if (updates.admin_response || updates.status === 'Resolved' || updates.status === 'Closed') {
      const order = await Order.findByPk(ticket.order_id);
      EmailService.sendSupportTicketUpdate(ticket, order).catch((error) => {
        console.error('SupportController: ticket update email failed:', error.message);
      });
    }

    return res.json({ success: true, ticket: publicTicket(ticket) });
  } catch (error) {
    console.error('SupportController.updateTicket error:', error);
    return res.status(500).json({ message: 'Unable to update the ticket.' });
  }
};
