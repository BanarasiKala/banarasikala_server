const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const OrderAddress = require('../models/OrderAddress');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const OrderLedger = require('../models/OrderLedger');
const PaymentTransaction = require('../models/PaymentTransaction');
const Shipment = require('../models/Shipment');
const ShipmentItem = require('../models/ShipmentItem');
const Payment = require('../models/Payment');
const OrderRefund = require('../models/OrderRefund');
const Product = require('../models/Product');
const Color = require('../models/Color');
const Customer = require('../models/Customer');
const WalletTransaction = require('../models/WalletTransaction');
const Feedback = require('../models/Feedback');
const OrderItemAction = require('../models/OrderItemAction');
const { sequelize } = require('../config/db');
const { DataTypes } = require('sequelize');
const crypto = require('crypto');
const EmailService = require('../services/EmailService');
const ShipRocketService = require('../services/ShipRocketService');
const WalletService = require('../services/WalletService');
const { refundPayment: razorpayRefund } = require('../services/RazorpayService');
const { config } = require('../config/env');
const { Op } = require("sequelize");
const { AppError } = require('../utils/http');
const { formatOrderNumber, formatProductCode } = require('../utils/codes');
const {
  ORDER_LIFECYCLE_COLUMNS,
  COD_BLOCK_MESSAGE,
  ensureOrderLifecycleColumns,
  isCodBlockedForContact,
  blockCustomerCodForOrder,
  toMoney,
} = require('../utils/orderLifecycle');
const { ensureOrderItemActionSchema, getActionableQuantity } = require('../utils/orderItemActions');
const { ensureOrderTransactionTables, REFUND_TYPE, REFUND_STATUS, REFUND_PAYMENT_METHOD } = require('../utils/orderTransactions');
const {
  ensureOrderModelV2Tables, SHIPMENT_TYPE, SHIPMENT_STATUS, ACTOR,
  LEDGER_ENTRY_TYPE, LEDGER_DIRECTION, LEDGER_REFERENCE_TYPE, RTO_RESOLUTION,
} = require('../utils/orderModelV2');
const RtoEvent = require('../models/RtoEvent');
const {
  seedPlacementLedger, getOrderBalance, deriveOrderTotals, appendEntry, settleCancellation,
} = require('../services/orderLedgerService');
const RefundTransaction = require('../models/RefundTransaction');
const { reconcileOrderRefunds } = require('../services/RefundSyncService');

const sortProductImages = (images = []) => [...images].sort((a, b) => {
  const left = Number.isFinite(Number(a.display_order)) ? Number(a.display_order) : 999;
  const right = Number.isFinite(Number(b.display_order)) ? Number(b.display_order) : 999;
  return left - right;
});

const pickOrderItemImage = (product, colorId) => {
  const images = Array.isArray(product?.images) ? sortProductImages(product.images) : [];
  if (!images.length) return "";

  const numericColorId = Number(colorId);
  const colorImages = Number.isFinite(numericColorId)
    ? images.filter((image) => Number(image.color_id) === numericColorId)
    : [];
  const coverImages = images.filter((image) => image.is_cover);
  const selected = colorImages[0] || coverImages[0] || images[0];

  return selected?.url || selected?.image_url || "";
};

// Sum action-row quantities for an item by type and/or status (counters are derived).
const sumActionQty = (actions = [], type = null, statuses = null) => (Array.isArray(actions) ? actions : [])
  .filter((a) => (!type || String(a.action_type) === type) && (!statuses || statuses.includes(a.status)))
  .reduce((sum, a) => sum + Number(a.quantity || 0), 0);

// V2 associations needed to rebuild the legacy order shape on read.
const ORDER_V2_INCLUDES = [
  { model: OrderAddress, as: 'Addresses' },
  { model: OrderLedger, as: 'Ledger' },
  { model: Shipment, as: 'Shipments' },
  { model: OrderStatusHistory, as: 'StatusHistory' },
];

// Rebuild the legacy order shape (address fields, money breakdown, AWB, status
// timeline) from the V2 associations so the frontend contract is unchanged.
const hydrateV2Fields = (json) => {
  // Shipping address → current version of order_addresses
  const addresses = Array.isArray(json.Addresses) ? json.Addresses : [];
  const currentAddress = addresses.find((a) => a.is_current)
    || addresses.slice().sort((a, b) => (b.version || 0) - (a.version || 0))[0]
    || null;
  if (currentAddress) {
    json.address = currentAddress.line;
    json.city = currentAddress.city;
    json.state = currentAddress.state;
    json.pincode = currentAddress.pincode;
    json.phone = currentAddress.phone;
    json.customer_name = json.customer_name || currentAddress.name;
  }

  // Money breakdown → order_ledger
  Object.assign(json, deriveOrderTotals(Array.isArray(json.Ledger) ? json.Ledger : []));

  // Courier / AWB → latest forward shipment
  const shipments = Array.isArray(json.Shipments) ? json.Shipments : [];
  const forward = shipments
    .filter((s) => s.type === SHIPMENT_TYPE.FORWARD)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0] || null;
  if (forward) {
    json.shiprocket_order_id = forward.shiprocket_order_id;
    json.shiprocket_awb = forward.awb_number;
    json.courier = forward.courier;
    // Alias for readers that expect courier_name (e.g. the order detail page).
    json.courier_name = forward.courier;
    json.selected_courier_data = forward.selected_courier_data;
  }

  // Status timeline → order_status_history (legacy {status,timestamp,actor,note} shape)
  const history = Array.isArray(json.StatusHistory) ? json.StatusHistory : [];
  json.status_history = history
    .slice()
    .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
    .map((h) => ({
      status: h.to_status,
      timestamp: h.created_at,
      actor: String(h.actor || '').toLowerCase(),
      note: h.reason || null,
    }));

  return json;
};

const serializeOrder = (order, feedbackRows = [], actionRows = []) => {
  const json = hydrateV2Fields(order.toJSON());
  const rows = Array.isArray(feedbackRows)
    ? feedbackRows.map((item) => (typeof item?.toJSON === 'function' ? item.toJSON() : item))
    : [];
  const feedbackByItem = new Map(
    rows.map((item) => [`${item.order_id}:${item.order_item_id}:${item.product_id}`, item]),
  );
  const nestedActions = (json.OrderItems || []).flatMap((item) => item.OrderItemActions || []);
  const actions = Array.isArray(actionRows)
    ? actionRows.map((item) => (typeof item?.toJSON === 'function' ? item.toJSON() : item))
    : [];
  actions.push(...nestedActions);
  const actionsByItem = actions.reduce((map, action) => {
    const key = String(action.order_item_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(action);
    return map;
  }, new Map());
  json.OrderItems = (json.OrderItems || []).map((item) => ({
    id: item.id,
    product_id: item.product_id,
    sku: item.sku || null,
    product_name: item.product_name || item.Product?.name || `Product #${item.product_id}`,
    quantity: item.quantity,
    price: item.price,
    colorId: item.colorId || item.color_id || null,
    color_name: item.Color?.name || null,
    color_hex: item.Color?.hex_code || null,
    image_url: pickOrderItemImage(item.Product, item.colorId || item.color_id),
    product_slug: item.Product?.slug || null,
    shipping_meta: item.shipping_meta || null,
    status: item.status || 'Active',
    // Counters derived from action rows (the columns were dropped in V2).
    cancelled_quantity: sumActionQty(actionsByItem.get(String(item.id)), 'cancel', ['Completed']),
    returned_quantity: sumActionQty(actionsByItem.get(String(item.id)), 'return', ['Completed']),
    exchanged_quantity: sumActionQty(actionsByItem.get(String(item.id)), 'exchange', ['Completed']),
    pending_action_quantity: sumActionQty(actionsByItem.get(String(item.id)), null, ['Initiated', 'Requested', 'Approved']),
    actionable_quantity: getActionableQuantity(item, actionsByItem.get(String(item.id)) || []),
    actions: actionsByItem.get(String(item.id)) || [],
    feedback: feedbackByItem.get(`${json.id}:${item.id}:${item.product_id}`) || null,
  }));
  // Expose refunds array and flatten the latest one to top-level for frontend compat
  const refunds = (json.Refunds || []).slice().sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  json.refunds = refunds;
  const latestRefund = refunds[0] || null;
  if (latestRefund) {
    json.refund_status = latestRefund.status;
    json.refund_amount = latestRefund.amount;
    json.refund_note = latestRefund.note;
    json.refund_bank_details = latestRefund.bank_details;
    json.refund_payment_reference = latestRefund.gateway_refund_id;
    json.refund_processed_at = latestRefund.processed_at;
  }
  return json;
};

let orderAccountingColumnsReady = false;
let orderColumnCache = null;

// V2: the legacy money/lifecycle columns were dropped (moved to order_ledger,
// shipments, etc.). Nothing to ensure on `orders` here anymore.
const REQUIRED_ORDER_COLUMNS = {
  ...ORDER_LIFECYCLE_COLUMNS,
};

const ensureOrderAccountingColumns = async () => {
  await ensureOrderLifecycleColumns();
  await ensureOrderTransactionTables();
  await ensureOrderModelV2Tables();
  const queryInterface = sequelize.getQueryInterface();
  const table = { tableName: 'orders', schema: config.dbSchema };
  if (orderAccountingColumnsReady && orderColumnCache) return orderColumnCache;
  let columns = await queryInterface.describeTable(table);
  for (const [column, definition] of Object.entries(REQUIRED_ORDER_COLUMNS)) {
    if (!columns[column]) {
      await queryInterface.addColumn(table, column, definition);
    }
  }
  columns = await queryInterface.describeTable(table);
  orderColumnCache = columns;
  orderAccountingColumnsReady = true;
  return columns;
};

const camelToSnake = (str) => str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const keepExistingColumns = (payload, columns) =>
  Object.fromEntries(Object.entries(payload).filter(([key]) => columns[key] || columns[camelToSnake(key)]));


let orderItemColumnsReady = false;
let orderItemColumnCache = null;

const ensureOrderItemAccountingColumns = async () => {
  await ensureOrderItemActionSchema();
  const queryInterface = sequelize.getQueryInterface();
  const table = { tableName: 'order_items', schema: config.dbSchema };
  if (orderItemColumnsReady && orderItemColumnCache) return orderItemColumnCache;
  const columns = await queryInterface.describeTable(table);
  orderItemColumnCache = columns;
  orderItemColumnsReady = true;
  return columns;
};

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const toPaise = (value) => Math.round(roundMoney(value) * 100);

const verifyRazorpayPayment = ({ orderId, paymentId, signature }) => {
  if (!orderId || !paymentId || !signature) return false;
  const expectedSignature = crypto
    .createHmac('sha256', config.razorpayKeySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expectedSignature === signature;
};

const getProductWeightKg = (product) => {
  const rawWeight = Number(product?.weight);
  if (!Number.isFinite(rawWeight) || rawWeight <= 0) return 0.5;
  return rawWeight;
};

const buildItemShippingMeta = ({
  item,
  product,
  allocationWeight,
  allocatedShipping,
  allocatedShippingDiscount,
  shippingDiscountReason,
}) => {
  const quantity = Math.max(1, Number(item.quantity || 1));
  const productWeightKg = getProductWeightKg(product);
  const boxWeightKg = Math.max(0, Number(config.packageWeightKg));
  const effectiveShippingPaid = Math.max(0, allocatedShipping - allocatedShippingDiscount);
  const isFirstOrderFreeShipping = shippingDiscountReason === 'first_order';
  const returnDeliveryDeduction = isFirstOrderFreeShipping ? 0 : allocatedShipping;

  return {
    product_weight_kg: roundMoney(productWeightKg),
    box_weight_kg: roundMoney(boxWeightKg),
    quantity,
    allocation_weight_kg: roundMoney(allocationWeight),
    delivery_charge: roundMoney(allocatedShipping),
    delivery_discount: roundMoney(allocatedShippingDiscount),
    delivery_paid: roundMoney(effectiveShippingPaid),
    refund_rules: {
      free_shipping_reason: shippingDiscountReason || null,
      exchange_delivery_deduction: 0,
      return_delivery_deduction: roundMoney(returnDeliveryDeduction),
      return_total_logistics_deduction: roundMoney(returnDeliveryDeduction),
      note: isFirstOrderFreeShipping
        ? 'First-order free shipping: delivery is not deducted on return.'
        : 'Return refund deducts the forward delivery charge. Exchange has no logistics deduction.',
    },
  };
};

const allocateItemShipping = ({ items, productMap, shippingCharge, shippingDiscount, shippingDiscountReason }) => {
  const lines = items.map((item) => {
    const quantity = Math.max(1, Number(item.quantity || 1));
    const product = productMap[item.id];
    const productWeightKg = getProductWeightKg(product);
    const allocationWeight = (productWeightKg + Math.max(0, Number(config.packageWeightKg))) * quantity;
    return { item, product, allocationWeight };
  });
  const totalWeight = lines.reduce((sum, line) => sum + line.allocationWeight, 0) || lines.length || 1;
  let remainingShipping = roundMoney(shippingCharge);
  let remainingDiscount = roundMoney(shippingDiscount);

  return lines.map((line, index) => {
    const isLast = index === lines.length - 1;
    const allocatedShipping = isLast
      ? remainingShipping
      : roundMoney((shippingCharge * line.allocationWeight) / totalWeight);
    const allocatedDiscount = isLast
      ? remainingDiscount
      : roundMoney((shippingDiscount * line.allocationWeight) / totalWeight);
    remainingShipping = roundMoney(remainingShipping - allocatedShipping);
    remainingDiscount = roundMoney(remainingDiscount - allocatedDiscount);

    return buildItemShippingMeta({
      item: line.item,
      product: line.product,
      allocationWeight: line.allocationWeight,
      allocatedShipping,
      allocatedShippingDiscount: allocatedDiscount,
      shippingDiscountReason,
    });
  });
};

const getColorStockValue = (product, colorId) => {
  const stocks = product?.color_stocks || {};
  return Number(stocks?.[colorId] ?? stocks?.[String(colorId)] ?? product?.stock_quantity ?? 0);
};

const decrementProductInventory = async ({ product, colorId, quantity, transaction }) => {
  const qty = Math.max(1, Number(quantity || 1));
  const stocks = { ...(product.color_stocks || {}) };
  const hasColor = colorId !== null && colorId !== undefined && colorId !== "";
  const currentColorStock = getColorStockValue(product, colorId);
  const currentTotalStock = Number(product.stock_quantity || 0);

  if (currentTotalStock < qty || currentColorStock < qty) {
    throw new AppError(`Only ${Math.max(0, Math.min(currentColorStock, currentTotalStock))} item(s) are available for ${product.name}.`, 400);
  }

  const updatePayload = { stock_quantity: currentTotalStock - qty };
  if (hasColor) {
    stocks[String(colorId)] = currentColorStock - qty;
    updatePayload.color_stocks = stocks;
  }

  await product.update(updatePayload, { transaction });
};

// Cancellation is whole-order only and allowed only while the order is still in
// its initial (pre-dispatch) state. 'Processing' / 'AWB Assigned' are reached
// automatically by the ShipRocket push seconds after placement, so they count as
// "unchanged". Anything beyond (shipped, delivered, RTO, admin-progressed…) locks
// the order. Allowlist so unexpected statuses default to "not cancellable".
const CANCELLABLE_STATUSES = ['pending', 'processing', 'awb assigned'];

class OrderController {
  async createOrder(req, res) {
    const t = await sequelize.transaction();
    try {
      await ensureOrderTransactionTables();
      await ensureOrderModelV2Tables();
      const {
        customer_name, customer_email, address, city, state, pincode, phone,
        subtotal_amount, shipping_charge = 0, shipping_discount_reason = null,
        selected_courier_data = null, items, coupon_code, wallet_amount = 0,
        is_gift = false, gift_message = null,
        payment_method = 'Prepaid', payment_status = 'Paid',
        payment_gateway = null, gateway_order_id = null, gateway_payment_id = null,
        gateway_signature = null, gateway_amount_paise = null, gateway_currency = 'INR',
        payment_gateway_response = null
      } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        await t.rollback();
        return res.status(400).json({ message: 'Order items are required' });
      }

      // Idempotency: prevent duplicate orders from network retries
      if (gateway_payment_id) {
        const existingPayment = await Payment.findOne({ where: { gateway_payment_id }, transaction: t });
        if (existingPayment) {
          const existingOrder = await Order.findByPk(existingPayment.order_id, { transaction: t });
          if (existingOrder) {
            await t.rollback();
            return res.status(200).json({ orderId: existingOrder.id, order_number: existingOrder.order_number, duplicate: true });
          }
        }
      }

      const productIds = [...new Set(items.map((item) => item.id).filter(Boolean))];
      const products = await Product.findAll({
        where: { id: productIds },
        attributes: ['id', 'name', 'sku', 'variant_skus', 'weight', 'stock_quantity', 'color_stocks', 'status'],
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      const productMap = Object.fromEntries(products.map((p) => [p.id, p]));
      const missingProductId = productIds.find((id) => !productMap[id]);
      if (missingProductId) {
        await t.rollback();
        return res.status(400).json({ message: `Invalid product in cart: ${missingProductId}` });
      }
      // Pre-validate all items before any stock decrement
      const stockErrors = [];
      for (const item of items) {
        const productForStock = productMap[item.id];
        if (productForStock.status !== 'active') {
          stockErrors.push(`${productForStock.name} is currently unavailable.`);
          continue;
        }
        const colorId = item.colorId || item.color_id || null;
        const available = Math.min(
          getColorStockValue(productForStock, colorId),
          Number(productForStock.stock_quantity || 0)
        );
        const qty = Math.max(1, Number(item.quantity || 1));
        if (available < qty) {
          stockErrors.push(`Only ${Math.max(0, available)} item(s) available for ${productForStock.name}.`);
        }
      }
      if (stockErrors.length > 0) {
        await t.rollback();
        return res.status(400).json({ message: stockErrors[0], errors: stockErrors });
      }

      for (const item of items) {
        await decrementProductInventory({
          product: productMap[item.id],
          colorId: item.colorId || item.color_id || null,
          quantity: item.quantity,
          transaction: t,
        });
      }

      const colorIds = [...new Set(items.map((item) => item.colorId || item.color_id).filter(Boolean))];
      const colors = colorIds.length
        ? await Color.findAll({
          where: { id: colorIds },
          attributes: ['id', 'name', 'slug', 'hex_code'],
          transaction: t,
        })
        : [];
      const colorMap = Object.fromEntries(colors.map((color) => [String(color.id), color]));
      const enrichedItems = items.map((item) => {
        const productForItem = productMap[item.id];
        const colorId = item.colorId || item.color_id || null;
        const variantSku = productForItem?.variant_skus?.[String(colorId)] || productForItem?.sku || formatProductCode(productForItem?.id || item.id);
        return {
          ...item,
          sku: variantSku,
        };
      });

      const authenticatedCustomer = req.userRole === 'customer' && req.user ? req.user : null;
      const customer = authenticatedCustomer
        || (customer_email ? await Customer.findOne({ where: { email: customer_email }, transaction: t }) : null);

      let discount_amount = 0;
      const itemSubtotal = Number(subtotal_amount || items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0));
      const actualShippingCharge = Math.max(0, Number(shipping_charge || 0));
      const actualShippingDiscount = actualShippingCharge;
      const effectiveShippingDiscountReason = actualShippingCharge > 0 ? (shipping_discount_reason || 'free_delivery') : null;
      const normalizedPaymentMethod = String(payment_method || 'Prepaid').toUpperCase() === 'COD' ? 'COD' : 'Prepaid';
      const normalizedPaymentStatus = normalizedPaymentMethod === 'COD' ? 'Pending' : (payment_status || 'Paid');
      const actualPlatformFee = Math.max(0, Number(config.platformFeeAmount || 0));
      const actualCodFee = normalizedPaymentMethod === 'COD' ? Math.max(0, Number(config.codFeeAmount || 0)) : 0;
      const actualPaymentFee = actualPlatformFee + actualCodFee;
      const actualPaymentDiscount = normalizedPaymentMethod === 'Prepaid'
        ? Math.min(Number(config.prepaidDiscountAmount || 0), itemSubtotal)
        : 0;
      // Gift charge is computed server-side from config so the client cannot tamper with it.
      const isGiftOrder = Boolean(is_gift);
      const actualGiftCharge = isGiftOrder ? Math.max(0, Number(config.giftChargeAmount || 0)) : 0;
      const cleanGiftMessage = isGiftOrder ? (String(gift_message || '').trim().slice(0, 500) || null) : null;
      let final_total = Math.max(0, itemSubtotal + actualShippingCharge - actualShippingDiscount + actualPaymentFee - actualPaymentDiscount + actualGiftCharge);
      const normalizedGateway = normalizedPaymentMethod === 'Prepaid'
        ? String(payment_gateway || 'razorpay').trim().toLowerCase()
        : null;
      let paymentVerifiedAt = null;

      if (normalizedPaymentMethod === 'COD' && itemSubtotal > config.codMaxAmount) {
        await t.rollback();
        return res.status(400).json({ message: `COD is available only up to Rs. ${config.codMaxAmount}.` });
      }

      if (normalizedPaymentMethod === 'COD') {
        const codBlocked = await isCodBlockedForContact({
          customerId: customer?.id,
          email: customer?.email || customer_email,
          phone,
          transaction: t,
        });

        if (codBlocked) {
          await t.rollback();
          return res.status(403).json({ message: COD_BLOCK_MESSAGE });
        }
      }

      if (coupon_code) {
        const Coupon = require('../models/Coupon');
        const CouponService = require('../services/CouponService');
        const coupon = await Coupon.findOne({
          where: { code: coupon_code, is_active: true },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (coupon) {
          // Global usage limit. The coupon row is locked above, so concurrent
          // orders for the same coupon are serialized and these checks are race-safe.
          if (coupon.usage_limit != null && Number(coupon.usage_count || 0) >= Number(coupon.usage_limit)) {
            await t.rollback();
            return res.status(400).json({ message: 'This coupon has reached its usage limit.' });
          }
          // Per-user usage limit, derived from this shopper's non-cancelled orders.
          const perUserLimit = Number(coupon.usage_limit_per_user || 0);
          if (perUserLimit > 0) {
            const used = await CouponService.getUserCouponUsage(
              coupon_code,
              { customerId: customer?.id, email: customer?.email || customer_email },
              { transaction: t },
            );
            if (used >= perUserLimit) {
              await t.rollback();
              return res.status(400).json({ message: 'You have already used this coupon.' });
            }
          }
          if (coupon.discount_type === 'percentage') {
            discount_amount = (itemSubtotal * coupon.discount_percent) / 100;
            if (coupon.max_discount_amount) {
              discount_amount = Math.min(discount_amount, coupon.max_discount_amount);
            }
          } else {
            discount_amount = coupon.discount_amount;
          }
          final_total = Math.max(0, final_total - discount_amount);
          await coupon.increment('usage_count', { by: 1, transaction: t });
        }
      }

      let walletDebit = 0;
      if (Number(wallet_amount || 0) > 0) {
        if (!customer) {
          await t.rollback();
          return res.status(400).json({ message: 'Wallet can be used only by logged in customers.' });
        }

        const lockedCustomer = await Customer.findByPk(customer.id, { transaction: t, lock: t.LOCK.UPDATE });
        const walletBalance = Number(lockedCustomer?.wallet_balance || 0);
        walletDebit = Math.min(Number(wallet_amount || 0), walletBalance, final_total);
        if (walletDebit > 0) {
          final_total = Math.max(0, final_total - walletDebit);
        }
      }

      const expectedGatewayAmountPaise = toPaise(final_total);

      if (normalizedPaymentMethod === 'Prepaid') {
        if (normalizedGateway !== 'razorpay') {
          await t.rollback();
          return res.status(400).json({ message: 'Online payment provider is not supported.' });
        }

        const signatureValid = verifyRazorpayPayment({
          orderId: gateway_order_id,
          paymentId: gateway_payment_id,
          signature: gateway_signature,
        });

        if (!signatureValid) {
          await t.rollback();
          return res.status(400).json({ message: 'Payment could not be verified. Please try again.' });
        }

        if (gateway_amount_paise !== null && gateway_amount_paise !== undefined) {
          const paidAmountPaise = Number(gateway_amount_paise);
          if (!Number.isFinite(paidAmountPaise) || paidAmountPaise !== expectedGatewayAmountPaise) {
            await t.rollback();
            return res.status(400).json({ message: 'Payment amount does not match this order.' });
          }
        }

        paymentVerifiedAt = new Date();
      }

      const itemShippingMetas = allocateItemShipping({
        items,
        productMap,
        shippingCharge: actualShippingCharge,
        shippingDiscount: actualShippingDiscount,
        shippingDiscountReason: effectiveShippingDiscountReason,
      });

      // ── orders (slim V2 row — money/address/lifecycle live in their own tables)
      const order = await Order.create({
        customer_id: customer?.id || null,
        customer_name: customer_name || customer?.name,
        customer_email: customer?.email || customer_email,
        coupon_code: coupon_code || null,
        is_gift: isGiftOrder,
        gift_message: cleanGiftMessage,
        status: 'Pending',
        payment_method: normalizedPaymentMethod,
        payment_status: normalizedPaymentStatus,
      }, { transaction: t });

      // Generate order_number after insert — uses the DB-assigned id
      const orderNumber = formatOrderNumber(new Date(), order.id);
      await order.update({ order_number: orderNumber }, { transaction: t });
      order.order_number = orderNumber;

      // ── order_addresses (version 1 snapshot) + current pointer
      const orderAddress = await OrderAddress.create({
        order_id: order.id,
        version: 1,
        is_current: true,
        name: customer_name || customer?.name,
        phone,
        line: address,
        city,
        state: state || 'Uttar Pradesh',
        pincode,
      }, { transaction: t });
      await order.update({ current_address_id: orderAddress.id }, { transaction: t });
      order.current_address_id = orderAddress.id;

      // ── order_items (price snapshot)
      const orderItems = enrichedItems.map((item, index) => ({
        order_id: order.id,
        product_id: item.id,
        colorId: item.colorId || item.color_id || null,
        quantity: item.quantity,
        price: item.price,
        product_name: item.name || item.product_name,
        sku: item.sku,
        status: 'Active',
        shipping_meta: itemShippingMetas[index] || null,
      }));
      const createdOrderItems = await OrderItem.bulkCreate(orderItems, { transaction: t });

      if (walletDebit > 0 && customer) {
        await WalletTransaction.create({
          customer_id: customer.id,
          amount: -walletDebit,
          type: "ORDER_PAYMENT",
          status: "completed",
          available_at: null,
          dedupe_key: `order_wallet:${order.id}`,
          meta: { order_id: order.id },
        }, { transaction: t });

        await Customer.decrement(
          { wallet_balance: walletDebit },
          { where: { id: customer.id }, transaction: t },
        );
      }

      // ── order_ledger (source of truth for money). Prepaid nets to 0; COD
      // leaves the payable balance owed until COD_COLLECTION on delivery.
      const ledgerEntries = await seedPlacementLedger({
        orderId: order.id,
        paymentMethod: normalizedPaymentMethod,
        itemSubtotal,
        netShipping: Math.max(0, actualShippingCharge - actualShippingDiscount),
        platformFee: actualPlatformFee,
        codFee: actualCodFee,
        giftCharge: actualGiftCharge,
        couponDiscount: discount_amount,
        prepaidDiscount: actualPaymentDiscount,
        walletCredit: walletDebit,
        paymentReceived: final_total,
        transaction: t,
      });
      const paymentLedgerEntry = ledgerEntries.find((e) => e.entry_type === 'PAYMENT') || null;

      // ── order_status_history (initial transition)
      await OrderStatusHistory.create({
        order_id: order.id,
        from_status: null,
        to_status: 'Pending',
        actor: ACTOR.CUSTOMER,
        reason: 'Order placed',
      }, { transaction: t });

      // ── payment_transactions (gateway record → ledger PAYMENT entry)
      await PaymentTransaction.create({
        order_id: order.id,
        ledger_entry_id: paymentLedgerEntry?.id || null,
        gateway: normalizedGateway || (normalizedPaymentMethod === 'COD' ? 'cod' : null),
        gateway_ref: normalizedPaymentMethod === 'Prepaid' ? gateway_payment_id : null,
        amount: roundMoney(final_total),
        status: normalizedPaymentMethod === 'COD' ? 'Initiated' : 'Paid',
        gateway_response: normalizedPaymentMethod === 'Prepaid' ? payment_gateway_response : null,
      }, { transaction: t });

      // Legacy payments row — kept for idempotency (see gateway_payment_id check
      // above) and backward-compatible readers until they migrate to V2.
      await Payment.create({
        order_id: order.id,
        payment_method: normalizedPaymentMethod,
        payment_gateway: normalizedGateway,
        gateway_order_id: normalizedPaymentMethod === 'Prepaid' ? gateway_order_id : null,
        gateway_payment_id: normalizedPaymentMethod === 'Prepaid' ? gateway_payment_id : null,
        gateway_signature: normalizedPaymentMethod === 'Prepaid' ? gateway_signature : null,
        amount: roundMoney(final_total),
        amount_paise: normalizedPaymentMethod === 'Prepaid' ? expectedGatewayAmountPaise : null,
        currency: String(gateway_currency || 'INR').toUpperCase(),
        status: normalizedPaymentMethod === 'COD' ? 'Pending' : 'Paid',
        gateway_response: normalizedPaymentMethod === 'Prepaid' ? payment_gateway_response : null,
        verified_at: paymentVerifiedAt,
      }, { transaction: t });

      await t.commit();

      // ── Fire & forget: email confirmation (enrich with the computed total) ────
      EmailService.sendOrderConfirmation({ ...order.toJSON(), total_amount: final_total }, enrichedItems);

      // ── Fire & forget: push to ShipRocket (never blocks customer response) ──
      (async () => {
        try {
          // The customer may cancel in the seconds before this push runs —
          // don't create an SR order (or advance the status) for a dead order.
          const liveOrder = await Order.findByPk(order.id, { attributes: ['id', 'status'] });
          if (String(liveOrder?.status || '').toLowerCase() === 'cancelled') {
            console.warn(`[ShipRocket] Order #${order.id} was cancelled before the SR push — skipping.`);
            return;
          }

          const srItems = enrichedItems.map((item, idx) => ({
            product_id: item.id,
            quantity: item.quantity,
            price: item.price,
            name: item.name || item.product_name || `Product ${idx + 1}`,
            sku: item.sku,
          }));

          // Address + totals no longer live on the order — pass snapshot + ledger totals.
          const srResult = await ShipRocketService.createOrder({
            order: {
              ...order.toJSON(),
              address,
              city,
              pincode,
              phone,
              state: state || 'Uttar Pradesh',
              total_amount: final_total,
              discount_amount,
            },
            items: srItems,
          });

          // Record the forward shipment (a redispatch after RTO would be a new row).
          const shipment = await Shipment.create({
            order_id: order.id,
            address_id: orderAddress.id,
            type: SHIPMENT_TYPE.FORWARD,
            status: srResult?.awb_code ? SHIPMENT_STATUS.DISPATCHED : SHIPMENT_STATUS.CREATED,
            courier: srResult?.courier_name || null,
            awb_number: srResult?.awb_code ? String(srResult.awb_code) : null,
            shiprocket_order_id: srResult?.order_id ? String(srResult.order_id) : null,
            selected_courier_data: selected_courier_data || null,
            forward_charge: Math.max(0, actualShippingCharge),
            dispatched_at: srResult?.awb_code ? new Date() : null,
          });
          await ShipmentItem.bulkCreate(
            createdOrderItems.map((row) => ({
              shipment_id: shipment.id,
              order_item_id: row.id,
              quantity: row.quantity,
            })),
          );

          const nextStatus = srResult?.awb_code ? 'AWB Assigned' : 'Processing';
          // Conditional update: only advance a still-Pending order so this can
          // never overwrite a cancellation that happened while SR was pushed.
          const [advanced] = await Order.update(
            { status: nextStatus },
            { where: { id: order.id, status: 'Pending' } },
          );
          if (advanced > 0) {
            await OrderStatusHistory.create({
              order_id: order.id,
              from_status: 'Pending',
              to_status: nextStatus,
              actor: ACTOR.SYSTEM,
              reason: 'ShipRocket order created',
            });
          } else {
            // Order moved on (e.g. cancelled) while SR was creating — cancel the
            // freshly created SR order so it doesn't get shipped.
            const current = await Order.findByPk(order.id, { attributes: ['status'] });
            if (String(current?.status || '').toLowerCase() === 'cancelled' && srResult?.order_id) {
              await ShipRocketService.cancelOrders([String(srResult.order_id)]).catch((e) => console.error(`[ShipRocket] Late cancel failed for order #${order.id}:`, e?.response?.data || e.message));
              await shipment.update({ status: SHIPMENT_STATUS.CANCELLED });
              console.warn(`[ShipRocket] Order #${order.id} was cancelled during the SR push — SR order ${srResult.order_id} cancelled.`);
            }
          }

          console.log(`[ShipRocket] ✅ Order #${order.id} pushed → SR Order: ${srResult.order_id}, Shipment: ${srResult.shipment_id}`);
        } catch (srErr) {
          // Log but never crash the main order flow
          console.error(`[ShipRocket] ⚠️  Order #${order.id} push failed:`, srErr?.response?.data || srErr.message);
        }
      })();

      res.status(201).json({ message: 'Order placed successfully', orderId: order.id, orderNumber: order.order_number });
    } catch (error) {
      await t.rollback();
      res.status(error.status || 500).json({ message: error.message });
    }
  }

   async getMyOrders(req, res) {
    try {
      await ensureOrderAccountingColumns();
      await ensureOrderItemActionSchema();
      const { status, paymentMethod, customer, q } = req.query;
      const where = {};
      if (status && status !== 'all') where.status = status;
      if (paymentMethod && paymentMethod !== 'all') where.payment_method = paymentMethod;
      const customerSearch = String(customer || q || '').trim();
      if (customerSearch) {
        // phone now lives on order_addresses; name/email/order_number remain searchable here.
        where[Op.or] = [
          { customer_name: { [Op.iLike]: `%${customerSearch}%` } },
          { customer_email: { [Op.iLike]: `%${customerSearch}%` } },
          { order_number: { [Op.iLike]: `%${customerSearch}%` } },
        ];
      }
      const orders = await Order.findAll({
        where,
        include: [
          {
            model: OrderItem,
            include: [
              { model: Product, attributes: ['id', 'name', 'slug', 'images'] },
              { model: Color, attributes: ['id', 'name', 'slug', 'hex_code'] },
              { model: OrderItemAction },
            ],
          },
          { model: OrderRefund, as: 'Refunds' },
          ...ORDER_V2_INCLUDES,
        ],
        order: [['createdAt', 'DESC']],
      });
      res.status(200).json(orders.map((order) => serializeOrder(order)));
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }
  async saveRefundBankDetails(req, res) {
    try {
      await ensureOrderAccountingColumns();
      if (!req.user?.id || req.userRole === 'admin') {
        return res.status(401).json({ message: 'Customer authentication required' });
      }

      const order = await Order.findByPk(req.params.id);
      if (!order) return res.status(404).json({ message: 'Order not found' });
      const isOwnedByCustomerId = Number(order.customer_id) === Number(req.user.id);
      const isLegacyOwnedByEmail = !order.customer_id
        && req.user?.email
        && String(order.customer_email || '').toLowerCase() === String(req.user.email).toLowerCase();
      if (!isOwnedByCustomerId && !isLegacyOwnedByEmail) {
        return res.status(403).json({ message: 'This order does not belong to this customer.' });
      }

      const accountHolderName = String(req.body.account_holder_name || '').trim();
      const accountNumber = String(req.body.account_number || '').replace(/\s+/g, '');
      const ifscCode = String(req.body.ifsc_code || '').trim().toUpperCase();
      const bankName = String(req.body.bank_name || '').trim();
      const branchName = String(req.body.branch_name || '').trim();

      if (accountHolderName.length < 3) {
        return res.status(400).json({ message: 'Please enter the bank account holder name.' });
      }
      if (!/^\d{6,18}$/.test(accountNumber)) {
        return res.status(400).json({ message: 'Please enter a valid bank account number.' });
      }
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
        return res.status(400).json({ message: 'Please enter a valid IFSC code.' });
      }
      if (bankName.length < 2) {
        return res.status(400).json({ message: 'Please enter the bank name.' });
      }

      let refund = await OrderRefund.findOne({
        where: { order_id: order.id },
        order: [['created_at', 'DESC']],
      });
      if (!refund) {
        refund = await OrderRefund.create({
          order_id: order.id,
          refund_type: REFUND_TYPE.RETURN,
          amount: 0,
          status: REFUND_STATUS.PENDING,
          payment_method: REFUND_PAYMENT_METHOD.BANK_TRANSFER,
        });
      }
      await refund.update({
        bank_details: {
          account_holder_name: accountHolderName,
          account_number_last4: accountNumber.slice(-4),
          account_number: accountNumber,
          ifsc_code: ifscCode,
          bank_name: bankName,
          branch_name: branchName || null,
          updated_at: new Date().toISOString(),
        },
        payment_method: REFUND_PAYMENT_METHOD.BANK_TRANSFER,
        status: refund.status === REFUND_STATUS.NOT_REQUIRED ? refund.status : REFUND_STATUS.PENDING,
      });

      return res.status(200).json({ message: 'Bank details saved for refund.' });
    } catch (error) {
      console.error('[Order] saveRefundBankDetails error:', error.message);
      return res.status(500).json({ message: 'Unable to save bank details right now.' });
    }
  }

  async updateRefundStatus(req, res) {
    try {
      await ensureOrderAccountingColumns();
      const order = await Order.findByPk(req.params.id);
      if (!order) return res.status(404).json({ message: 'Order not found' });

      const refundStatus = String(req.body.refund_status || '').trim();
      if (!refundStatus) return res.status(400).json({ message: 'refund_status is required' });

      const refund = await OrderRefund.findOne({
        where: { order_id: order.id },
        order: [['created_at', 'DESC']],
      });
      if (!refund) return res.status(404).json({ message: 'No refund record found for this order.' });

      const isCompleted = String(refundStatus).toLowerCase().includes('paid') || String(refundStatus).toLowerCase().includes('processed') || String(refundStatus).toLowerCase().includes('completed');
      await refund.update({
        status: refundStatus,
        note: req.body.refund_note || refund.note,
        gateway_refund_id: req.body.refund_payment_reference || refund.gateway_refund_id,
        ...(isCompleted ? { processed_at: new Date(), processed_by: req.user?.id || null } : {}),
      });

      const updatedOrder = await Order.findByPk(order.id, {
        include: [{ model: OrderRefund, as: 'Refunds' }, ...ORDER_V2_INCLUDES],
      });
      return res.status(200).json({ message: 'Refund status updated.', order: serializeOrder(updatedOrder) });
    } catch (error) {
      console.error('[Order] updateRefundStatus error:', error.message);
      return res.status(500).json({ message: 'Unable to update refund status right now.' });
    }
  }

  // ── Get all orders for a customer email ─────────────────────────────────────
  async getOrdersByEmail(req, res) {
    try {
      await ensureOrderAccountingColumns();
      const { email } = req.params;
      const orders = await Order.findAll({
        where: { customer_email: email },
        include: [
          {
            model: OrderItem,
            include: [
              { model: Product, attributes: ['id', 'name', 'slug', 'images'] },
              { model: Color, attributes: ['id', 'name', 'slug', 'hex_code'] },
              { model: OrderItemAction },
            ],
          },
          { model: OrderRefund, as: 'Refunds' },
          ...ORDER_V2_INCLUDES,
        ],
        order: [['createdAt', 'DESC']],
      });
      res.status(200).json(orders.map(serializeOrder));
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  // ── Live tracking via ShipRocket AWB / SR Order ID ──────────────────────────
  async trackOrder(req, res) {
    try {
      const { orderId } = req.params;
      const order = await Order.findByPk(orderId);
      if (!order) return res.status(404).json({ message: 'Order not found' });
      const isOwnedByCustomerId = Number(order.customer_id) === Number(req.user?.id);
      const isLegacyOwnedByEmail = !order.customer_id
        && req.user?.email
        && String(order.customer_email || '').toLowerCase() === String(req.user.email).toLowerCase();
      if (req.userRole !== 'admin' && !isOwnedByCustomerId && !isLegacyOwnedByEmail) {
        return res.status(403).json({ message: 'This order does not belong to this customer.' });
      }

      const EMPTY_TRACKING = { tracking_data: { shipment_track_activities: [] } };

      // ── Forward shipment: AWB first, fall back to SR order ID ──
      // The AWB / SR order id now live on the latest forward shipment, not the order.
      const forwardShipment = await Shipment.findOne({
        where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD },
        order: [['created_at', 'DESC']],
      });
      let forward = { source: 'none', tracking: null };
      try {
        if (forwardShipment?.awb_number) {
          forward = { source: 'awb', tracking: await ShipRocketService.trackByAWB(forwardShipment.awb_number) };
        } else if (forwardShipment?.shiprocket_order_id) {
          forward = { source: 'order_id', tracking: await ShipRocketService.trackByOrderId(forwardShipment.shiprocket_order_id) };
        }
      } catch (forwardError) {
        console.error('[Track] Forward lookup error:', forwardError?.response?.data || forwardError.message);
        forward = { source: 'unavailable', tracking: EMPTY_TRACKING };
      }

      // ── Reverse shipments: active return/exchange pickups carry their own SR ids ──
      const reverse = [];
      try {
        await ensureOrderItemActionSchema();
        const reverseActions = await OrderItemAction.findAll({
          where: {
            order_id: order.id,
            action_type: { [Op.in]: ['return', 'exchange'] },
            status: { [Op.notIn]: ['Rejected', 'Cancelled'] },
            [Op.or]: [
              { shiprocket_return_awb: { [Op.ne]: null } },
              { shiprocket_return_order_id: { [Op.ne]: null } },
            ],
          },
          order: [['created_at', 'DESC']],
        });

        const seen = new Set();
        for (const action of reverseActions) {
          const key = action.shiprocket_return_awb || action.shiprocket_return_order_id;
          if (!key || seen.has(key)) continue; // one entry per distinct reverse shipment
          seen.add(key);
          try {
            const tracking = action.shiprocket_return_awb
              ? await ShipRocketService.trackByAWB(action.shiprocket_return_awb)
              : await ShipRocketService.trackByOrderId(action.shiprocket_return_order_id);
            reverse.push({
              type: action.action_type,
              source: action.shiprocket_return_awb ? 'awb' : 'order_id',
              awb: action.shiprocket_return_awb || null,
              tracking,
            });
          } catch (reverseError) {
            console.error('[Track] Reverse lookup error:', reverseError?.response?.data || reverseError.message);
            reverse.push({
              type: action.action_type,
              source: 'unavailable',
              awb: action.shiprocket_return_awb || null,
              tracking: EMPTY_TRACKING,
            });
          }
        }
      } catch (reverseListError) {
        console.error('[Track] Reverse list error:', reverseListError.message);
      }

      if (forward.source === 'none' && !reverse.length) {
        return res.status(200).json({ source: 'none', message: 'Shipment not yet dispatched', reverse: [] });
      }
      return res.status(200).json({ source: forward.source, tracking: forward.tracking, reverse });
    } catch (error) {
      console.error('[Track] Error:', error?.response?.data || error.message);
      return res.status(200).json({
        source: 'unavailable',
        message: 'Tracking service is temporarily unavailable. Please try again shortly.',
        tracking: { tracking_data: { shipment_track_activities: [] } },
        reverse: [],
      });
    }
  }

  async getCurrentCustomerOrders(req, res) {
    try {
      await ensureOrderAccountingColumns();
      await ensureOrderItemActionSchema();
      if (!req.user?.id || req.userRole === 'admin') {
        return res.status(401).json({ message: 'Customer authentication required' });
      }

      const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const offset = (pageNum - 1) * pageSize;

      const { count, rows: orders } = await Order.findAndCountAll({
        where: {
          [Op.or]: [
            { customer_id: req.user.id },
            { customer_id: null, customer_email: req.user.email },
          ],
        },
        include: [
          {
            model: OrderItem,
            include: [
              { model: Product, attributes: ['id', 'name', 'slug', 'images'] },
              { model: Color, attributes: ['id', 'name', 'slug', 'hex_code'] },
              { model: OrderItemAction },
            ],
          },
          { model: OrderRefund, as: 'Refunds' },
          ...ORDER_V2_INCLUDES,
        ],
        order: [['createdAt', 'DESC']],
        limit: pageSize,
        offset,
        distinct: true,
      });
      const orderIds = orders.map((order) => order.id);
      const feedbacks = orderIds.length
        ? await Feedback.findAll({
          where: { customer_id: req.user.id, order_id: orderIds },
          attributes: ['id', 'order_id', 'order_item_id', 'product_id', 'rating', 'comment', 'title', 'images', 'is_approved'],
        })
        : [];
      const serialized = orders.map((order) => serializeOrder(order, feedbacks.map((item) => item.toJSON())));
      res.status(200).json(serialized);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getCustomerOrderById(req, res) {
    try {
      await ensureOrderAccountingColumns();
      await ensureOrderItemActionSchema();
      if (!req.user?.id || req.userRole === 'admin') {
        return res.status(401).json({ message: 'Customer authentication required' });
      }

      // Lazy refund sync: if this order still has a Processing gateway refund,
      // ask Razorpay for its current status so the customer sees "Refunded" as
      // soon as it lands — no webhook required. Cheap no-op otherwise.
      await reconcileOrderRefunds(req.params.id);

      const order = await Order.findOne({
        where: {
          id: req.params.id,
          [Op.or]: [
            { customer_id: req.user.id },
            { customer_id: null, customer_email: req.user.email },
          ],
        },
        include: [
          {
            model: OrderItem,
            include: [
              { model: Product, attributes: ['id', 'name', 'slug', 'images'] },
              { model: Color, attributes: ['id', 'name', 'slug', 'hex_code'] },
              { model: OrderItemAction },
            ],
          },
          { model: OrderRefund, as: 'Refunds' },
          ...ORDER_V2_INCLUDES,
        ],
      });

      if (!order) return res.status(404).json({ message: 'Order not found' });
      const feedbacks = await Feedback.findAll({
        where: { customer_id: req.user.id, order_id: order.id },
        attributes: ['id', 'order_id', 'order_item_id', 'product_id', 'rating', 'comment', 'title', 'images', 'is_approved'],
      });
      return res.status(200).json(serializeOrder(order, feedbacks.map((item) => item.toJSON())));
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }

  async cancelOrder(req, res) {
    const t = await sequelize.transaction();
    try {
      const { id } = req.params;
      const order = await Order.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });

      if (!order) {
        await t.rollback();
        return res.status(404).json({ message: 'Order not found' });
      }

      const isOwnedByCustomerId = Number(order.customer_id) === Number(req.user?.id);
      const isLegacyOwnedByEmail = !order.customer_id
        && req.user?.email
        && String(order.customer_email || '').toLowerCase() === String(req.user.email).toLowerCase();
      if (req.userRole !== 'admin' && !isOwnedByCustomerId && !isLegacyOwnedByEmail) {
        await t.rollback();
        return res.status(403).json({ message: 'This order does not belong to this customer.' });
      }

      const currentStatus = String(order.status || '').toLowerCase();
      if (['cancelled', 'delivered'].includes(currentStatus)) {
        await t.rollback();
        return res.status(400).json({ message: `Order is already ${order.status}.` });
      }
      if (!CANCELLABLE_STATUSES.includes(currentStatus)) {
        await t.rollback();
        return res.status(400).json({ message: `Order status has changed to "${order.status}" and it can no longer be cancelled.` });
      }
      // Physical safety net: even within the allowed statuses, block once the
      // parcel has actually left (courier picked up / in transit).
      const dispatchedShipment = await Shipment.findOne({
        where: {
          order_id: order.id,
          type: SHIPMENT_TYPE.FORWARD,
          status: { [Op.in]: [SHIPMENT_STATUS.IN_TRANSIT, SHIPMENT_STATUS.DELIVERED, SHIPMENT_STATUS.RTO] },
        },
        transaction: t,
      });
      if (dispatchedShipment) {
        await t.rollback();
        return res.status(400).json({ message: 'Order has already been dispatched and can no longer be cancelled.' });
      }

      const createdAt = new Date(order.createdAt);
      const hoursSinceOrder = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceOrder > 24) {
        await t.rollback();
        return res.status(400).json({ message: 'Cancellation is available only within 24 hours of placing the order.' });
      }

      // Restock all non-cancelled items
      const activeOrderItems = await OrderItem.findAll({
        where: { order_id: id, status: { [Op.ne]: 'Cancelled' } },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      for (const oi of activeOrderItems) {
        const prod = await Product.findByPk(oi.product_id, {
          attributes: ['id', 'stock_quantity', 'color_stocks'],
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (prod) {
          const qty = Number(oi.quantity || 1);
          const colorId = oi.colorId || oi.color_id;
          const stocks = { ...(prod.color_stocks || {}) };
          const hasColor = colorId !== null && colorId !== undefined && colorId !== '';
          const restockPayload = { stock_quantity: Number(prod.stock_quantity || 0) + qty };
          if (hasColor) {
            stocks[String(colorId)] = Number(stocks[String(colorId)] ?? prod.stock_quantity ?? 0) + qty;
            restockPayload.color_stocks = stocks;
          }
          await prod.update(restockPayload, { transaction: t });
        }
      }
      await OrderItem.update(
        { status: 'Cancelled' },
        { where: { order_id: id, status: { [Op.ne]: 'Cancelled' } }, transaction: t },
      );

      // Decrement coupon usage count
      if (order.coupon_code) {
        const Coupon = require('../models/Coupon');
        await Coupon.decrement('usage_count', {
          by: 1,
          where: { code: order.coupon_code, usage_count: { [Op.gt]: 0 } },
          transaction: t,
        });
      }

      // Cancel the forward shipment on ShipRocket and mirror it on our
      // shipment row. Best-effort: an SR hiccup never blocks the cancellation.
      const fwdShipment = await Shipment.findOne({
        where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD, shiprocket_order_id: { [Op.ne]: null } },
        order: [['created_at', 'DESC']],
        transaction: t,
      });
      let shiprocketCancel = null;
      if (fwdShipment?.shiprocket_order_id) {
        try {
          shiprocketCancel = await ShipRocketService.cancelOrders([fwdShipment.shiprocket_order_id]);
          await fwdShipment.update({ status: SHIPMENT_STATUS.CANCELLED }, { transaction: t });
        } catch (error) {
          console.error(`[ShipRocket] Cancel failed for order #${order.id}:`, error?.response?.data || error.message);
          shiprocketCancel = { warning: 'ShipRocket cancellation could not be confirmed automatically.' };
        }
      }

      const { reason } = req.body;
      const prevStatus = order.status;
      const isCod = String(order.payment_method || 'COD').toUpperCase() === 'COD';

      // Reverse the order on the ledger and (prepaid) record the refund.
      const { refundAmount, walletRefund } = await settleCancellation({ orderId: order.id, isCod, transaction: t });
      const paidAmount = refundAmount;
      let refundNote = isCod
        ? 'COD order cancelled. No online payment refund is needed.'
        : `Refund of Rs. ${paidAmount.toLocaleString('en-IN')} will be processed in 1-2 days.`;
      if (reason && reason.trim()) refundNote += ` | Reason: ${reason.trim()}`;

      await order.update({
        status: 'Cancelled',
        cancelled_at: new Date(),
        payment_status: isCod ? 'Cancelled' : 'Refund Pending',
      }, { transaction: t });
      await OrderStatusHistory.create({
        order_id: order.id, from_status: prevStatus, to_status: 'Cancelled',
        actor: req.userRole === 'admin' ? ACTOR.ADMIN : ACTOR.CUSTOMER, reason: reason?.trim() || null,
      }, { transaction: t });

      await OrderRefund.create({
        order_id: order.id,
        refund_type: REFUND_TYPE.FULL_CANCEL,
        amount: isCod ? 0 : paidAmount,
        status: isCod ? REFUND_STATUS.NOT_REQUIRED : REFUND_STATUS.PENDING,
        payment_method: isCod ? REFUND_PAYMENT_METHOD.NOT_REQUIRED : REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
        note: refundNote,
      }, { transaction: t });

      // Refund wallet credit used on the order
      if (walletRefund > 0 && order.customer_id) {
        await WalletTransaction.create({
          customer_id: order.customer_id,
          amount: walletRefund,
          type: 'ORDER_CANCELLATION_REFUND',
          status: 'completed',
          available_at: null,
          dedupe_key: `order_cancel_wallet:${order.id}`,
          meta: { order_id: order.id },
        }, { transaction: t });
        await Customer.increment(
          { wallet_balance: walletRefund },
          { where: { id: order.customer_id }, transaction: t },
        );
      }

      await t.commit();

      // Initiate the Razorpay refund for prepaid orders. Runs post-commit so a
      // gateway hiccup never rolls back the cancellation; the outcome is written
      // to the refund rows so admin can see Processing vs Failed and retry.
      if (!isCod && paidAmount > 0) {
        (async () => {
          try {
            const payment = await Payment.findOne({ where: { order_id: order.id, status: 'Paid' } });
            if (!payment?.gateway_payment_id) {
              console.error(`[Razorpay] No paid gateway payment found for order #${order.id} — refund needs manual processing.`);
              return;
            }
            const gatewayRefund = await razorpayRefund(payment.gateway_payment_id, paidAmount, {
              reason: 'Customer cancellation',
              orderId: String(order.id),
            });
            await OrderRefund.update(
              { status: REFUND_STATUS.PROCESSING, gateway_refund_id: gatewayRefund?.id || null },
              { where: { order_id: order.id, refund_type: REFUND_TYPE.FULL_CANCEL, status: REFUND_STATUS.PENDING } },
            );
            await RefundTransaction.update(
              { status: 'Processing', gateway_ref: gatewayRefund?.id || null },
              { where: { order_id: order.id, status: 'Pending' } },
            );
            console.log(`[Razorpay] ✅ Refund of Rs. ${paidAmount} initiated for order #${order.id} → ${gatewayRefund?.id}`);
          } catch (err) {
            console.error(`[Razorpay] Refund failed for order #${order.id}:`, err?.message || err);
            // Surface the failure so admin can retry instead of it sitting silently Pending.
            await OrderRefund.update(
              { status: REFUND_STATUS.FAILED, note: sequelize.literal(`CONCAT(COALESCE(note, ''), ' | Automatic gateway refund failed — manual retry required.')`) },
              { where: { order_id: order.id, refund_type: REFUND_TYPE.FULL_CANCEL, status: REFUND_STATUS.PENDING } },
            ).catch((updateErr) => console.error('[Razorpay] Failed to mark refund Failed:', updateErr.message));
          }
        })();
      }

      EmailService.sendOrderStatusUpdate(order, 'Cancelled').catch((error) => {
        console.error('[Email] Order cancellation email failed:', error.message);
      });

      const updatedOrder = await Order.findByPk(id, {
        include: [
          {
            model: OrderItem,
            include: [
              { model: Product, attributes: ['id', 'name', 'slug', 'images'] },
              { model: Color, attributes: ['id', 'name', 'slug', 'hex_code'] },
            ],
          },
          { model: OrderRefund, as: 'Refunds' },
          ...ORDER_V2_INCLUDES,
        ],
      });

      return res.status(200).json({
        message: 'Order cancelled successfully.',
        refund_message: refundNote,
        shiprocket: shiprocketCancel,
        order: serializeOrder(updatedOrder),
      });
    } catch (error) {
      if (t && !t.finished) await t.rollback();
      return res.status(500).json({ message: error.message });
    }
  }

  // ── Admin: Update order status. If delivered, schedule referral reward ──────
  async updateOrderStatus(req, res) {
    const t = await sequelize.transaction();
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!status) return res.status(400).json({ message: 'status is required' });

      const order = await Order.findByPk(id, { transaction: t });
      if (!order) return res.status(404).json({ message: 'Order not found' });

      const normalized = String(status).trim();
      const normalizedLower = normalized.toLowerCase();
      const isDelivered = normalizedLower === 'delivered';
      const isRtoDelivered = normalizedLower === 'rto delivered';

      const prevStatusForHistory = order.status;
      const updatePayload = {
        status: normalized,
      };
      if (isDelivered && !order.delivered_at) {
        updatePayload.delivered_at = new Date();
      }
      await OrderStatusHistory.create({
        order_id: order.id, from_status: prevStatusForHistory, to_status: normalized,
        actor: ACTOR.ADMIN, reason: null,
      }, { transaction: t });

      // RTO Delivered (admin manual): mirror the webhook — create an rto_event,
      // block COD, and defer prepaid logistics to the resolve-RTO step.
      if (isRtoDelivered) {
        const isCodOrder = String(order.payment_method || '').toUpperCase() === 'COD';
        const fwd = await Shipment.findOne({
          where: { order_id: order.id, type: SHIPMENT_TYPE.FORWARD },
          order: [['created_at', 'DESC']], transaction: t,
        });
        const existingRto = fwd ? await RtoEvent.findOne({ where: { shipment_id: fwd.id }, transaction: t }) : null;
        if (fwd && !existingRto) {
          const cd = fwd.selected_courier_data || {};
          const fwdCharge = toMoney([cd.freight_charge, cd.rate, cd.charge].find((v) => Number(v) > 0) || fwd.forward_charge);
          const rtoCharge = toMoney([cd.rto_charges, cd.rto_charge].find((v) => Number(v) > 0) || 0);
          if (isCodOrder) {
            const rtoEvent = await RtoEvent.create({
              shipment_id: fwd.id, order_id: order.id, payment_method: 'COD',
              forward_charge_to_recover: 0, rto_charge: 0, resolution: RTO_RESOLUTION.PRODUCT_RETURNED_COD_BLOCKED,
            }, { transaction: t });
            await blockCustomerCodForOrder(order, `COD blocked: RTO on order #${order.order_number || order.id}.`, t);
            const bal = await getOrderBalance(order.id, t);
            if (bal > 0) {
              await appendEntry(order.id, { type: LEDGER_ENTRY_TYPE.PRODUCT_CHARGE, amount: bal, direction: LEDGER_DIRECTION.CREDIT, referenceType: LEDGER_REFERENCE_TYPE.RTO_EVENT, referenceId: rtoEvent.id, note: 'COD RTO — order returned' }, t);
            }
            updatePayload.cancelled_at = new Date();
          } else {
            await RtoEvent.create({
              shipment_id: fwd.id, order_id: order.id, payment_method: 'Prepaid',
              forward_charge_to_recover: fwdCharge, rto_charge: rtoCharge, resolution: RTO_RESOLUTION.AWAITING_PAYMENT,
            }, { transaction: t });
            updatePayload.payment_status = 'Refund Pending';
          }
          const existingRtoRefund = await OrderRefund.findOne({ where: { order_id: order.id, refund_type: REFUND_TYPE.RTO }, transaction: t });
          if (!existingRtoRefund) {
            await OrderRefund.create({
              order_id: order.id, refund_type: REFUND_TYPE.RTO, amount: 0,
              status: isCodOrder ? REFUND_STATUS.NOT_REQUIRED : 'RTO Action Required',
              payment_method: isCodOrder ? REFUND_PAYMENT_METHOD.NOT_REQUIRED : REFUND_PAYMENT_METHOD.ORIGINAL_GATEWAY,
              note: isCodOrder
                ? 'COD order returned to seller. No payment was collected.'
                : `Order returned to seller. Pay Rs. ${toMoney(fwdCharge + rtoCharge).toLocaleString('en-IN')} to re-dispatch, or request a refund.`,
            }, { transaction: t });
          }
        }
      }

      await order.update(updatePayload, { transaction: t });

      const itemShipmentStatuses = new Set([
        'order placed',
        'pending',
        'processing',
        'picked up',
        'awb assigned',
        'shipped',
        'out for delivery',
        'delivered',
        'undelivered',
        'rto initiated',
        'rto in transit',
        'rto delivered',
        'seller cancelled',
        'cancelled',
      ]);
      if (itemShipmentStatuses.has(normalizedLower)) {
        const orderItems = await OrderItem.findAll({
          where: { order_id: order.id },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        for (const item of orderItems) {
          const itemStatus = String(item.status || '').toLowerCase();
          const hasItemSpecificAction = ['cancel', 'return', 'exchange'].some((word) => itemStatus.includes(word));
          if (!hasItemSpecificAction) {
            await item.update({ status: normalized }, { transaction: t });
          }
        }
      }

      // Referral milestone reward:
      // If this is the referred customer's *first* delivered order, and the referrer
      // now has 3 distinct referred customers with delivered orders, credit ₹1000
      // after 7 days from this delivery.
      if (isDelivered && updatePayload.delivered_at && order.customer_id) {
        const buyer = await Customer.findByPk(order.customer_id, { transaction: t });
        if (buyer?.referred_by_id) {
          const priorDelivered = await Order.findOne({
            where: {
              customer_id: buyer.id,
              delivered_at: { [Op.ne]: null },
              id: { [Op.ne]: order.id },
            },
            transaction: t,
          });

          if (!priorDelivered) {
            const referredCustomers = await Customer.findAll({
              where: { referred_by_id: buyer.referred_by_id },
              attributes: ["id"],
              transaction: t,
            });
            const referredCustomerIds = referredCustomers.map((row) => row.id);

            if (referredCustomerIds.length) {
              const qualifiedCount = await Order.count({
                where: {
                  customer_id: { [Op.in]: referredCustomerIds },
                  delivered_at: { [Op.ne]: null },
                },
                distinct: true,
                col: "customer_id",
                transaction: t,
              });

              if (qualifiedCount >= config.referralMilestoneCount) {
                const availableAt = new Date(
                  updatePayload.delivered_at.getTime() + config.referralOrderDelayDays * 24 * 60 * 60 * 1000,
                );
                await WalletService.createPendingCredit({
                  customerId: buyer.referred_by_id,
                  amount: config.referralMilestoneBonus,
                  type: "REFERRAL_MILESTONE_BONUS",
                  dedupeKey: `ref_milestone:${config.referralMilestoneCount}:${buyer.referred_by_id}`,
                  availableAt,
                  meta: {
                    milestone_count: config.referralMilestoneCount,
                    triggering_order_id: order.id,
                    referred_customer_id: buyer.id,
                    qualified_count_at_delivery: qualifiedCount,
                  },
                });
              }
            }
          }
        }
      }

      await t.commit();
      return res.status(200).json({ message: 'Order updated', order });
    } catch (error) {
      if (t && !t.finished) await t.rollback();
      return res.status(500).json({ message: error.message });
    }
  }
}

module.exports = new OrderController();
