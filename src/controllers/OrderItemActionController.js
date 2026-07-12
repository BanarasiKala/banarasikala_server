const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const OrderItemAction = require('../models/OrderItemAction');
const OrderRefund = require('../models/OrderRefund');
const { REFUND_TYPE, REFUND_STATUS, REFUND_PAYMENT_METHOD } = require('../utils/orderTransactions');
const Product = require('../models/Product');
const Color = require('../models/Color');
const Customer = require('../models/Customer');
const WalletTransaction = require('../models/WalletTransaction');
const Payment = require('../models/Payment');
const { refundPayment: razorpayRefund } = require('../services/RazorpayService');
const OrderReturnService = require('../services/OrderReturnService');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const RefundTransaction = require('../models/RefundTransaction');
const OrderLedger = require('../models/OrderLedger');
const Shipment = require('../models/Shipment');
const { Transaction, Op } = require('sequelize');
const { sequelize } = require('../config/db');
const {
  ACTION_TYPES,
  ACTION_STATUS,
  ensureOrderItemActionSchema,
  normalizeActionType,
  getActionableQuantity,
  calculateItemAction,
  statusForRequestedAction,
  statusAfterCompletedAction,
  isDeliveredEnoughForPostDeliveryAction,
  roundMoney,
} = require('../utils/orderItemActions');
const {
  ACTOR, LEDGER_ENTRY_TYPE, LEDGER_DIRECTION, LEDGER_REFERENCE_TYPE, SHIPMENT_TYPE,
} = require('../utils/orderModelV2');
const { appendEntry, deriveOrderTotals } = require('../services/orderLedgerService');
const { consumeStock, releaseStock } = require('../utils/inventory');
const {
  normalizeTarget, exchangeTargetsOf, totalTargetQuantity,
} = require('../utils/exchangeTargets');
const ExchangeReplacementService = require('../services/ExchangeReplacementService');

const customerOwnsOrder = (order, user) => {
  const isOwnedByCustomerId = Number(order.customer_id) === Number(user?.id);
  const isLegacyOwnedByEmail = !order.customer_id
    && user?.email
    && String(order.customer_email || '').toLowerCase() === String(user.email).toLowerCase();
  return isOwnedByCustomerId || isLegacyOwnedByEmail;
};

const normalizeItems = (items = []) => {
  if (!Array.isArray(items)) return [];
  const itemMap = new Map();
  items.forEach((item) => {
    const orderItemId = Number(item.orderItemId || item.order_item_id || item.id);
    if (Number.isInteger(orderItemId) && orderItemId > 0) {
      const qty = Number(item.quantity || item.qty || 0);

      // Exchange only: what the customer wants INSTEAD, as a LIST — exchange 3 units and
      // take 2 × product A + 1 × product B. Quantities must sum to the quantity being
      // exchanged (enforced in create()). Every product must be priced at EXACTLY what was
      // paid, so the split can never change the money.
      const rawTargets = item.exchangeTargets ?? item.exchange_targets ?? null;
      let exchangeTargets = Array.isArray(rawTargets)
        ? rawTargets.map((t) => normalizeTarget(t)).filter(Boolean)
        : [];

      // Back-compat: a single {exchangeProductId, exchangeColorId} from an older client is
      // just a one-element list covering the whole quantity.
      if (!exchangeTargets.length) {
        const rawProduct = item.exchangeProductId ?? item.exchange_product_id ?? null;
        const rawColor = item.exchangeColorId ?? item.exchange_color_id ?? null;
        if (Number(rawProduct) > 0 || Number(rawColor) > 0) {
          const single = normalizeTarget(
            { product_id: rawProduct, color_id: rawColor, quantity: qty > 0 ? qty : 1 },
          );
          if (single) exchangeTargets = [single];
        }
      }

      itemMap.set(orderItemId, { quantity: qty > 0 ? qty : null, exchangeTargets });
    }
  });
  return Array.from(itemMap.entries()).map(([orderItemId, value]) => ({
    orderItemId,
    quantity: value.quantity,
    exchangeTargets: value.exchangeTargets,
  }));
};

const isActionClosedByRejection = (action) => {
  const status = String(action?.status || '').toLowerCase();
  return ['rejected'].includes(status);
};

const hasUsableAction = (item, actionType = null) => {
  const actions = item?.OrderItemActions || [];
  return actions.some((action) => {
    const type = String(action.action_type || '').toLowerCase();
    return (!actionType || type === actionType) && !isActionClosedByRejection(action);
  });
};

const hasOrderExchangeHistory = (order) => (
  (order?.OrderItems || []).some((item) => hasUsableAction(item, ACTION_TYPES.EXCHANGE))
);

const itemActionsOf = (item) => item.OrderItemActions || item.getDataValue?.('OrderItemActions') || [];
const getWholeProductActionQuantity = (item) => getActionableQuantity(item, itemActionsOf(item));

const serializeAction = (action) => {
  const json = typeof action?.toJSON === 'function' ? action.toJSON() : action;
  return {
    ...json,
    item_amount: roundMoney(json.item_amount),
    forward_shipping_deduction: roundMoney(json.forward_shipping_deduction),
    reverse_shipping_deduction: roundMoney(json.reverse_shipping_deduction),
    estimated_refund_amount: roundMoney(json.estimated_refund_amount),
  };
};

// A return/exchange REQUEST is the unit of work: one reverse pickup, one refund
// row, one payout — even though it is stored as one action row per item. These
// helpers resolve any single action to its whole request, so reviewing or
// refunding always acts on the request and never item by item.
const groupIdOf = (action) => Number(action?.request_group_id || action?.id);

// All rows of the request that `action` belongs to, oldest first (the first row
// is the request's primary — it owns the OrderRefund row).
const loadActionGroup = async (action, { transaction, lock = false } = {}) => {
  const groupId = groupIdOf(action);
  const rows = await OrderItemAction.findAll({
    where: {
      order_id: action.order_id,
      action_type: action.action_type,
      [Op.or]: [{ request_group_id: groupId }, { id: groupId }],
    },
    order: [['id', 'ASC']],
    transaction,
    ...(lock ? { lock: Transaction.LOCK.UPDATE } : {}),
  });
  return rows.length ? rows : [action];
};

class OrderItemActionController {
  async estimate(req, res) {
    try {
      await ensureOrderItemActionSchema();
      const actionType = normalizeActionType(req.body.actionType || req.body.action_type);
      if (!actionType || actionType === ACTION_TYPES.CANCEL) {
        return res.status(400).json({ message: 'Please choose return or exchange. Cancellation applies to the whole order.' });
      }

      const order = await Order.findByPk(req.params.orderId, {
        include: [{ model: OrderItem, include: [OrderItemAction] }],
      });
      if (!order) return res.status(404).json({ message: 'Order not found.' });
      if (req.userRole !== 'admin' && !customerOwnsOrder(order, req.user)) {
        return res.status(403).json({ message: 'This order does not belong to this account.' });
      }

      if (!isDeliveredEnoughForPostDeliveryAction(order)) {
        return res.status(400).json({ message: 'Return or exchange is available after delivery.' });
      }

      const selections = normalizeItems(req.body.items);
      const itemMap = new Map((order.OrderItems || []).map((item) => [Number(item.id), item]));
      const estimates = selections.map((selection) => {
        const item = itemMap.get(selection.orderItemId);
        if (!item) return null;
        if (hasUsableAction(item)) {
          return null;
        }
        if (actionType === ACTION_TYPES.EXCHANGE && hasOrderExchangeHistory(order)) {
          return null;
        }
        const maxQty = getWholeProductActionQuantity(item);
        const quantity = (selection.quantity > 0) ? Math.min(selection.quantity, maxQty) : maxQty;
        if (quantity < 1) return null;
        return {
          order_item_id: item.id,
          product_name: item.product_name,
          quantity,
          ...calculateItemAction({ order, item, actionType, quantity }),
        };
      }).filter(Boolean);

      const totals = estimates.reduce((sum, item) => ({
        item_amount: roundMoney(sum.item_amount + item.item_amount),
        forward_shipping_deduction: roundMoney(sum.forward_shipping_deduction + item.forward_shipping_deduction),
        reverse_shipping_deduction: roundMoney(sum.reverse_shipping_deduction + item.reverse_shipping_deduction),
        estimated_refund_amount: roundMoney(sum.estimated_refund_amount + item.estimated_refund_amount),
      }), { item_amount: 0, forward_shipping_deduction: 0, reverse_shipping_deduction: 0, estimated_refund_amount: 0 });

      // Coupon + pickup-charge preview: same maths as the real request, so the
      // modal shows exactly what will be saved when the return is submitted.
      totals.coupon_adjustment = 0;
      totals.return_shipping_charge = 0;
      let couponBreakdown = null;
      if (actionType === ACTION_TYPES.RETURN && estimates.length) {
        const orderItems = order.OrderItems || [];
        const itemActions = orderItems.flatMap((item) => item.OrderItemActions || []);
        const targets = estimates.map((estimateRow) => ({
          item: itemMap.get(estimateRow.order_item_id),
          quantity: estimateRow.quantity,
        }));
        const refundInfo = await OrderReturnService.computeReturnRefund({ order, orderItems, itemActions, targets });
        totals.coupon_adjustment = roundMoney(refundInfo.couponAdjustment);
        totals.return_shipping_charge = roundMoney(refundInfo.returnShippingCharge);
        totals.return_shipping_weight_kg = refundInfo.pickupWeightKg;
        totals.estimated_refund_amount = roundMoney(refundInfo.refundAmount);
        totals.is_full_return = Boolean(refundInfo.isFullReturn);
        // Full return: the paid money (amount_paid) is refunded to the gateway
        // minus the non-refundable fees + pickup charge (gateway_refund), while
        // the wallet credit is returned to the wallet IN FULL (wallet_return).
        // Exposed line by line so the modal can show the formula instead of a
        // single lumped figure.
        if (refundInfo.isFullReturn) {
          totals.amount_paid = roundMoney(refundInfo.amountPaid);
          totals.wallet_amount = roundMoney(refundInfo.walletAmount);
          totals.wallet_return = roundMoney(refundInfo.walletReturn);
          totals.gateway_refund = roundMoney(refundInfo.gatewayRefund);
          totals.platform_fee = roundMoney(refundInfo.platformFee);
          totals.cod_fee = roundMoney(refundInfo.codFee);
          totals.gift_charge = roundMoney(refundInfo.giftCharge);
        }
        if ((refundInfo.originalCouponCode && refundInfo.currentDiscount > 0) || refundInfo.couponAdjustment > 0) {
          couponBreakdown = {
            original_code: refundInfo.originalCouponCode,
            original_discount: roundMoney(refundInfo.currentDiscount),
            original_eligible: refundInfo.originalCouponEligible,
            applied_code: refundInfo.appliedCouponCode,
            new_discount: roundMoney(refundInfo.newDiscount),
            remaining_subtotal: roundMoney(refundInfo.remainingSubtotal),
            adjustment: roundMoney(refundInfo.couponAdjustment),
          };
        }
      }

      return res.status(200).json({ items: estimates, totals, coupon: couponBreakdown });
    } catch (error) {
      console.error('[OrderItemAction] estimate error:', error.message);
      return res.status(500).json({ message: 'Unable to calculate this request right now.' });
    }
  }

  // ── What this order line can be exchanged FOR ────────────────────────────────
  // GET /orders/:orderId/item-actions/exchange-options?orderItemId=N
  //
  // Every active product priced at EXACTLY what the customer paid for this line, that has
  // at least one colour in stock — plus the line's own product, so a plain colour swap is
  // still offered. An even swap by construction: no money can change hands in either
  // direction, which is the whole reason the price match is exact rather than a band.
  async exchangeOptions(req, res) {
    try {
      const order = await Order.findByPk(req.params.orderId, {
        include: [{ model: OrderItem }],
      });
      if (!order) return res.status(404).json({ message: 'Order not found.' });
      if (req.userRole !== 'admin' && !customerOwnsOrder(order, req.user)) {
        return res.status(403).json({ message: 'This order does not belong to this account.' });
      }

      const orderItemId = Number(req.query.orderItemId || req.query.order_item_id);
      const orderItem = (order.OrderItems || []).find((it) => Number(it.id) === orderItemId);
      if (!orderItem) return res.status(404).json({ message: 'Product not found in this order.' });

      const paidPrice = roundMoney(Number(orderItem.price || 0));

      const candidates = await Product.findAll({
        where: { status: 'active', selling_price: paidPrice },
        attributes: ['id', 'name', 'slug', 'sku', 'selling_price', 'images', 'color_stocks'],
      });

      // Name the in-stock colours. One query for every colour across every candidate.
      const colorIds = [...new Set(candidates.flatMap((product) => (
        Object.entries(product.color_stocks || {})
          .filter(([, qty]) => Number(qty) > 0)
          .map(([colorId]) => Number(colorId))
      )))].filter(Boolean);
      const colors = colorIds.length
        ? await Color.findAll({ where: { id: colorIds }, attributes: ['id', 'name', 'slug', 'hex_code'] })
        : [];
      const colorById = new Map(colors.map((c) => [Number(c.id), c]));

      const options = candidates.map((product) => {
        const inStock = Object.entries(product.color_stocks || {})
          .filter(([, qty]) => Number(qty) > 0)
          .map(([colorId, qty]) => {
            const color = colorById.get(Number(colorId));
            return {
              color_id: Number(colorId),
              name: color?.name || `Colour #${colorId}`,
              slug: color?.slug || null,
              hex_code: color?.hex_code || null,
              stock: Number(qty),
            };
          });
        return {
          product_id: product.id,
          name: product.name,
          slug: product.slug,
          sku: product.sku,
          price: roundMoney(Number(product.selling_price || 0)),
          images: product.images || [],
          colors: inStock,
          is_current_product: Number(product.id) === Number(orderItem.product_id),
        };
      })
        // A product with nothing in stock can't be exchanged into. The customer's OWN
        // product stays listed even if only its current colour remains — that is still a
        // valid "same item, replace the faulty one" request.
        .filter((option) => option.colors.length > 0 || option.is_current_product)
        .sort((a, b) => Number(b.is_current_product) - Number(a.is_current_product));

      return res.status(200).json({
        order_item_id: orderItem.id,
        paid_price: paidPrice,
        current_product_id: orderItem.product_id,
        current_color_id: orderItem.colorId ?? null,
        options,
      });
    } catch (error) {
      console.error('[OrderItemAction] exchange options error:', error.message);
      return res.status(500).json({ message: 'Unable to load exchange options right now.' });
    }
  }

  async create(req, res) {
    const transaction = await sequelize.transaction();
    try {
      await ensureOrderItemActionSchema();
      const actionType = normalizeActionType(req.body.actionType || req.body.action_type);
      if (!actionType || actionType === ACTION_TYPES.CANCEL) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Please choose return or exchange. Cancellation applies to the whole order.' });
      }

      const order = await Order.findByPk(req.params.orderId, {
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      if (!order) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Order not found.' });
      }

      const orderItems = await OrderItem.findAll({
        where: { order_id: order.id },
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      const itemActions = await OrderItemAction.findAll({
        where: { order_id: order.id },
        transaction,
      });
      orderItems.forEach((item) => {
        item.setDataValue(
          'OrderItemActions',
          itemActions.filter((action) => Number(action.order_item_id) === Number(item.id)),
        );
      });
      order.setDataValue('OrderItems', orderItems);
      if (req.userRole !== 'admin' && !customerOwnsOrder(order, req.user)) {
        await transaction.rollback();
        return res.status(403).json({ message: 'This order does not belong to this account.' });
      }

      if (!isDeliveredEnoughForPostDeliveryAction(order)) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Return or exchange is available after delivery.' });
      }

      const selections = normalizeItems(req.body.items);
      if (!selections.length) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Please select at least one product.' });
      }

      // Exchange: validate what the customer wants INSTEAD, against live data — a stale or
      // forged client must not be able to request something unavailable, cheaper, dearer, or
      // more units than it is handing back. The resolved names are stored on the request so
      // the admin queue reads in plain English.
      if (actionType === ACTION_TYPES.EXCHANGE) {
        for (const selection of selections) {
          const orderItem = orderItems.find((it) => Number(it.id) === Number(selection.orderItemId));
          if (!orderItem) continue;

          const exchangeQty = Number(selection.quantity) > 0
            ? Number(selection.quantity)
            : getWholeProductActionQuantity(orderItem);

          // Nothing chosen — a like-for-like swap of the same saree in the same colour.
          if (!selection.exchangeTargets?.length) {
            selection.exchangeTargets = [{
              product_id: orderItem.product_id,
              product_name: orderItem.product_name || null,
              color_id: orderItem.colorId ?? orderItem.color_id ?? null,
              color_name: null,
              quantity: exchangeQty,
            }];
          }

          // EVERY unit going back must have a named unit coming out. Anything else would
          // silently short the customer or hand out a free saree.
          const targetQty = totalTargetQuantity(selection.exchangeTargets);
          if (targetQty !== exchangeQty) {
            await transaction.rollback();
            return res.status(400).json({
              message: `You are exchanging ${exchangeQty} item(s) of ${orderItem.product_name || 'this product'} but chose ${targetQty}. Please pick exactly ${exchangeQty}.`,
            });
          }

          const paidPrice = roundMoney(Number(orderItem.price || 0));

          // Collapse duplicate picks of the same product+colour so stock is checked against
          // the TOTAL wanted, not one line at a time (2 + 2 of a colour with 3 left must fail).
          const merged = new Map();
          for (const target of selection.exchangeTargets) {
            const key = `${target.product_id}|${target.color_id ?? ''}`;
            const existing = merged.get(key);
            if (existing) existing.quantity += target.quantity;
            else merged.set(key, { ...target });
          }
          const mergedTargets = [...merged.values()];

          for (const target of mergedTargets) {
            const product = await Product.findByPk(target.product_id, {
              attributes: ['id', 'name', 'status', 'selling_price', 'color_stocks'],
              transaction,
            });
            if (!product) {
              await transaction.rollback();
              return res.status(400).json({ message: 'One of the selected products is no longer available.' });
            }
            if (product.status !== 'active') {
              await transaction.rollback();
              return res.status(400).json({ message: `${product.name} is currently unavailable for exchange.` });
            }

            // EXACT price match, against what the customer actually PAID for the item (not
            // the original product's current list price, which may have moved since). An even
            // swap means no money changes hands in either direction: no ledger entry, no
            // coupon re-rate, no top-up to collect, no difference to refund. This holds for
            // EVERY target, so however the customer splits the quantity, the money is unmoved.
            const targetPrice = roundMoney(Number(product.selling_price || 0));
            if (targetPrice !== paidPrice) {
              await transaction.rollback();
              return res.status(400).json({
                message: `${product.name} is priced at Rs. ${targetPrice.toLocaleString('en-IN')}. An exchange must be for a product at exactly Rs. ${paidPrice.toLocaleString('en-IN')} — the price you paid.`,
              });
            }
            target.product_name = product.name;

            const stocks = product.color_stocks || {};
            if (target.color_id) {
              const key = String(target.color_id);
              if (!(key in stocks)) {
                await transaction.rollback();
                return res.status(400).json({ message: `The selected colour is not available for ${product.name}.` });
              }
              if (Number(stocks[key]) < target.quantity) {
                await transaction.rollback();
                return res.status(400).json({
                  message: `Only ${Math.max(0, Number(stocks[key]))} left of ${product.name} in that colour — you asked for ${target.quantity}.`,
                });
              }
              const color = await Color.findByPk(target.color_id, { attributes: ['id', 'name'], transaction });
              target.color_name = color?.name || null;
            } else {
              // A product with colour variants needs one chosen — we can't guess.
              const inStock = Object.entries(stocks).filter(([, qty]) => Number(qty) > 0);
              if (inStock.length) {
                await transaction.rollback();
                return res.status(400).json({ message: `Please choose a colour for ${product.name}.` });
              }
            }
          }

          selection.exchangeTargets = mergedTargets;
        }
      }

      // ── Return / Exchange → unified OrderReturnService (also books reverse pickup) ──
      let result;
      try {
        result = await OrderReturnService.createReverseActions({
          order,
          orderItems,
          itemActions,
          actionType,
          selections,
          reason: req.body.reason,
          comments: req.body.comments,
          requestedBy: req.userRole === 'admin' ? null : req.user?.id,
          actor: req.userRole === 'admin' ? 'admin' : 'customer',
          transaction,
        });
      } catch (error) {
        await transaction.rollback();
        if (error instanceof OrderReturnService.ReverseActionError) {
          return res.status(error.status).json({ message: error.message });
        }
        throw error;
      }

      await transaction.commit();

      const finalize = await OrderReturnService.finalizeReverseActions({
        order,
        entries: result.entries,
        actionType,
        reason: req.body.reason,
        // The courier whose reverse rate was quoted and deducted — stamped onto the
        // REVERSE shipment so its rate card is never blank.
        pickupRateCard: result.pickupRateCard,
      });

      const EmailService = require('../services/EmailService');
      const emailStatus = actionType === ACTION_TYPES.RETURN ? 'Return Initiated' : 'Exchange Initiated';
      EmailService.sendOrderStatusUpdate(order, emailStatus).catch((emailError) => {
        console.error(`[Email] ${emailStatus} email failed:`, emailError.message);
      });

      return res.status(201).json({
        message: actionType === ACTION_TYPES.RETURN ? 'Return request submitted.' : 'Exchange request submitted.',
        actions: result.actions.map(serializeAction),
        shiprocket_return_order_id: finalize.shiprocketReturnId,
        shipment_id: finalize.shipmentId,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('[OrderItemAction] create error:', error);
      return res.status(500).json({ message: 'Unable to submit this request right now.' });
    }
  }

  // One row per REQUEST, not per item. A two-item return is one line in the
  // queue with both products on it, one Complete and one Initiate Refund for the
  // whole amount — matching the single reverse pickup and single OrderRefund row
  // that actually exist behind it.
  async listAdmin(req, res) {
    try {
      await ensureOrderItemActionSchema();
      const where = {};
      const actionType = normalizeActionType(req.query.type);
      if (actionType) where.action_type = actionType;
      if (req.query.status) where.status = String(req.query.status);

      // Two passes: find the requests that match the filter, then load every row
      // of those requests — so a status filter can never show a request with
      // some of its items missing.
      const matches = await OrderItemAction.findAll({
        where,
        attributes: ['id', 'request_group_id'],
        raw: true,
      });
      const groupIds = [...new Set(matches.map(groupIdOf))];
      if (!groupIds.length) return res.status(200).json([]);

      const actions = await OrderItemAction.findAll({
        where: {
          [Op.or]: [
            { request_group_id: { [Op.in]: groupIds } },
            { id: { [Op.in]: groupIds } },
          ],
        },
        include: [
          { model: Order, attributes: ['id', 'order_number', 'customer_name', 'customer_email', 'payment_method', 'status', 'createdAt'] },
          {
            model: OrderItem,
            include: [
              { model: Product, attributes: ['id', 'name', 'slug', 'images'] },
              { model: Color, attributes: ['id', 'name', 'slug', 'hex_code'] },
            ],
          },
        ],
        order: [['id', 'ASC']],
      });

      // Which requests already had their refund initiated (money settled) — the
      // product-reversal ledger entry is the marker. It is written for every row
      // of the request, so a hit on any row means the request is settled.
      const actionIds = actions.map((row) => Number(row.id));
      const settledRows = actionIds.length ? await OrderLedger.findAll({
        where: {
          entry_type: LEDGER_ENTRY_TYPE.PRODUCT_CHARGE,
          reference_type: LEDGER_REFERENCE_TYPE.RETURN,
          reference_id: { [Op.in]: actionIds },
        },
        attributes: ['reference_id'],
      }) : [];
      const initiatedSet = new Set(settledRows.map((row) => Number(row.reference_id)));

      // The refund row (status + bank details) hangs off the request's PRIMARY
      // action, and its amount is the whole-request total.
      const refundRows = actionIds.length ? await OrderRefund.findAll({
        where: { order_item_action_id: { [Op.in]: actionIds } },
      }) : [];
      const refundByAction = new Map(refundRows.map((row) => [Number(row.order_item_action_id), row]));

      // Which EXCHANGE requests already have a replacement Shipment — the marker
      // the "Ship Replacement" button/badge in the admin panel needs. No ledger
      // entry exists for this (the replacement ships free), so a Shipment row is
      // the only signal.
      const replacementShipments = actionIds.length ? await Shipment.findAll({
        where: { type: SHIPMENT_TYPE.FORWARD, exchange_action_id: { [Op.in]: actionIds } },
        attributes: ['exchange_action_id', 'id', 'awb_number', 'shiprocket_order_id'],
      }) : [];
      const replacementByAction = new Map(replacementShipments.map((row) => [Number(row.exchange_action_id), row]));

      // Rows arrive id-ASC, so each group's first row is its primary (the one
      // that owns the OrderRefund row). Newest request first in the queue.
      const groups = new Map();
      actions.forEach((row) => {
        const key = groupIdOf(row);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      });

      const payload = [...groups.values()].map((rows) => {
        const members = rows.map(serializeAction);
        const primary = members[0];
        const refundRow = refundByAction.get(Number(primary.id)) || null;
        // exchange_action_id can land on any member of the group (ExchangeReplacementService
        // doesn't guarantee it's the primary), so check them all.
        const replacementShipment = members
          .map((m) => replacementByAction.get(Number(m.id)))
          .find(Boolean) || null;
        const sum = (pick) => roundMoney(members.reduce((total, m) => total + Number(pick(m) || 0), 0));
        const couponAdjustment = sum((m) => m.meta?.coupon_adjustment);
        const estimateSum = sum((m) => m.estimated_refund_amount);

        return {
          // The buttons act on the primary action; the server expands it back to
          // the whole request.
          id: primary.id,
          group_id: groupIdOf(rows[0]),
          action_ids: members.map((m) => m.id),
          order_id: primary.order_id,
          action_type: primary.action_type,
          status: primary.status,
          reason: primary.reason,
          createdAt: primary.createdAt,
          Order: primary.Order,
          meta: { ...(primary.meta || {}), coupon_adjustment: couponAdjustment },

          quantity: members.reduce((total, m) => total + Number(m.quantity || 0), 0),
          item_amount: sum((m) => m.item_amount),
          forward_shipping_deduction: sum((m) => m.forward_shipping_deduction),
          reverse_shipping_deduction: sum((m) => m.reverse_shipping_deduction),
          // Prefer the refund row: it is the figure that will actually be paid,
          // so the button can never promise a different number than it pays.
          estimated_refund_amount: refundRow && primary.action_type === ACTION_TYPES.RETURN
            ? roundMoney(refundRow.amount)
            : estimateSum,

          items: members.map((m) => ({
            action_id: m.id,
            order_item_id: m.order_item_id,
            quantity: m.quantity,
            item_amount: m.item_amount,
            reverse_shipping_deduction: m.reverse_shipping_deduction,
            estimated_refund_amount: m.estimated_refund_amount,
            coupon_adjustment: roundMoney(m.meta?.coupon_adjustment || 0),
            meta: m.meta || {},
            OrderItem: m.OrderItem || null,
          })),

          refund_initiated: members.some((m) => initiatedSet.has(Number(m.id))),
          refund_status: refundRow?.status || null,
          refund_amount: refundRow ? roundMoney(refundRow.amount) : null,
          refund_bank_details: refundRow?.bank_details || null,

          replacement_shipment_id: replacementShipment?.id || null,
          replacement_booked: Boolean(replacementShipment?.shiprocket_order_id || replacementShipment?.awb_number),
          replacement_awb: replacementShipment?.awb_number || null,
        };
      });

      // Newest request first. Sequelize's `underscored` maps the COLUMN to
      // created_at but keeps the ATTRIBUTE as createdAt — read both.
      const rowTime = (row) => new Date(row?.created_at || row?.createdAt || 0).getTime();
      payload.sort((a, b) => rowTime(b) - rowTime(a));

      return res.status(200).json(payload);
    } catch (error) {
      console.error('[OrderItemAction] admin list error:', error.message);
      return res.status(500).json({ message: 'Unable to load requests right now.' });
    }
  }

  async updateAdminStatus(req, res) {
    const transaction = await sequelize.transaction();
    try {
      await ensureOrderItemActionSchema();
      const nextStatus = String(req.body.status || '').trim();
      if (!Object.values(ACTION_STATUS).includes(nextStatus)) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Please choose a valid request status.' });
      }

      const action = await OrderItemAction.findByPk(req.params.actionId, {
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      if (!action) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Request not found.' });
      }
      // A request is reviewed as a whole: one Complete/Reject closes every item
      // in it, exactly as the customer submitted it.
      const groupActions = await loadActionGroup(action, { transaction, lock: true });
      const closed = [ACTION_STATUS.COMPLETED, ACTION_STATUS.REJECTED, ACTION_STATUS.CANCELLED];
      if (groupActions.every((row) => closed.includes(row.status))) {
        await transaction.rollback();
        return res.status(400).json({ message: 'This request has already been closed.' });
      }

      const isTerminal = closed.includes(nextStatus);

      for (const groupAction of groupActions) {
        if (closed.includes(groupAction.status)) continue;

        const item = await OrderItem.findByPk(groupAction.order_item_id, {
          transaction,
          lock: Transaction.LOCK.UPDATE,
        });
        if (!item) {
          await transaction.rollback();
          return res.status(404).json({ message: 'Order item not found.' });
        }

        const quantity = Number(groupAction.quantity || 0);

        // Item status pointer — actioned quantity is derived from action rows now.
        let itemStatus;
        if (nextStatus === ACTION_STATUS.COMPLETED) {
          const completed = await OrderItemAction.findAll({
            where: { order_item_id: item.id, action_type: groupAction.action_type, status: ACTION_STATUS.COMPLETED },
            transaction,
          });
          const completedQty = completed.reduce((s, a) => s + Number(a.quantity || 0), quantity);
          itemStatus = statusAfterCompletedAction(groupAction.action_type, completedQty >= Number(item.quantity || 0));
        } else if (nextStatus === ACTION_STATUS.REJECTED || nextStatus === ACTION_STATUS.CANCELLED) {
          const otherOpen = await OrderItemAction.count({
            where: {
              order_item_id: item.id,
              id: { [Op.notIn]: groupActions.map((row) => row.id) },
              status: { [Op.notIn]: closed },
            },
            transaction,
          });
          itemStatus = otherOpen > 0 ? statusForRequestedAction(groupAction.action_type) : 'Active';
        } else {
          itemStatus = statusForRequestedAction(groupAction.action_type);
        }
        await item.update({ status: itemStatus }, { transaction });

        // ── Inventory ────────────────────────────────────────────────────────────────
        // Completing a reverse action is the moment the goods physically move, so it is
        // the moment stock must move. Neither return nor exchange did this before: a
        // returned saree was never sellable again, and an exchanged colour was validated
        // at request time but never actually consumed — so two customers could each be
        // promised the last piece of a colour, and stock drifted by a unit per request.
        if (nextStatus === ACTION_STATUS.COMPLETED) {
          const returnedColorId = item.colorId ?? item.color_id ?? null;

          if (groupAction.action_type === ACTION_TYPES.RETURN) {
            // The item is back on the shelf.
            await releaseStock({
              productId: groupAction.product_id || item.product_id,
              colorId: returnedColorId,
              quantity,
              transaction,
            });
          }

          if (groupAction.action_type === ACTION_TYPES.EXCHANGE) {
            const returnedProductId = Number(groupAction.product_id || item.product_id);
            const targets = exchangeTargetsOf(groupAction, item);

            // A like-for-like swap (same saree, same colour, whole quantity) nets to zero —
            // don't churn the stock rows for it.
            const isLikeForLike = targets.length === 1
              && Number(targets[0].product_id) === returnedProductId
              && String(targets[0].color_id ?? '') === String(returnedColorId ?? '');

            if (!isLikeForLike) {
              // Everything handed back goes on the shelf...
              await releaseStock({
                productId: returnedProductId,
                colorId: returnedColorId,
                quantity,
                transaction,
              });

              // ...and every unit going out comes off it. Stock was checked when the
              // exchange was REQUESTED, possibly days ago, and can be gone by now.
              // consumeStock throws rather than going negative, rolling the whole completion
              // back, so we never promise a saree we don't have. The admin's way out is to
              // restock it or reject the exchange.
              for (const target of targets) {
                const label = target.color_name
                  ? `${target.product_name || 'this product'} (${target.color_name})`
                  : (target.product_name || 'this product');
                await consumeStock({
                  productId: target.product_id,
                  colorId: target.color_id,
                  quantity: target.quantity,
                  transaction,
                  label,
                });
              }
            }

            // NOTE: the order line is deliberately NOT repointed at the new saree.
            //   • The quantity can now be split across SEVERAL products (2 × A + 1 × B), and
            //     one order_items row cannot represent two products — there is nothing
            //     coherent to repoint it to.
            //   • The line is the record of what was PURCHASED and paid for, which an
            //     exchange does not change. Its price still backs the PRODUCT_CHARGE in the
            //     ledger, and no money moved.
            // What was actually swapped lives on the action row (exchange_targets +
            // original_*), which is where the order page, the admin queue and the
            // replacement shipment all read it from.
          }
        }

        await groupAction.update({
          status: nextStatus,
          reviewed_by: req.user?.id || null,
          reviewed_at: new Date(),
          completed_at: isTerminal ? new Date() : null,
          meta: { ...(groupAction.meta || {}), admin_note: req.body.note || null },
        }, { transaction });
      }

      // NOTE: completing a return only records that the item is back with us.
      // No money moves here — the admin explicitly presses "Initiate refund"
      // (initiateRefund below) to settle the ledger and pay the customer.

      // The OrderRefund row hangs off the request's PRIMARY action.
      const primaryAction = groupActions[0];

      // COD returns are paid out by manual bank transfer — the moment the
      // return completes, flag the refund row so the customer's order page
      // asks for their bank details.
      if (nextStatus === ACTION_STATUS.COMPLETED && action.action_type === ACTION_TYPES.RETURN) {
        const orderRow = await Order.findByPk(action.order_id, { transaction });
        if (String(orderRow?.payment_method || '').toUpperCase() === 'COD') {
          const refundRow = await OrderRefund.findOne({ where: { order_item_action_id: primaryAction.id }, transaction })
            || await OrderRefund.findOne({
              where: { order_id: action.order_id, refund_type: REFUND_TYPE.RETURN },
              order: [['created_at', 'DESC']],
              transaction,
            });
          if (refundRow && !refundRow.bank_details && refundRow.status === REFUND_STATUS.PENDING) {
            await refundRow.update({ status: 'Bank Details Required' }, { transaction });
          }
        }
      }

      // Status-history entry on any terminal outcome — one line for the whole
      // request, covering every item in it.
      if (isTerminal) {
        const prevOrder = await Order.findByPk(action.order_id, { transaction });
        const totalQty = groupActions.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
        const itemCount = groupActions.length;
        const historyNote = `${action.action_type} ${nextStatus.toLowerCase()} — ${itemCount} item${itemCount === 1 ? '' : 's'}, qty ${totalQty}${req.body.note ? ': ' + req.body.note : ''}`;
        await OrderStatusHistory.create({
          order_id: action.order_id,
          from_status: prevOrder?.status || null,
          to_status: `${action.action_type} ${nextStatus}`,
          actor: ACTOR.ADMIN,
          reason: historyNote,
        }, { transaction });
      }

      // Completing a return/exchange also moves the ORDER status (the courier
      // webhook normally does this, but an admin can complete first) so the
      // order and its items never disagree.
      if (nextStatus === ACTION_STATUS.COMPLETED && [ACTION_TYPES.RETURN, ACTION_TYPES.EXCHANGE].includes(action.action_type)) {
        const completedLabel = action.action_type === ACTION_TYPES.EXCHANGE ? 'Exchange Completed' : 'Return Completed';
        await Order.update({ status: completedLabel }, { where: { id: action.order_id }, transaction });
      }

      await transaction.commit();

      // Fire-and-forget: post-completion side-effects
      if (nextStatus === ACTION_STATUS.COMPLETED) {
        const EmailService = require('../services/EmailService');
        setImmediate(async () => {
          try {
            const fullOrder = await Order.findByPk(action.order_id);
            if (!fullOrder) return;

            // Send customer status email
            const emailStatus = action.action_type === ACTION_TYPES.RETURN ? 'Return Completed' : 'Exchange Completed';
            EmailService.sendOrderStatusUpdate(fullOrder, emailStatus).catch((err) => {
              console.error('[Email] Completion email failed:', err.message);
            });

            // Deliberately NOT shipping the replacement here. Completing an exchange request
            // also happens automatically from the courier webhook (RETURN DELIVERED — see
            // ShipRocketController.webhook), which this endpoint has no way to distinguish
            // from an admin's own click. Booking the replacement is a goods-movement decision,
            // same as a return's refund: it needs its own explicit trigger — see
            // shipReplacement() below / the admin panel's "Ship Replacement" button — so it
            // fires exactly once, from a place an admin actually pressed, regardless of
            // whether THIS completion came from the webhook or from here.
          } catch (err) {
            console.error('[OrderItemAction] post-complete async error:', err.message);
          }
        });
      }

      const replacementRequired = nextStatus === ACTION_STATUS.COMPLETED && action.action_type === ACTION_TYPES.EXCHANGE;
      return res.status(200).json({
        message: 'Request updated.',
        // `action` is the stale pre-update instance — report the rows we actually wrote.
        action: serializeAction(primaryAction),
        actions: groupActions.map(serializeAction),
        ...(replacementRequired ? { replacement_required: true } : {}),
      });
    } catch (error) {
      await transaction.rollback();
      // Out-of-stock on an exchange completion is an actionable business outcome, not a
      // server fault — the admin needs to read it, not a generic 500.
      if (error?.statusCode || error?.status) {
        return res.status(error.statusCode || error.status).json({ message: error.message });
      }
      console.error('[OrderItemAction] admin update error:', error);
      return res.status(500).json({ message: 'Unable to update this request right now.' });
    }
  }

  // ── Explicitly trigger the money leg of a COMPLETED return ───────────────────
  // POST /admin/item-actions/:actionId/initiate-refund
  // Completing a return only records that the item is back. Money moves only
  // here: ledger settlement (product reversal, shipping retained, coupon
  // clawback, refund debit) + the wallet-paid share back to the wallet + an
  // automatic Razorpay refund for the remainder (prepaid). COD stays a manual
  // bank transfer — this still settles the ledger and wallet share for it.
  async initiateRefund(req, res) {
    const transaction = await sequelize.transaction();
    try {
      await ensureOrderItemActionSchema();
      const action = await OrderItemAction.findByPk(req.params.actionId, {
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      if (!action) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Request not found.' });
      }
      if (String(action.action_type || '').toLowerCase() !== ACTION_TYPES.RETURN) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Refunds can be initiated for return requests only.' });
      }

      // Settle the whole REQUEST, once. Every item in it is reversed in the
      // ledger, but the customer is paid a single amount — the OrderRefund row's
      // total. (Settling item by item paid the full total on the first item and
      // then double-wrote the ledger on the rest.)
      const groupActions = await loadActionGroup(action, { transaction, lock: true });
      const primaryAction = groupActions[0];

      if (groupActions.some((row) => row.status !== ACTION_STATUS.COMPLETED)) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Complete the return first — initiate the refund once the items are received.' });
      }

      // Idempotency: the product-reversal ledger entry is the settlement marker.
      // A hit on ANY item of the request means the request is already settled.
      const alreadySettled = await OrderLedger.findOne({
        where: {
          entry_type: LEDGER_ENTRY_TYPE.PRODUCT_CHARGE,
          reference_type: LEDGER_REFERENCE_TYPE.RETURN,
          reference_id: { [Op.in]: groupActions.map((row) => row.id) },
        },
        transaction,
      });
      if (alreadySettled) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Refund has already been initiated for this return.' });
      }

      const order = await Order.findByPk(action.order_id, { transaction, lock: Transaction.LOCK.UPDATE });
      if (!order) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Order not found.' });
      }
      const isCodOrder = String(order.payment_method || '').toUpperCase() === 'COD';

      // Per-item reversal entries — the product value, pickup charge and coupon
      // clawback belong to the item they came from.
      let estimateTotal = 0;
      for (const groupAction of groupActions) {
        const itemValue = roundMoney(Number(groupAction.item_amount || 0));
        const deductions = roundMoney(Number(groupAction.forward_shipping_deduction || 0) + Number(groupAction.reverse_shipping_deduction || 0));
        const couponAdjustment = roundMoney(Number(groupAction.meta?.coupon_adjustment || 0));
        estimateTotal = roundMoney(estimateTotal + Number(groupAction.estimated_refund_amount ?? (itemValue - deductions - couponAdjustment)));

        if (itemValue > 0) {
          await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.PRODUCT_CHARGE, amount: itemValue, direction: LEDGER_DIRECTION.CREDIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: groupAction.id, note: 'Return — product value reversed' }, transaction);
        }
        if (deductions > 0) {
          await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.SHIPPING_CHARGE, amount: deductions, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: groupAction.id, note: 'Return — return pickup charge retained' }, transaction);
        }
        if (couponAdjustment > 0) {
          await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.COUPON_DISCOUNT, amount: couponAdjustment, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: groupAction.id, note: 'Return — coupon benefit no longer earned by remaining items' }, transaction);
        }
      }

      // ONE refund debit + ONE payout for the request. The OrderRefund row is the
      // authority on what the customer is owed (it carries the full-return fees,
      // which no single item's estimate knows about); the per-item estimates are
      // only its pro-rata slices and are the fallback if the row is missing.
      const refundRow = await OrderRefund.findOne({
        where: { order_item_action_id: primaryAction.id },
        transaction,
      });
      const returnRefundAmount = roundMoney(Math.max(
        0,
        refundRow ? Number(refundRow.amount || 0) : estimateTotal,
      ));

      // LEGACY ONLY. Retaining a payment-gateway charge on a full return was reverted —
      // computeReturnRefund no longer computes one, so `payment_gateway_charge` is absent
      // from every new breakdown and this is a no-op. It stays for refund rows created
      // while that policy was live: their stored amount already has the charge deducted, so
      // without this debit the ledger would settle short and show the order still owing the
      // customer money we never actually paid them.
      const gatewayCharge = roundMoney(Number(refundRow?.breakdown?.payment_gateway_charge || 0));
      if (gatewayCharge > 0) {
        await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.PAYMENT_FEE, amount: gatewayCharge, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: primaryAction.id, note: 'Return — payment gateway charge retained (legacy policy)' }, transaction);
      }

      if (returnRefundAmount > 0) {
        const refLedger = await appendEntry(action.order_id, { type: LEDGER_ENTRY_TYPE.REFUND, amount: returnRefundAmount, direction: LEDGER_DIRECTION.DEBIT, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: primaryAction.id, note: 'Return refund' }, transaction);
        await RefundTransaction.create({
          order_id: action.order_id, ledger_entry_id: refLedger?.id || null,
          gateway: isCodOrder ? 'bank_transfer' : 'original_gateway', amount: returnRefundAmount, status: 'Pending',
        }, { transaction });
      }

      await transaction.commit();

      // Fire-and-forget: wallet share + automatic gateway refund.
      setImmediate(async () => {
        try {
          const fullOrder = await Order.findByPk(action.order_id);
          if (!fullOrder) return;
          // Keyed to the request's primary action — the row that owns the refund.
          const refund = await OrderRefund.findOne({ where: { order_item_action_id: primaryAction.id } });

          // Wallet refund — wallet/subtotal sourced from the ledger. The refund
          // splits between the wallet and the original gateway (never both in
          // full):
          //   • Full return → the wallet credit is returned IN FULL (capped at
          //     the total refund); the gateway gets the remainder. computeReturnRefund
          //     already sized the total so the fees + pickup come out of the paid
          //     money, not the wallet.
          //   • Partial return → the wallet-paid share is refunded PROPORTIONALLY
          //     to the value being returned.
          const orderTotals = deriveOrderTotals(await OrderLedger.findAll({ where: { order_id: fullOrder.id } }));
          const walletTotal = Number(orderTotals.wallet_amount || 0);
          const refundAmt = Number(refund?.amount || 0);
          const subtotal = Number(orderTotals.subtotal_amount || 0);
          const isFullReturn = Boolean(refund?.breakdown?.is_full_return);
          let walletShare = 0;
          if (walletTotal > 0 && fullOrder.customer_id && refundAmt > 0 && (isFullReturn || subtotal > 0)) {
            walletShare = isFullReturn
              ? Math.min(walletTotal, refundAmt)
              : Math.min(walletTotal, refundAmt, Math.round((refundAmt / subtotal) * walletTotal * 100) / 100);
            if (walletShare > 0) {
              // Per REQUEST, not per item — one wallet credit however many items.
              const dedupeKey = `return_wallet:${primaryAction.id}`;
              const existing = await WalletTransaction.findOne({ where: { dedupe_key: dedupeKey } });
              if (!existing) {
                await WalletTransaction.create({
                  customer_id: fullOrder.customer_id,
                  amount: walletShare,
                  type: 'RETURN_REFUND',
                  status: 'completed',
                  dedupe_key: dedupeKey,
                  meta: { order_id: fullOrder.id, action_id: primaryAction.id, action_ids: groupActions.map((row) => row.id) },
                });
                await Customer.increment({ wallet_balance: walletShare }, { where: { id: fullOrder.customer_id } });
              }
            }
          }

          // Razorpay gateway refund (total minus the wallet share — the wallet
          // money never reached the gateway).
          if (refund && refundAmt > 0 && refund.payment_method === REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY) {
            const gatewayAmount = Math.round(Math.max(0, refundAmt - walletShare) * 100) / 100;
            const payment = gatewayAmount > 0
              ? await Payment.findOne({ where: { order_id: fullOrder.id, status: 'Paid' } })
              : null;
            if (gatewayAmount <= 0) {
              refund.update({
                status: REFUND_STATUS.COMPLETED,
                processed_at: new Date(),
                note: `${refund.note || ''}${refund.note ? ' | ' : ''}Fully refunded to wallet (Rs. ${walletShare.toLocaleString('en-IN')}).`.slice(0, 1000),
              }).catch((updateErr) => console.error('[Refund] Failed to mark wallet-only refund Completed:', updateErr.message));
            } else if (payment?.gateway_payment_id) {
              razorpayRefund(payment.gateway_payment_id, gatewayAmount, {
                reason: 'Customer return approved',
              }).then((gatewayRefund) => refund.update({ status: REFUND_STATUS.PROCESSING, gateway_refund_id: gatewayRefund?.id || null }))
                .catch((err) => {
                  console.error('[Razorpay] Return refund failed:', err.message);
                  // Surface the failure so admin can retry instead of it sitting silently Pending.
                  refund.update({
                    status: REFUND_STATUS.FAILED,
                    note: `${refund.note || ''}${refund.note ? ' | ' : ''}Automatic gateway refund failed: ${err.message}. Manual retry required.`.slice(0, 1000),
                  }).catch((updateErr) => console.error('[Razorpay] Failed to mark refund Failed:', updateErr.message));
                });
            }
          }
        } catch (err) {
          console.error('[OrderItemAction] initiate-refund async error:', err.message);
        }
      });

      return res.status(200).json({
        message: `Refund of Rs. ${returnRefundAmount.toLocaleString('en-IN')} initiated.`,
        amount: returnRefundAmount,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('[OrderItemAction] initiate refund error:', error);
      return res.status(500).json({ message: 'Unable to initiate this refund right now.' });
    }
  }

  // ── Explicitly trigger the outbound leg of a COMPLETED exchange ───────────────
  // POST /admin/item-actions/:actionId/ship-replacement
  // Mirrors initiateRefund's role for returns: completing an exchange only records
  // that the old item is back — no goods move until an admin presses this. It is
  // its own endpoint, deliberately NOT part of updateAdminStatus, because that one
  // 400s the moment the request is already Completed/Rejected/Cancelled — and the
  // courier webhook (ShipRocketController.webhook, on RETURN DELIVERED) completes
  // exchange requests automatically the instant the parcel is back, before any
  // admin ever gets a chance to click through updateAdminStatus. This endpoint only
  // requires COMPLETED (same precondition as initiateRefund), so it stays reachable
  // no matter which path closed the request.
  async shipReplacement(req, res) {
    try {
      await ensureOrderItemActionSchema();
      const action = await OrderItemAction.findByPk(req.params.actionId);
      if (!action) return res.status(404).json({ message: 'Request not found.' });
      if (String(action.action_type || '').toLowerCase() !== ACTION_TYPES.EXCHANGE) {
        return res.status(400).json({ message: 'Replacements can be shipped for exchange requests only.' });
      }

      const groupActions = await loadActionGroup(action);
      if (groupActions.some((row) => row.status !== ACTION_STATUS.COMPLETED)) {
        return res.status(400).json({ message: 'Complete the exchange first — ship the replacement once the old item is received.' });
      }

      const actionIds = groupActions.map((row) => row.id);
      const existing = await Shipment.findOne({
        where: { order_id: action.order_id, type: SHIPMENT_TYPE.FORWARD, exchange_action_id: { [Op.in]: actionIds } },
      });
      if (existing?.shiprocket_order_id || existing?.awb_number) {
        return res.status(400).json({
          message: 'A replacement has already been shipped for this exchange.',
          shipment_id: existing.id,
          awb: existing.awb_number,
        });
      }

      const replacement = await ExchangeReplacementService.createReplacement({
        orderId: action.order_id,
        actionIds,
      });

      if (!replacement.booked) {
        console.error(`[Exchange] Order #${action.order_id}: replacement NOT booked via admin trigger (${replacement.error || 'unknown'}) — shipment #${replacement.shipmentId} needs a manual re-book.`);
        return res.status(502).json({
          message: 'Could not book the replacement with the courier. The shipment is recorded and can be retried.',
          shipment_id: replacement.shipmentId,
          detail: replacement.error,
        });
      }

      console.log(`[Exchange] Order #${action.order_id}: replacement shipment #${replacement.shipmentId} pushed to ShipRocket (SR #${replacement.shiprocketOrderId}) via admin trigger.`);

      // createReplacement only calls ShipRocket's order-create endpoint, not the separate
      // assign-AWB one (same as the RTO redispatch path it mirrors) — so awb is normally
      // null here and gets filled in by the courier assignment webhook shortly after.
      return res.status(200).json({
        message: replacement.awb ? 'Replacement shipped.' : 'Replacement booked with the courier — AWB assignment pending.',
        shipment_id: replacement.shipmentId,
        shiprocket_order_id: replacement.shiprocketOrderId,
        awb: replacement.awb,
      });
    } catch (error) {
      console.error('[OrderItemAction] ship replacement error:', error);
      return res.status(500).json({ message: 'Unable to ship the replacement right now.' });
    }
  }
}

module.exports = new OrderItemActionController();
