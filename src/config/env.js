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
  // Payment-gateway cost retained on a FULL return. The gateway keeps its fee on the
  // original transaction even when we refund, so it is not refunded to the customer:
  //   fee = refund × RETURN_GATEWAY_FEE_PERCENT
  //   gst = fee    × RETURN_GATEWAY_FEE_GST_PERCENT
  // Both are percentages (e.g. 2 = 2%). Defaults keep existing behaviour (0 = disabled)
  // so this can never start deducting money just because an env var is missing.
  returnGatewayFeePercent: Number(process.env.RETURN_GATEWAY_FEE_PERCENT) || 0,
  returnGatewayFeeGstPercent: Number(process.env.RETURN_GATEWAY_FEE_GST_PERCENT) || 0,
};

module.exports = { config };
