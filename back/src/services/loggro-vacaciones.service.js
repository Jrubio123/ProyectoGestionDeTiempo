const DEFAULT_API_BASE = "https://api.loggro.com/apik/loggro-nomina";
const DEFAULT_TIMEOUT_MS = 10000;

class LoggroVacacionesError extends Error {
  constructor(message, statusCode = 502, code = "LOGGRO_ERROR") {
    super(message);
    this.name = "LoggroVacacionesError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function normalizeDocument(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function normalizeBearerToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "");
}

function parseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/\s/g, "");
  if (!compact) return null;
  const normalized = compact.includes(",") && compact.includes(".")
    ? compact.replace(/\./g, "").replace(",", ".")
    : compact.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAvailableDaysKey(key) {
  const normalized = normalizeKey(key);
  if ([
    "diasdisponiblesvacaciones",
    "diasvacacionesdisponibles",
    "diasdisponibles",
    "saldovacaciones",
    "saldodiasvacaciones",
    "saldodiasdisponibles"
  ].includes(normalized)) return true;

  return normalized.includes("dia")
    && (normalized.includes("disponible") || normalized.includes("saldo"))
    && !normalized.includes("fecha");
}

function collectDayCandidates(value, path = [], candidates = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectDayCandidates(item, [...path, index], candidates));
    return candidates;
  }
  if (!value || typeof value !== "object") return candidates;

  Object.entries(value).forEach(([key, item]) => {
    if (isAvailableDaysKey(key)) {
      const numericValue = parseNumber(item);
      if (numericValue !== null) {
        candidates.push({ value: numericValue, key, row: value, path: [...path, key] });
      }
    }
    if (item && typeof item === "object") {
      collectDayCandidates(item, [...path, key], candidates);
    }
  });
  return candidates;
}

function objectContainsDocument(value, documentNumber) {
  const expected = normalizeDocument(documentNumber);
  if (!expected || !value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => {
    if (item && typeof item === "object") return false;
    const normalizedKey = normalizeKey(key);
    const isDocumentField = normalizedKey.includes("documento")
      || normalizedKey.includes("identificacion")
      || normalizedKey === "cedula"
      || normalizedKey === "numeroid";
    return isDocumentField && normalizeDocument(item) === expected;
  });
}

function extractAvailableDays(payload, documentNumber) {
  const content = payload?.contenido ?? payload;
  const candidates = collectDayCandidates(content);
  if (!candidates.length) {
    throw new LoggroVacacionesError(
      "Loggro no devolvió el campo de días disponibles esperado",
      502,
      "LOGGRO_UNEXPECTED_RESPONSE"
    );
  }

  const matching = candidates.filter((candidate) => objectContainsDocument(candidate.row, documentNumber));
  const selected = matching[0] || (candidates.length === 1 ? candidates[0] : null);
  if (!selected) {
    throw new LoggroVacacionesError(
      "No fue posible identificar el saldo del usuario en la respuesta de Loggro",
      404,
      "LOGGRO_EMPLOYEE_NOT_FOUND"
    );
  }

  return {
    dias_disponibles: selected.value,
    campo_origen: selected.key
  };
}

function todayInBogota(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validateDate(value) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new LoggroVacacionesError("La fecha de consulta no es válida", 400, "INVALID_DATE");
  }
  return date;
}

function getConfig(overrides = {}) {
  const token = normalizeBearerToken(overrides.token ?? process.env.LOGGRO_API_TOKEN);
  if (!token) {
    throw new LoggroVacacionesError(
      "La consulta de vacaciones en Loggro no está configurada",
      503,
      "LOGGRO_NOT_CONFIGURED"
    );
  }
  const apiBase = String(overrides.apiBase ?? process.env.LOGGRO_API_BASE ?? DEFAULT_API_BASE)
    .trim()
    .replace(/\/+$/, "");
  const timeoutCandidate = Number(overrides.timeoutMs ?? process.env.LOGGRO_API_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutCandidate) && timeoutCandidate > 0
    ? Math.min(timeoutCandidate, 60000)
    : DEFAULT_TIMEOUT_MS;
  return { token, apiBase, timeoutMs };
}

async function getAvailableVacationDays({ documentNumber, date, fetchImpl = global.fetch, config = {} }) {
  const document = String(documentNumber || "").trim();
  if (!document) {
    throw new LoggroVacacionesError(
      "Tu usuario no tiene un número de documento configurado",
      422,
      "USER_DOCUMENT_MISSING"
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new LoggroVacacionesError("El servidor no puede conectarse con Loggro", 500, "FETCH_UNAVAILABLE");
  }

  const queryDate = validateDate(date || todayInBogota());
  const { token, apiBase, timeoutMs } = getConfig(config);
  const url = new URL(`${apiBase}/reportes/diasdisponiblesvacaciones/${encodeURIComponent(queryDate)}`);
  url.searchParams.set("page", "1");
  url.searchParams.set("size", "20");
  url.searchParams.set("filter", document);
  url.searchParams.set("totales", "false");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    throw new LoggroVacacionesError(
      timedOut ? "Loggro tardó demasiado en responder" : "No fue posible conectarse con Loggro",
      502,
      timedOut ? "LOGGRO_TIMEOUT" : "LOGGRO_CONNECTION_ERROR"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const messages = {
      401: "El token de Loggro no es válido o expiró",
      404: "Loggro no pudo construir el reporte de vacaciones",
      417: "El usuario del token de Loggro no tiene permiso para consultar vacaciones"
    };
    throw new LoggroVacacionesError(
      messages[response.status] || "Loggro rechazó la consulta de vacaciones",
      response.status === 401 || response.status === 417 ? 503 : 502,
      `LOGGRO_HTTP_${response.status}`
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    throw new LoggroVacacionesError(
      "Loggro devolvió una respuesta inválida",
      502,
      "LOGGRO_INVALID_JSON"
    );
  }

  if (payload?.error) {
    throw new LoggroVacacionesError(
      String(payload.error.mensaje || payload.error.error || "Loggro reportó un error al consultar vacaciones"),
      502,
      "LOGGRO_BUSINESS_ERROR"
    );
  }

  const balance = extractAvailableDays(payload, document);
  return {
    dias_disponibles: balance.dias_disponibles,
    fecha_corte: queryDate
  };
}

module.exports = {
  LoggroVacacionesError,
  extractAvailableDays,
  getAvailableVacationDays,
  normalizeBearerToken,
  todayInBogota
};
