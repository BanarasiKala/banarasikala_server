/**
 * One-off: re-send the order confirmation receipt for a single order.
 *
 * placeOrder composes that email inline from values it holds in memory, and not all of them are
 * persisted, so this rebuilds the summary from what IS stored — the ledger, the order items and
 * their shipping_meta — applying the same rules placeOrder does. Where a figure cannot be
 * recovered it is derived exactly as the confirmation page derives it, so the receipt and the
 * page agree by construction rather than by coincidence.
 *
 *   node resend-order-email.js <orderId> [--send]
 *
 * Without --send it prints the reconstructed summary and sends nothing.
 */
require("dotenv").config();
const { sequelize } = require("./src/config/db");

const SERVER = "./src";
const EmailService = require(`${SERVER}/services/EmailService`);
const { config } = require(`${SERVER}/config/env`);

const orderId = Number(process.argv[2]);
const doSend = process.argv.includes("--send");
const money = (n) => `Rs. ${Number(n || 0).toFixed(2)}`;

(async () => {
  const q = (sql) => sequelize.query(sql).then(([rows]) => rows);

  const [order] = await q(`SELECT * FROM vns_saree.orders WHERE id = ${orderId}`);
  if (!order) throw new Error(`order ${orderId} not found`);

  const items = await q(`SELECT * FROM vns_saree.order_items WHERE order_id = ${orderId}`);
  const ledger = await q(`SELECT entry_type, amount FROM vns_saree.order_ledger WHERE order_id = ${orderId}`);
  const [address] = await q(
    `SELECT * FROM vns_saree.order_addresses WHERE order_id = ${orderId} AND is_current = true LIMIT 1`,
  );

  const led = (type) => ledger
    .filter((r) => r.entry_type === type)
    .reduce((sum, r) => sum + Number(r.amount || 0), 0);

  const subtotal = led("PRODUCT_CHARGE");
  const platformFee = led("PLATFORM_FEE");
  const codFee = led("COD_FEE");
  const giftCharge = led("GIFT_CHARGE");
  const couponDiscount = led("COUPON_DISCOUNT");
  const prepaidDiscount = led("PAYMENT_DISCOUNT");
  const walletUsed = led("WALLET_CREDIT");

  // The courier's full quote, per item. On a COD order this already contains the COD handling
  // charge, which is billed separately below — hence the netting, same as placeOrder now does.
  const shippingFull = items.reduce((sum, i) => sum + Number(i.shipping_meta?.delivery_charge || 0), 0);
  const deliveryWaived = Math.max(0, shippingFull - codFee);

  // MRP is read live from the product; order_items never snapshots one.
  const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))];
  const products = productIds.length
    ? await q(`SELECT id, mrp_price FROM vns_saree.products WHERE id IN (${productIds.join(",")})`)
    : [];
  const mrpById = new Map(products.map((p) => [Number(p.id), Number(p.mrp_price || 0)]));
  const mrpSavings = items.reduce((sum, i) => {
    const mrp = mrpById.get(Number(i.product_id)) || 0;
    const sell = Number(i.price || 0);
    const qty = Math.max(1, Number(i.quantity || 1));
    return sum + (mrp > sell ? (mrp - sell) * qty : 0);
  }, 0);

  const total = subtotal + platformFee + codFee + giftCharge - couponDiscount - prepaidDiscount - walletUsed;
  const isCod = String(order.payment_method || "").toUpperCase() === "COD";
  const saved = mrpSavings + couponDiscount + deliveryWaived + prepaidDiscount;

  const summary = {
    subtotal,
    mrpTotal: subtotal + mrpSavings,
    couponDiscount,
    couponCode: order.coupon_code || "",
    shipping: 0,               // fully waived at placement
    shippingWaived: deliveryWaived,
    platformFee,
    codFee,
    giftCharge,
    prepaidDiscount,
    walletUsed,
    tax: 0,
    total,
    paidToday: isCod ? 0 : total,
    saved,
    placedAt: order.created_at,
    shippingAddress: address && {
      name: address.name, line: address.line, city: address.city,
      state: address.state, pincode: address.pincode, phone: address.phone,
    },
    paymentLabel: isCod ? "Cash on Delivery" : "Paid online",
  };

  console.log(`order ${order.order_number}  ->  ${order.customer_email}`);
  console.log("  subtotal        ", money(subtotal));
  console.log("  platform fee    ", money(platformFee));
  console.log("  COD fee         ", money(codFee));
  console.log("  gift            ", money(giftCharge));
  console.log("  delivery waived ", money(deliveryWaived), `(full quote ${money(shippingFull)} - COD ${money(codFee)})`);
  console.log("  MRP savings     ", money(mrpSavings));
  console.log("  TOTAL           ", money(total));
  console.log("  YOU SAVED       ", money(saved));

  if (!doSend) {
    console.log("\n(dry run — pass --send to actually deliver)");
    await sequelize.close();
    return;
  }

  await EmailService.sendOrderConfirmation(
    { ...order, total_amount: total },
    items.map((i) => ({ ...i, name: i.product_name, image: i.image_url || i.product_image, mrp_price: mrpById.get(Number(i.product_id)) || 0 })),
    summary,
  );
  console.log("\nsent.");
  await sequelize.close();
})().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
