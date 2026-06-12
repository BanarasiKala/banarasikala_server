const { Op } = require("sequelize");
const Customer = require("../models/Customer");
const WalletTransaction = require("../models/WalletTransaction");
const Order = require("../models/Order");
const { sequelize } = require("../config/db");

const REFERRAL_MILESTONE_BONUS = "REFERRAL_MILESTONE_BONUS";

const isOrderStillRewardEligible = (order) =>
  order &&
  order.delivered_at &&
  !order.cancelled_at &&
  !String(order.status || "").toLowerCase().includes("return") &&
  !String(order.status || "").toLowerCase().includes("cancel");

const getCancellationMeta = (meta, reason) => ({
  ...(meta || {}),
  cancelled_reason: reason,
  cancelled_at: new Date().toISOString(),
});

class WalletService {
  async creditNow({ customerId, amount, type, dedupeKey, meta = null }) {
    return sequelize.transaction(async (t) => {
      const existing = await WalletTransaction.findOne({
        where: { dedupe_key: dedupeKey },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (existing) return existing;

      const tx = await WalletTransaction.create(
        {
          customer_id: customerId,
          amount,
          type,
          status: "completed",
          available_at: null,
          dedupe_key: dedupeKey,
          meta,
        },
        { transaction: t },
      );

      await Customer.increment(
        { wallet_balance: amount },
        { where: { id: customerId }, transaction: t },
      );

      return tx;
    });
  }

  async createPendingCredit({ customerId, amount, type, dedupeKey, availableAt, meta = null }) {
    return sequelize.transaction(async (t) => {
      const existing = await WalletTransaction.findOne({
        where: { dedupe_key: dedupeKey },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (existing) return existing;

      return WalletTransaction.create(
        {
          customer_id: customerId,
          amount,
          type,
          status: "pending",
          available_at: availableAt,
          dedupe_key: dedupeKey,
          meta,
        },
        { transaction: t },
      );
    });
  }

  async cancelPendingReferralCreditsForOrder(orderId, reason = "Order is no longer referral eligible.") {
    return sequelize.transaction(async (t) => {
      const pending = await WalletTransaction.findAll({
        where: {
          type: REFERRAL_MILESTONE_BONUS,
          status: "pending",
        },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      const matching = pending.filter((tx) => String(tx.meta?.triggering_order_id || "") === String(orderId));
      for (const tx of matching) {
        tx.status = "cancelled";
        tx.meta = getCancellationMeta(tx.meta, reason);
        await tx.save({ transaction: t });
      }

      return { cancelled: matching.length };
    });
  }

  async processDuePendingCredits({ limit = 200 } = {}) {
    const now = new Date();
    const pending = await WalletTransaction.findAll({
      where: {
        status: "pending",
        available_at: { [Op.lte]: now },
      },
      limit,
      order: [["available_at", "ASC"]],
    });

    for (const tx of pending) {
      // Process sequentially with proper locks for correctness.
      // If multiple instances run, dedupe_key + row locks protect against double credit.
      await sequelize.transaction(async (t) => {
        const locked = await WalletTransaction.findByPk(tx.id, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (!locked || locked.status !== "pending") return;

        if (locked.type === REFERRAL_MILESTONE_BONUS) {
          const triggeringOrderId = locked.meta?.triggering_order_id;
          const order = triggeringOrderId
            ? await Order.findByPk(triggeringOrderId, { transaction: t, lock: t.LOCK.UPDATE })
            : null;

          if (!isOrderStillRewardEligible(order)) {
            locked.status = "cancelled";
            locked.meta = getCancellationMeta(
              locked.meta,
              "Triggering order was cancelled, returned, or is no longer delivered.",
            );
            await locked.save({ transaction: t });
            return;
          }
        }

        await Customer.increment(
          { wallet_balance: locked.amount },
          { where: { id: locked.customer_id }, transaction: t },
        );

        locked.status = "completed";
        await locked.save({ transaction: t });
      });
    }

    return { processed: pending.length };
  }
}

module.exports = new WalletService();

