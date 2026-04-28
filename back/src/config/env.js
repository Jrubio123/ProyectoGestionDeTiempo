const NODE_ENV = process.env.NODE_ENV || "development";
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (NODE_ENV === "production" ? "" : "dev_secret");

if (NODE_ENV === "production" && !JWT_SECRET) {
  throw new Error("JWT_SECRET no está configurado en producción.");
}

const normalizeNullable = (value) => {
  const normalized = String(value || "").trim();
  return normalized || null;
};

const env = {
  NODE_ENV,
  JWT_SECRET,
  CLICKSIGN_WEBHOOK_TOKEN: normalizeNullable(process.env.CLICKSIGN_WEBHOOK_TOKEN),
  DEBUG_CLICKSIGN_TOKEN: normalizeNullable(process.env.DEBUG_CLICKSIGN_TOKEN),
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  FRONT_PORTAL_BASE: process.env.FRONT_PORTAL_BASE,
  CONTRATOS_BASE_URL: process.env.CONTRATOS_BASE_URL,
  DB_HOST: process.env.DB_HOST
};

module.exports = { env };
