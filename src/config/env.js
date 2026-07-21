const path = require("path");
const dotenv = require("dotenv");

dotenv.config({
  path: process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.resolve(__dirname, "../../.env"),
});

const readEnv = (key) => {
  const value = process.env[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return String(value).trim();
};

const readNumberEnv = (key) => {
  const value = Number(readEnv(key));
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${key} must be a valid number.`);
  }
  return value;
};

const appMode = readEnv("APP_MODE").toLowerCase();
if (!["production", "development"].includes(appMode)) {
  throw new Error("APP_MODE must be either production or development.");
}

const nodeEnv = appMode;
process.env.NODE_ENV = nodeEnv;

const readCsvEnv = (key) =>
  readEnv(key)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const config = {
  nodeEnv,
  appMode,
  isDevelopment: appMode === "development",
  isProduction: appMode === "production",
  port: readNumberEnv("PORT"),
  databaseUrl: readEnv("DATABASE_URL"),
  dbSchema: readEnv("DB_SCHEMA"),
  corsOrigins: readCsvEnv("CORS_ORIGINS"),
  jwtSecret: readEnv("JWT_SECRET"),
  refreshTokenSecret: readEnv("REFRESH_TOKEN_SECRET"),
  jwtExpiresIn: readEnv("JWT_EXPIRES_IN"),
  refreshTokenExpiresIn: readEnv("REFRESH_TOKEN_EXPIRES_IN"),
  cloudinaryCloudName: readEnv("CLOUDINARY_CLOUD_NAME"),
  cloudinaryApiKey: readEnv("CLOUDINARY_API_KEY"),
  cloudinaryApiSecret: readEnv("CLOUDINARY_API_SECRET"),
  razorpayKeyId: readEnv("RAZORPAY_KEY_ID"),
  razorpayKeySecret: readEnv("RAZORPAY_KEY_SECRET"),
  // Signing secret chosen when creating the webhook in the Razorpay dashboard.
  // Optional: without it the webhook endpoint rejects calls, and refund status
  // still syncs via the lazy check on order reads.
  razorpayWebhookSecret: (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim(),
  // SMTP (GoDaddy / any provider). Falls back to the legacy EMAIL_* vars.
  emailHost: process.env.SMTP_HOST || "smtpout.secureserver.net",
  emailPort: Number(process.env.SMTP_PORT) || 465,
  emailUser: process.env.SMTP_USER || process.env.EMAIL_USER || readEnv("SMTP_USER"),
  emailPass: process.env.SMTP_PASS || process.env.EMAIL_PASS || readEnv("SMTP_PASS"),
  // Inbox that receives customer support tickets. Defaults to the SMTP sender.
  supportEmail: (process.env.SUPPORT_EMAIL || "").trim()
    || process.env.SMTP_USER
    || process.env.EMAIL_USER,
  // Seller identity printed on the tax invoice.
  invoiceSeller: {
    name: process.env.INVOICE_SELLER_NAME || "Banarasi Kala",
    address: process.env.INVOICE_SELLER_ADDRESS || "12/4, Vishwanath Gali, Varanasi",
    cityState: process.env.INVOICE_SELLER_CITY_STATE || "Uttar Pradesh – 221001",
    gstin: process.env.INVOICE_SELLER_GSTIN || "",
    email: process.env.INVOICE_SELLER_EMAIL || "support@banarasikala.com",
    website: process.env.INVOICE_SELLER_WEBSITE || "www.banarasikala.com",
  },
  // GST is included in the listed price; the invoice only breaks it out.
  invoiceGstPercent: Number(process.env.INVOICE_GST_PERCENT) || 5,
  shiprocketEmail: readEnv("SHIPROCKET_EMAIL"),
  shiprocketPassword: readEnv("SHIPROCKET_PASSWORD"),
  shiprocketPickupLocation: readEnv("SHIPROCKET_PICKUP_LOCATION"),
  shiprocketWebhookSecret: readEnv("SHIPROCKET_WEBHOOK_SECRET"),
  shiprocketGatewayApiKey: readEnv("SHIPROCKET_GATEWAY_API_KEY"),
  shiprocketGatewayApiSecret: readEnv("SHIPROCKET_GATEWAY_API_SECRET"),
  welcomeBonus: readNumberEnv("WELCOME_BONUS"),
  referralSignupBonus: readNumberEnv("REFERRAL_SIGNUP_BONUS"),
  referralOrderDelayDays: readNumberEnv("REFERRAL_ORDER_DELAY_DAYS"),
  referralMilestoneCount: readNumberEnv("REFERRAL_MILESTONE_COUNT"),
  referralMilestoneBonus: readNumberEnv("REFERRAL_MILESTONE_BONUS"),
  frontendUrl: appMode === "development" ? "http://localhost:5173" : process.env.FRONTEND_URL,
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  s3AccessKeyId: process.env.AWS_ACCESS_KEY_ID || null,
  s3SecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || null,
  s3Region: process.env.AWS_REGION || "ap-south-1",
  s3Bucket: process.env.AWS_S3_BUCKET || null,
  cloudfrontUrl: process.env.AWS_CLOUDFRONT_URL || null,
  msgCentralAuthToken: process.env.MSG_CENTRAL_AUTH_TOKEN || null,
  msgCentralCustomerId: process.env.MSG_CENTRAL_CUSTOMER_ID || null,
  codMaxAmount: readNumberEnv("COD_MAX_AMOUNT"),
  prepaidDiscountAmount: readNumberEnv("PREPAID_DISCOUNT_AMOUNT"),
  codFeeAmount: readNumberEnv("COD_FEE_AMOUNT"),
  platformFeeAmount: readNumberEnv("PLATFORM_FEE_AMOUNT"),
  // Flat charge added when the customer chooses "Send as a gift". Env-overridable.
  giftChargeAmount: Number(process.env.GIFT_CHARGE_AMOUNT) || 159,
  packageWeightKg: readNumberEnv("PACKAGE_WEIGHT_KG"),
  packageLengthCm: readNumberEnv("PACKAGE_LENGTH_CM"),
  packageBreadthCm: readNumberEnv("PACKAGE_BREADTH_CM"),
  packageHeightCm: readNumberEnv("PACKAGE_HEIGHT_CM"),
  // NOTE: returnGatewayFeePercent / returnGatewayFeeGstPercent were removed. Retaining the
  // payment-gateway fee out of a full-return refund was reverted — we absorb that cost. The
  // RETURN_GATEWAY_FEE_* entries in .env are now dead and can be deleted.

  // ── AI assistant (Claude) ───────────────────────────────────────────────────
  // Deliberately NOT readEnv(): that throws on a missing variable and would take the whole
  // server down over a chatbot. Absent key => the AI assistant is disabled and the chatbot
  // silently serves the original rule-based replies instead.
  anthropicApiKey: (process.env.ANTHROPIC_API_KEY || "").trim() || null,
  aiChatModel: (process.env.AI_CHAT_MODEL || "claude-sonnet-5").trim(),
  // How many past turns are replayed to the model. The DB keeps everything; the model only
  // sees a recent slice — resending an unbounded history makes cost grow with conversation
  // length on EVERY turn.
  // How many past turns are replayed to the model. The DB keeps the whole conversation; this
  // only bounds what is re-sent each turn. Input tokens grow with every replayed message, so
  // an unbounded window makes a long chat cost quadratically. Shop chats are short — 6 turns
  // covers the context that actually matters ("the blue one", "that second saree") while
  // cutting both read and write volume against a 10-turn window.
  aiChatReplayTurns: Number(process.env.AI_CHAT_REPLAY_TURNS) || 6,
  // Hard stop on the tool loop. A loop that never terminates is a billing incident.
  aiChatMaxIterations: Number(process.env.AI_CHAT_MAX_ITERATIONS) || 6,
  // Transcripts are deleted after this many days (see ChatBotController.purgeOldConversations).
  aiChatRetentionDays: Number(process.env.AI_CHAT_RETENTION_DAYS) || 90,
};

module.exports = { config };
