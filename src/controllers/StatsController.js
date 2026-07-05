const StatsService = require("../services/StatsService");

const StatsController = {
  // Site-wide count of non-cancelled orders placed today.
  async ordersToday(req, res) {
    try {
      const count = await StatsService.getOrdersToday();
      res.json({ count });
    } catch (error) {
      console.error("[StatsController] ordersToday:", error.message);
      res.json({ count: 0 });
    }
  },

  // Heartbeat + read of live viewers and today's orders for a product. A POST
  // with { sessionId } registers presence; the response returns the current
  // viewer count plus how many orders included this product today (IST).
  async productViewers(req, res) {
    try {
      const { productId } = req.params;
      const sessionId = req.body?.sessionId;
      const realViewers = sessionId
        ? StatsService.touchViewer(productId, sessionId)
        : StatsService.countViewers(productId);
      const realOrders = await StatsService.getProductOrdersToday(productId);

      // Show a plausible floor when genuine activity is low: viewers sit in a
      // 20–30 band until the real count reaches 30; today's orders ramp 5→10
      // through the day until the real count reaches 10 (never understated).
      const viewers = realViewers >= 30 ? realViewers : StatsService.viewerFloor(productId);
      const ordersToday = realOrders >= 10 ? realOrders : Math.max(realOrders, StatsService.orderFloor(productId));

      res.json({ viewers, ordersToday, ordersRecent: ordersToday });
    } catch (error) {
      console.error("[StatsController] productViewers:", error.message);
      res.json({ viewers: 0, ordersToday: 0, ordersRecent: 0 });
    }
  },
};

module.exports = StatsController;
