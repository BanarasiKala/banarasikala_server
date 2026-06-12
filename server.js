const dns = require("dns");
const cron = require("node-cron");

const app = require("./src");
const { connectDB } = require("./src/config/db");
const { config } = require("./src/config/env");
const WalletService = require("./src/services/WalletService");
const { ensureOrderLifecycleColumns } = require("./src/utils/orderLifecycle");
const { ensureFeedbackColumns } = require("./src/utils/feedbackSchema");
const { ensureWalletConstraint, ensureIndexes } = require("./src/utils/dbConstraints");

const PORT = config.port;

if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

// Health Route
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server is running",
  });
});

const startHeartbeat = () => {
  cron.schedule("*/10 * * * *", async () => {
    try {
      const response = await fetch(
        "https://vns-saree.onrender.com/health"
      );


      console.log(
        `Heartbeat sent at ${new Date().toISOString()} | Status: ${response.status}`
      );
    } catch (error) {
      console.error("Heartbeat failed:", error.message);
    }
  });
};

const startReferralPayoutJob = () => {
  // Every hour: process pending wallet credits that became available (e.g., referral payouts).
  cron.schedule("15 * * * *", async () => {
    try {
      const result = await WalletService.processDuePendingCredits({ limit: 500 });
      if (result.processed) {
        console.log(`[Wallet] Processed ${result.processed} pending credits`);
      }
    } catch (error) {
      console.error("[Wallet] Pending credit processing failed:", error.message);
    }
  });
};

const startServer = async () => {
  try {
    await connectDB();
    await ensureOrderLifecycleColumns();
    await ensureFeedbackColumns();
    await ensureWalletConstraint();
    await ensureIndexes();

    startHeartbeat();
    startReferralPayoutJob();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Environment: ${config.nodeEnv}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
