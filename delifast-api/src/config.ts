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
  d7VerifyEnabled: process.env.D7_VERIFY_ENABLED === "true",
  d7ApiToken: process.env.D7_API_TOKEN || "",
  d7Originator: process.env.D7_VERIFY_ORIGINATOR || "D7VERIFY",
  d7Content: process.env.D7_VERIFY_CONTENT || "{}",
  d7TemplateId: process.env.D7_VERIFY_TEMPLATE_ID || "",
  d7TimeoutMs: boundedInteger("D7_VERIFY_TIMEOUT_MS", 8_000),
  d7MaxResponseBytes: boundedInteger("D7_VERIFY_MAX_RESPONSE_BYTES", 32_768),
  customerOtpIpMax: boundedInteger("CUSTOMER_OTP_IP_MAX", 5),
};

export const INT_MAX_VALUE = INT_MAX;
