const INT_MAX = 2_147_483_647;

if (process.env.NODE_ENV === "production") {
  throw new Error(
    "Ce lot Delifast est réservé au développement local : authentification et paiements de production non disponibles.",
  );
}

function boundedInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > INT_MAX) {
    throw new Error(`${name} must be an integer between 0 and ${INT_MAX}`);
  }
  return value;
}

export const config = {
  port: boundedInteger("PORT", 4000),
  host: process.env.HOST || "127.0.0.1",
  mongoUri:
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    "mongodb://127.0.0.1:27017/delifast",
  serviceFee: boundedInteger("SERVICE_FEE_XOF", 200),
  tax: boundedInteger("TAX_XOF", 0),
  maxLines: 20,
  maxBody: 100_000,
  rateLimitWindowMs: boundedInteger("RATE_LIMIT_WINDOW_MS", 60_000),
  rateLimitMax: boundedInteger("RATE_LIMIT_MAX", 100),
  demoPayments: process.env.DELIFAST_DEMO_PAYMENTS === "true",
  smsProvider: process.env.SMS_PROVIDER || "",
  orangeSmsEnabled: process.env.ORANGE_SMS_ENABLED === "true",
  orangeClientId: process.env.ORANGE_CLIENT_ID || "",
  orangeClientSecret: process.env.ORANGE_CLIENT_SECRET || "",
  orangeSenderAddress: process.env.ORANGE_SMS_SENDER_ADDRESS || "tel:+2260000",
  orangeSenderName: process.env.ORANGE_SMS_SENDER_NAME || "",
  orangeTimeoutMs: boundedInteger("ORANGE_SMS_TIMEOUT_MS", 8_000),
  orangeMaxResponseBytes: boundedInteger("ORANGE_SMS_MAX_RESPONSE_BYTES", 32_768),
  customerOtpHashKey: process.env.CUSTOMER_OTP_HASH_KEY || "",
  customerOtpIpMax: boundedInteger("CUSTOMER_OTP_IP_MAX", 5),
};

export const INT_MAX_VALUE = INT_MAX;
