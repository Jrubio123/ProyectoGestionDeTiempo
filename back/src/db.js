const { Pool } = require("pg");

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on", "require"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off", "disable"].includes(normalized)) return false;
  return defaultValue;
}

function parseIntEnv(name, fallback, minValue = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < minValue) return fallback;
  return parsed;
}

const dbHost = String(process.env.DB_HOST || "").toLowerCase().trim();
const localDbHosts = new Set(["localhost", "127.0.0.1", "db"]);
const shouldUseSsl = parseBoolean(process.env.DB_SSL, !localDbHosts.has(dbHost));

const poolConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  port: parseIntEnv("DB_PORT", 5432, 1),
  max: parseIntEnv("DB_POOL_MAX", process.env.NODE_ENV === "production" ? 20 : 10, 1),
  min: parseIntEnv("DB_POOL_MIN", 0, 0),
  idleTimeoutMillis: parseIntEnv("DB_POOL_IDLE_TIMEOUT_MS", 30000, 1000),
  connectionTimeoutMillis: parseIntEnv("DB_POOL_CONNECTION_TIMEOUT_MS", 2000, 500),
  keepAlive: parseBoolean(process.env.DB_POOL_KEEPALIVE, true),
  application_name: process.env.DB_APP_NAME || "gestion-tiempo-back"
};

if (shouldUseSsl) {
  poolConfig.ssl = {
    rejectUnauthorized: parseBoolean(process.env.DB_SSL_REJECT_UNAUTHORIZED, false)
  };
}

const maxLifetimeSeconds = parseIntEnv("DB_POOL_MAX_LIFETIME_SEC", 0, 0);
if (maxLifetimeSeconds > 0) {
  poolConfig.maxLifetimeSeconds = maxLifetimeSeconds;
}

const pool = new Pool(poolConfig);

function isTransientDbError(err) {
  const code = String(err?.code || "").toUpperCase();
  if (["57P01", "57P02", "57P03", "08000", "08003", "08006"].includes(code)) {
    return true;
  }

  const message = String(err?.message || "").toLowerCase();
  return [
    "connection terminated unexpectedly",
    "terminating connection",
    "the database system is starting up",
    "server closed the connection unexpectedly",
    "connection ended unexpectedly",
    "pool is ending"
  ].some((token) => message.includes(token));
}

pool.on("error", (err) => {
  console.error("[db] Error en cliente inactivo del pool:", err?.message || err);
});

function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount
  };
}

module.exports = {
  pool,
  poolConfig,
  getPoolStats,
  isTransientDbError
};
