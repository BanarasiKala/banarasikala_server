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

  // Heartbeat + read of live viewers and recent orders for a product. A POST
  // with { sessionId } registers presence; the response returns the current
  // viewer count plus how many orders included this product in the last hour.
  async productViewers(req, res) {
    try {
      const { productId } = req.params;
      const sessionId = req.body?.sessionId;
      const realViewers = sessionId
        ? StatsService.touchViewer(productId, sessionId)
        : StatsService.countViewers(productId);
      const realOrders = await StatsService.getProductOrdersRecent(productId);

      // Show a plausible floor when genuine activity is low.
      const viewers = realViewers >= 100 ? realViewers : StatsService.viewerFloor(productId);
      const ordersRecent = realOrders >= 50 ? realOrders : StatsService.orderFloor(productId);

      res.json({ viewers, ordersRecent });
    } catch (error) {
      console.error("[StatsController] productViewers:", error.message);
      res.json({ viewers: 0, ordersRecent: 0 });
    }
  },
};

module.exports = StatsController;
