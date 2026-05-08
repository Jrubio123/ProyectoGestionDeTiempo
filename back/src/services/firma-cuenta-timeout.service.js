const { pool } = require("../db");

const FIRMA_CUENTA_TIMEOUT_HOURS = 24;
const FIRMA_CUENTA_TIMEOUT_EVENT = "SIGNATURE_TIMEOUT";
const FIRMA_CUENTA_TIMEOUT_ESTADO = "expired";

const PENDING_FIRMA_ESTADOS = new Set([
  "pending",
  "in_progress",
  "inprogress",
  "en_firma",
  "started",
  "sent",
  "open",
  "created",
  "start_signature",
  "start"
]);

function normalizeFirmaValue(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEventoValue(value) {
  return String(value || "").trim().toUpperCase();
}

function parseDateMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function isStartSignatureEvent(value) {
  return normalizeEventoValue(value) === "START_SIGNATURE";
}

function getLastFirmaEvent(firma) {
  const eventos = Array.isArray(firma?.eventos) ? firma.eventos : [];
  return eventos.length ? eventos[eventos.length - 1] : null;
}

function isFirmaCuentaTimedOut(firma, now = new Date(), timeoutHours = FIRMA_CUENTA_TIMEOUT_HOURS) {
  if (!firma || typeof firma !== "object") return false;
  if (firma?.documento_firmado?.url) return false;

  const estado = normalizeFirmaValue(firma.estado || "pending");
  if (!PENDING_FIRMA_ESTADOS.has(estado)) return false;

  const lastEvent = getLastFirmaEvent(firma);
  const ultimoEvento = firma.ultimo_evento || "";
  const lastEventStatus = lastEvent?.status || "";
  if (!isStartSignatureEvent(ultimoEvento) && !isStartSignatureEvent(lastEventStatus)) return false;

  const iniciadoMs = parseDateMs(firma.iniciado_en);
  if (!iniciadoMs) return false;

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  if (!Number.isFinite(nowMs)) return false;

  return nowMs - iniciadoMs > timeoutHours * 60 * 60 * 1000;
}

function buildFirmaCuentaTimeout(firma, { now = new Date(), timeoutHours = FIRMA_CUENTA_TIMEOUT_HOURS, origen = "reconciliar-job" } = {}) {
  const nowIso = now.toISOString();
  const eventosPrev = Array.isArray(firma?.eventos) ? firma.eventos.slice(-19) : [];
  const detalle = `Firma expirada por timeout tras ${timeoutHours} horas sin documento firmado.`;

  return {
    ...firma,
    estado: FIRMA_CUENTA_TIMEOUT_ESTADO,
    url_firma: null,
    url_firma_expirada: firma?.url_firma || firma?.url_firma_expirada || null,
    actualizado_en: nowIso,
    expirado_en: nowIso,
    ultimo_evento: FIRMA_CUENTA_TIMEOUT_EVENT,
    documento_firmado_error: detalle,
    eventos: [
      ...eventosPrev,
      {
        recibido_en: nowIso,
        status: FIRMA_CUENTA_TIMEOUT_EVENT,
        request_id: firma?.request_id || null,
        contract_id: firma?.contract_id || null,
        origen,
        detalle
      }
    ]
  };
}

async function marcarCuentaCobroFirmaExpirada({
  cuentaId,
  estadoEnFirma,
  now = new Date(),
  timeoutHours = FIRMA_CUENTA_TIMEOUT_HOURS,
  origen = "reconciliar-job"
} = {}) {
  if (!cuentaId || !estadoEnFirma) return { updated: false, reason: "missing_input" };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
      SELECT id, public_id, estado, datos_adjuntos
      FROM cuenta_cobro
      WHERE id = $1
      FOR UPDATE
      `,
      [cuentaId]
    );
    const cuenta = result.rows[0] || null;
    if (!cuenta) {
      await client.query("ROLLBACK");
      return { updated: false, reason: "not_found" };
    }

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object" ? cuenta.datos_adjuntos : {};
    const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object" ? prevAdjuntos.firma : {};

    if (
      cuenta.estado !== estadoEnFirma ||
      prevFirma?.documento_firmado?.url ||
      !isFirmaCuentaTimedOut(prevFirma, now, timeoutHours)
    ) {
      await client.query("ROLLBACK");
      return { updated: false, reason: "not_timed_out" };
    }

    const firma = buildFirmaCuentaTimeout(prevFirma, { now, timeoutHours, origen });
    const adjuntos = {
      ...prevAdjuntos,
      firma
    };

    await client.query(
      `
      UPDATE cuenta_cobro
      SET datos_adjuntos = $1::jsonb,
          estado = 'Rechazado'::tipo_estado_reporte,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [JSON.stringify(adjuntos), cuenta.id]
    );
    await client.query("COMMIT");

    return {
      updated: true,
      cuenta,
      adjuntos,
      firma,
      estadoDestino: "Rechazado"
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) { }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  FIRMA_CUENTA_TIMEOUT_HOURS,
  FIRMA_CUENTA_TIMEOUT_EVENT,
  FIRMA_CUENTA_TIMEOUT_ESTADO,
  isFirmaCuentaTimedOut,
  buildFirmaCuentaTimeout,
  marcarCuentaCobroFirmaExpirada
};
