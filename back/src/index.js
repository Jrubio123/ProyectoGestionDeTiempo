const path = require("path");
const envFile =
  process.env.NODE_ENV === "production" ? ".env_produccion" : ".env";
require("dotenv").config({ path: path.resolve(process.cwd(), envFile) });
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const http = require("http");
const https = require("https");
const PDFDocument = require("pdfkit");
const { NumerosALetras } = require("numero-a-letras");
const { sendEmail, getGraphAccessToken } = require("./email");
const { pool, getPoolStats, isTransientDbError } = require("./db");
const registerPreregistroRoutes = require("./preregistro-routes");


const app = express();
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === "production" ? "" : "dev_secret");

if (process.env.NODE_ENV === "production" && !JWT_SECRET) {
  throw new Error("JWT_SECRET no está configurado en producción.");
}

/* ===============================
   CONFIGURACIÓN
=============================== */
app.use(helmet({
  contentSecurityPolicy: false
}));
const extraOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: ["http://localhost:3000", "http://localhost:4000", ...extraOrigins],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "X-Graph-Access-Token"],
  exposedHeaders: ["Authorization"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "35mb" }));
app.use(express.urlencoded({ extended: true, limit: "35mb" }));
app.options('*', cors(corsOptions));

/* ===============================
   BASE DE DATOS
=============================== */
let estadoAsignacionCache = null;
let estadoMesaCache = null;
let estadoFabricaCache = null;
const FALLBACK_ESTADO_ASIGNACION = Object.freeze({
  labels: ["Abierto", "Cerrado", "Proceso"],
  abierto: "Abierto",
  proceso: "Proceso",
  cerrado: "Cerrado",
  inactivo: null,
  cancelado: null
});

function resetEnumCaches() {
  estadoAsignacionCache = null;
  estadoMesaCache = null;
  estadoFabricaCache = null;
  estadoCuentaCobroEnFirmaCache = null;
  estadoCuentaCobroAprobadoCache = null;
}

pool.on("error", (err) => {
  if (isTransientDbError(err)) {
    resetEnumCaches();
  }
});

function normalizeEnumLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

async function getEstadoAsignacionValues() {
  if (estadoAsignacionCache) return estadoAsignacionCache;
  try {
    const result = await pool.query(
      `
      SELECT e.enumlabel
      FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = 'tipo_estado_asignacion'
      ORDER BY e.enumsortorder
      `
    );
    const labels = (result.rows || []).map((r) => String(r.enumlabel || "").trim()).filter(Boolean);
    const byNorm = new Map(labels.map((label) => [normalizeEnumLabel(label), label]));
    const pick = (...candidates) => {
      for (const candidate of candidates) {
        const found = byNorm.get(normalizeEnumLabel(candidate));
        if (found) return found;
      }
      return null;
    };

    estadoAsignacionCache = {
      labels,
      abierto: pick("Abierto", "Abierta", "Activo") || labels[0] || "Abierto",
      proceso: pick("Proceso", "En Proceso", "Abierto", "Activo") || labels[0] || "Proceso",
      cerrado: pick("Cerrado", "Cerrada", "Completado") || labels[0] || "Cerrado",
      inactivo: pick("Inactivo", "Inactiva"),
      cancelado: pick("Cancelado", "Cancelada")
    };
    return estadoAsignacionCache;
  } catch (err) {
    console.error("No se pudieron resolver valores de tipo_estado_asignacion:", err.message);
    if (isTransientDbError(err)) {
      return estadoAsignacionCache || FALLBACK_ESTADO_ASIGNACION;
    }
    estadoAsignacionCache = FALLBACK_ESTADO_ASIGNACION;
    return estadoAsignacionCache;
  }
}

function resolveEstadoAsignacionInput(value, estados) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value).trim();
  const norm = normalizeEnumLabel(raw);
  const labels = Array.isArray(estados?.labels) ? estados.labels : [];
  const direct = labels.find((label) => normalizeEnumLabel(label) === norm);
  if (direct) return direct;

  const aliasMap = new Map([
    ["abierto", estados?.abierto],
    ["activo", estados?.abierto],
    ["proceso", estados?.proceso],
    ["enproceso", estados?.proceso],
    ["cerrado", estados?.cerrado],
    ["completado", estados?.cerrado],
    ["inactivo", estados?.inactivo],
    ["cancelado", estados?.cancelado]
  ]);
  return aliasMap.get(norm) || null;
}

function isAsignacionReportableEstado(estado, estados) {
  const rawNorm = normalizeEnumLabel(estado);
  if (!rawNorm) return false;
  const abiertoNorm = normalizeEnumLabel(estados?.abierto);
  const procesoNorm = normalizeEnumLabel(estados?.proceso);
  return rawNorm === abiertoNorm || rawNorm === procesoNorm;
}

function normalizeTipoServicioInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const norm = normalizeEnumLabel(raw);
  const map = new Map([
    ["servicio", "Servicio"],
    ["requerimiento", "Requerimiento"],
    ["incidente", "Incidente"],
    // Compatibilidad por datos viejos en UI
    ["soporte", "Requerimiento"],
    ["consultoria", "Servicio"]
  ]);
  return map.get(norm) || null;
}

function normalizePerfilFabricaInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const norm = normalizeEnumLabel(raw);
  const map = new Map([
    ["abap", "ABAP"],
    ["abaptm", "ABAP TM"],
    ["pipo", "PI/PO"],
    ["cpi", "CPI"],
    ["fiori", "FIORI"],
    ["wf", "WF"],
    ["dataservice", "DATASERVICE"],
    ["datasphere", "DATASPHERE"]
  ]);
  return map.get(norm) || null;
}

function normalizeEstadoMesaInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const norm = normalizeEnumLabel(raw);
  const map = new Map([
    ["cerrado", "Cerrado"],
    ["enproceso", "En proceso"],
    ["transferidosilver", "Transferido Silver"],
    ["transferidocorona", "Transferido Corona"]
  ]);
  return map.get(norm) || null;
}

function normalizeEstadoFabricaInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const norm = normalizeEnumLabel(raw);
  const map = new Map([
    ["endesarrollo", "En desarrollo"],
    ["enproceso", "En desarrollo"],
    ["finalizado", "Finalizado"]
  ]);
  return map.get(norm) || null;
}

async function getEnumLabels(typeName, fallback = []) {
  try {
    const result = await pool.query(
      `
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = $1
      ORDER BY e.enumsortorder
      `,
      [typeName]
    );
    const labels = (result.rows || []).map((r) => String(r.enumlabel || "").trim()).filter(Boolean);
    return {
      labels: labels.length ? labels : fallback,
      fromDb: labels.length > 0
    };
  } catch (err) {
    if (isTransientDbError(err)) {
      resetEnumCaches();
    }
    return { labels: fallback, fromDb: false };
  }
}

async function getEstadoMesaValues() {
  if (estadoMesaCache) return estadoMesaCache;
  const { labels, fromDb } = await getEnumLabels("tipo_estado_mesa", ["Cerrado", "En proceso", "Transferido Silver", "Transferido Corona"]);
  const byNorm = new Map(labels.map((label) => [normalizeEnumLabel(label), label]));
  const pick = (...candidates) => {
    for (const candidate of candidates) {
      const found = byNorm.get(normalizeEnumLabel(candidate));
      if (found) return found;
    }
    return null;
  };
  const resolved = {
    labels,
    cerrado: pick("Cerrado"),
    proceso: pick("En proceso", "En Proceso", "EnProceso"),
    transferidoSilver: pick("Transferido Silver", "TransferidoSilver"),
    transferidoCorona: pick("Transferido Corona", "TransferidoCorona")
  };
  if (fromDb) {
    estadoMesaCache = resolved;
  }
  return resolved;
}

function resolveEstadoMesaInput(value, estadosMesa) {
  if (!value) return null;
  const norm = normalizeEnumLabel(value);
  const labels = Array.isArray(estadosMesa?.labels) ? estadosMesa.labels : [];
  const direct = labels.find((label) => normalizeEnumLabel(label) === norm);
  if (direct) return direct;
  if (norm === "cerrado") return estadosMesa?.cerrado || null;
  if (norm === "enproceso") return estadosMesa?.proceso || null;
  if (norm === "transferidosilver") return estadosMesa?.transferidoSilver || null;
  if (norm === "transferidocorona") return estadosMesa?.transferidoCorona || null;
  return null;
}

async function getEstadoFabricaValues() {
  if (estadoFabricaCache) return estadoFabricaCache;
  const { labels, fromDb } = await getEnumLabels("tipo_estado_fabrica", ["En desarrollo", "Finalizado"]);
  const byNorm = new Map(labels.map((label) => [normalizeEnumLabel(label), label]));
  const pick = (...candidates) => {
    for (const candidate of candidates) {
      const found = byNorm.get(normalizeEnumLabel(candidate));
      if (found) return found;
    }
    return null;
  };
  const resolved = {
    labels,
    proceso: pick("En desarrollo", "En Desarrollo", "En Proceso", "EnProceso"),
    finalizado: pick("Finalizado")
  };
  if (fromDb) {
    estadoFabricaCache = resolved;
  }
  return resolved;
}

function resolveEstadoFabricaInput(value, estadosFabrica) {
  if (!value) return null;
  const norm = normalizeEnumLabel(value);
  const labels = Array.isArray(estadosFabrica?.labels) ? estadosFabrica.labels : [];
  const direct = labels.find((label) => normalizeEnumLabel(label) === norm);
  if (direct) return direct;
  if (norm === "endesarrollo" || norm === "enproceso") return estadosFabrica?.proceso || null;
  if (norm === "finalizado") return estadosFabrica?.finalizado || null;
  return null;
}

function getMesaFabricaScope(tipoAsignacionId, tipoAsignacionTitulo, hints = {}) {
  const tituloNorm = String(tipoAsignacionTitulo || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  const hasMesaHints = [
    hints?.estado_mesa_servicio,
    hints?.tipo_servicio,
    hints?.nro_caso_cliente,
    hints?.nro_caso_interno,
    hints?.nro_caso_int_ext
  ].some((v) => String(v || "").trim() !== "");

  const hasFabricaHints = [
    hints?.estado_fabrica,
    hints?.requerimiento,
    hints?.perfil_fabrica,
    hints?.wricef
  ].some((v) => String(v || "").trim() !== "");
  const tipoAsignacionNumeric = Number(tipoAsignacionId || 0);
  // Dato maestro preferido: si el tipo de asignacion es mesa/fabrica,
  // usamos ese valor salvo que el ticket traiga pistas claras del otro flujo.
  if (tipoAsignacionNumeric === 5) {
    if (hasFabricaHints && !hasMesaHints) return "fabrica";
    return "mesa";
  }
  if (tipoAsignacionNumeric === 6) {
    if (hasMesaHints && !hasFabricaHints) return "mesa";
    return "fabrica";
  }

  const hasMesaByTitle = tituloNorm.includes("mesa de servicio");
  const hasFabricaByTitle = tituloNorm.includes("fabrica");

  if (hasFabricaHints && !hasMesaHints) return "fabrica";
  if (hasMesaHints && !hasFabricaHints) return "mesa";
  if (hasFabricaByTitle && !hasMesaByTitle) return "fabrica";
  if (hasMesaByTitle && !hasFabricaByTitle) return "mesa";
  if (hasFabricaByTitle) return "fabrica";
  if (hasMesaByTitle) return "mesa";
  return null;
}

function normalizeCaseValue(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function parseTicketCaseFields(rawValue) {
  const text = String(rawValue ?? "").trim();
  if (!text) {
    return {
      nro_caso_cliente: null,
      nro_caso_interno: null,
      legacy: null
    };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const cliente = normalizeCaseValue(
        parsed.nro_caso_cliente ?? parsed.cliente ?? parsed.caso_cliente
      );
      const interno = normalizeCaseValue(
        parsed.nro_caso_interno ?? parsed.interno ?? parsed.caso_interno
      );
      if (cliente || interno) {
        return {
          nro_caso_cliente: cliente,
          nro_caso_interno: interno,
          legacy: text
        };
      }
    }
  } catch {
    // Compatibilidad con registros previos donde nro_caso_int_ext era texto plano.
  }
  return {
    nro_caso_cliente: text,
    nro_caso_interno: text,
    legacy: text
  };
}

function serializeTicketCaseFields({
  nroCasoCliente,
  nroCasoInterno,
  nroCasoIntExtFallback
} = {}) {
  const cliente = normalizeCaseValue(nroCasoCliente);
  const interno = normalizeCaseValue(nroCasoInterno);
  if (!cliente && !interno) {
    return normalizeCaseValue(nroCasoIntExtFallback);
  }
  return JSON.stringify({
    nro_caso_cliente: cliente,
    nro_caso_interno: interno
  });
}

function applyTicketCaseFields(row = {}) {
  const parsed = parseTicketCaseFields(row?.nro_caso_int_ext);
  return {
    ...row,
    nro_caso_cliente: parsed.nro_caso_cliente || row?.nro_caso_cliente || null,
    nro_caso_interno: parsed.nro_caso_interno || row?.nro_caso_interno || null
  };
}

function buildTotalLetras(numero, moneda = 'COP') {
  const parteEntera = Math.floor(numero);
  const centavos = Math.round((numero - parteEntera) * 100);

  // Texto base en letras (la librería suele incluir "PESOS 00/100 M.N.")
  let textoNumeros = NumerosALetras(parteEntera).toUpperCase();

  // Limpiar sufijos que agrega la librería
  textoNumeros = textoNumeros.replace(/\s*00\/100\s*/g, '');
  textoNumeros = textoNumeros.replace(/\s*M\.N\.\s*/g, '');
  textoNumeros = textoNumeros
    .replace(/\s*(PESOS?|DOLARES|DÓLARES|EUROS?)\s*$/i, '')
    .replace(/\bDE\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const monedaNorm = String(moneda || "COP").toUpperCase();
  const nombreMoneda = monedaNorm === "USD"
    ? "DÓLARES"
    : monedaNorm === "EUR"
      ? "EUROS"
      : "PESOS";

  if (centavos > 0) {
    return `${textoNumeros} CON ${centavos}/100 ${nombreMoneda}`;
  } else {
    return `${textoNumeros} ${nombreMoneda}`;
  }
}

async function sendEmailSafe({ to, subject, text, html, cc, bcc, attachments, graphAccessToken, graphUserEmail }) {
  try {
    await sendEmail({ to, subject, text, html, cc, bcc, attachments, graphAccessToken, graphUserEmail });
    return { ok: true };
  } catch (err) {
    console.error("Error enviando correo:", err.message);
    return { ok: false, error: String(err?.message || "Error enviando correo") };
  }
}

function getGraphContext(req) {
  return {
    graphAccessToken: req?.headers?.["x-graph-access-token"] || null,
    graphUserEmail: req?.user?.email || null
  };
}

function buildReporteResumen({ horas_reportadas, cantidad_dias_reportados, total_cobrar }) {
  const partes = [];
  if (horas_reportadas) partes.push(`Horas: ${horas_reportadas}`);
  if (cantidad_dias_reportados) partes.push(`Días: ${cantidad_dias_reportados}`);
  if (total_cobrar) partes.push(`Total: ${total_cobrar}`);
  return partes.length ? partes.join(" | ") : "Sin detalle numérico";
}

const FRONT_PORTAL_BASE =
  process.env.FRONT_PORTAL_BASE ||
  "https://zealous-mud-057b4ca0f.1.azurestaticapps.net/index.html";
const ONEDRIVE_ENABLED = String(process.env.ONEDRIVE_ENABLED || "true").toLowerCase() === "true";
const ONEDRIVE_TARGET_USER = process.env.ONEDRIVE_TARGET_USER || "admin.apps@silverconsulting.com.co";
const ONEDRIVE_ROOT_FOLDER = process.env.ONEDRIVE_ROOT_FOLDER || "AdjuntosCuentasCobro";
const CLICKSIGN_API_BASE = String(process.env.CLICKSIGN_API_BASE || "https://api.lleida.net/cs/v1").trim().replace(/\/+$/, "");
const CLICKSIGN_API_KEY = String(process.env.CLICKSIGN_API_KEY || "").trim();
const CLICKSIGN_USER = String(process.env.CLICKSIGN_USER || "").trim();
const CLICKSIGN_CONFIG_ID = Number(process.env.CLICKSIGN_CONFIG_ID || 0);
const CLICKSIGN_SIGNATURE_CB_URL = String(process.env.CLICKSIGN_SIGNATURE_CB_URL || "").trim();
const CLICKSIGN_SIGNATORY_CB_URL = String(process.env.CLICKSIGN_SIGNATORY_CB_URL || "").trim();
const CLICKSIGN_SIGNATORY_EMAIL_CB_URL = String(process.env.CLICKSIGN_SIGNATORY_EMAIL_CB_URL || "").trim();
const CLICKSIGN_WEBHOOK_TOKEN = String(process.env.CLICKSIGN_WEBHOOK_TOKEN || "").trim();
const CLICKSIGN_SIGNED_FILE_URL_TEMPLATE = String(process.env.CLICKSIGN_SIGNED_FILE_URL_TEMPLATE || "").trim();
const CLICKSIGN_SIGNED_NOTIFY_ENABLED = String(process.env.CLICKSIGN_SIGNED_NOTIFY_ENABLED || "true").toLowerCase() === "true";
const CLICKSIGN_SIGNED_NOTIFY_TO = String(process.env.CLICKSIGN_SIGNED_NOTIFY_TO || "proveedores@silverconsulting.com.co").trim();
const CLICKSIGN_SIGNED_NOTIFY_CC = String(process.env.CLICKSIGN_SIGNED_NOTIFY_CC || "").trim();
const CLICKSIGN_SIGNED_NOTIFY_BCC = String(process.env.CLICKSIGN_SIGNED_NOTIFY_BCC || "").trim();
const DEBUG_CLICKSIGN_TOKEN = String(process.env.DEBUG_CLICKSIGN_TOKEN || "").trim();
const providerNotificationInFlight = new Set();
let estadoCuentaCobroEnFirmaCache = null;
let estadoCuentaCobroAprobadoCache = null;

function buildPortalUrl(hashRoute = "inicio") {
  const base = String(FRONT_PORTAL_BASE || "").trim();
  if (!base) return "#";
  const safeHash = String(hashRoute || "inicio").replace(/^#/, "");
  return `${base}#${safeHash}`;
}

function getRequestPublicBaseUrl(req) {
  const protoHeader = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const hostHeader = String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  const host = hostHeader || String(req?.headers?.host || "").trim();
  const proto = protoHeader || req?.protocol || "https";
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function buildEmailLayout({ title, intro, blocks = [], ctaLabel, ctaUrl, closing }) {
  const blockHtml = blocks
    .filter((b) => b?.label)
    .map((b) => `<p style="margin: 0 0 6px;"><strong>${b.label}:</strong> ${b.value || "N/A"}</p>`)
    .join("");

  const ctaHtml = ctaLabel && ctaUrl
    ? `<a href="${ctaUrl}" style="display:inline-block;margin-top:12px;background:#189fa9;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:10px;">${ctaLabel}</a>`
    : "";

  return `
    <div style="font-family:Segoe UI,Arial,sans-serif;color:#20272f;line-height:1.5;">
      <h2 style="margin:0 0 10px;color:#1f2a37;">${title}</h2>
      <p style="margin:0 0 14px;">${intro}</p>
      <div style="background:#f6f8fb;border:1px solid #e6ebf2;border-radius:12px;padding:14px 16px;">
        ${blockHtml}
      </div>
      ${ctaHtml}
      <p style="margin:16px 0 0;color:#5b6678;">${closing || "Atentamente, Silver Consulting."}</p>
    </div>
  `;
}

function resolveCuentaCobroReference(cuenta = {}) {
  const ref = String(cuenta.public_id || cuenta.id || "").trim();
  return ref || "N/A";
}

function resolveCuentaCobroConsultorNombre(cuenta = {}) {
  const nombre = String(cuenta.nombre_usuario || "").trim();
  if (nombre) return nombre;
  const email = String(cuenta.email || "").trim();
  return email || "Consultor";
}

function buildCuentaCobroEmailAttachments({ cuenta, signedPdf = null, extraFiles = [] } = {}) {
  const maxAttachments = 4;
  const maxFileBytes = 8 * 1024 * 1024;
  const attachments = [];
  const cuentaRef = resolveCuentaCobroReference(cuenta);

  const pushPdf = (buffer, fileName, fallbackName) => {
    if (attachments.length >= maxAttachments) return;
    if (!isPdfBuffer(buffer)) return;
    if (buffer.length > maxFileBytes) return;
    const safeName = sanitizePdfFileName(fileName || fallbackName, fallbackName);
    attachments.push({
      filename: safeName,
      contentType: "application/pdf",
      content: buffer
    });
  };

  pushPdf(
    signedPdf?.buffer || null,
    signedPdf?.fileName || signedPdf?.name || "",
    `CuentaCobroFirmada_${cuentaRef}.pdf`
  );

  for (const extra of Array.isArray(extraFiles) ? extraFiles : []) {
    if (attachments.length >= maxAttachments) break;
    pushPdf(
      extra?.buffer || null,
      extra?.fileName || extra?.name || "",
      `${String(extra?.kind || "Adjunto").replace(/[^a-z0-9_-]/gi, "") || "Adjunto"}_${cuentaRef}.pdf`
    );
  }

  return attachments;
}

async function notifyCuentaCobroFirmadaToProveedores({
  cuenta,
  documentoFirmado,
  attachments = [],
  prevNotification = null,
  nowIso = new Date().toISOString(),
  graphContext = {}
} = {}) {
  const prev = prevNotification && typeof prevNotification === "object" ? prevNotification : {};
  if (!CLICKSIGN_SIGNED_NOTIFY_ENABLED || !CLICKSIGN_SIGNED_NOTIFY_TO) return prev;
  if (!documentoFirmado?.url) return prev;
  if (prev.enviada) return prev;

  const cuentaRef = resolveCuentaCobroReference(cuenta);
  const cuentaRefCorta = String(cuenta.public_id || cuenta.id || "").split("-")[0];
  const consultorNombre = resolveCuentaCobroConsultorNombre(cuenta);
  const subject = `Cuenta de cobro firmada | ${consultorNombre} | ${cuentaRefCorta}`;
  const senderEmail = String(cuenta?.email || graphContext?.graphUserEmail || "").trim();
  const notificationLockKey = String(cuenta?.id || cuenta?.public_id || cuentaRef || "").trim();
  if (notificationLockKey && providerNotificationInFlight.has(notificationLockKey)) {
    return null;
  }
  const textoPlano =
    `Se completó la firma digital de una cuenta de cobro.\n` +
    `Consultor: ${consultorNombre}\n` +
    `Cuenta de cobro: ${cuentaRefCorta}\n` +
    `Documento firmado: ${documentoFirmado.url}\n`;
  const html = buildEmailLayout({
    title: "Cuenta de cobro firmada",
    intro: `Se completó la firma digital de la cuenta de cobro <strong>${cuentaRefCorta}</strong>.`,
    blocks: [
      { label: "Consultor", value: consultorNombre },
      { label: "Cuenta de cobro", value: cuentaRefCorta },
      { label: "Documento firmado", value: documentoFirmado.url }
    ],
    ctaLabel: "Abrir documento firmado",
    ctaUrl: documentoFirmado.url,
    closing: "Notificación automática del sistema de cuentas de cobro."
  });

  if (notificationLockKey) providerNotificationInFlight.add(notificationLockKey);
  try {
    let sendResult = await sendEmailSafe({
      graphUserEmail: senderEmail || null,
      to: CLICKSIGN_SIGNED_NOTIFY_TO,
      cc: CLICKSIGN_SIGNED_NOTIFY_CC || null,
      bcc: CLICKSIGN_SIGNED_NOTIFY_BCC || null,
      subject,
      text: textoPlano,
      html,
      attachments
    });

    return {
      ...prev,
      enviada: Boolean(sendResult?.ok),
      ultimo_intento_en: nowIso,
      enviada_en: sendResult?.ok ? nowIso : prev.enviada_en || null,
      destinatario: CLICKSIGN_SIGNED_NOTIFY_TO,
      asunto: subject,
      documento_url: documentoFirmado.url,
      adjuntos_enviados: Array.isArray(attachments) ? attachments.length : 0,
      error: sendResult?.ok ? null : (sendResult?.error || "Error enviando correo")
    };
  } finally {
    if (notificationLockKey) providerNotificationInFlight.delete(notificationLockKey);
  }
}

function isRrhhEstadoNotificable(estado) {
  return ["Reclutamiento", "Entrevistas", "Contratado", "Cancelado"].includes(String(estado || "").trim());
}

function buildRrhhEstadoEmailContent({
  estado,
  perfil,
  cliente,
  modulo,
  coordinadorNombre,
  observaciones,
  portalUrl
}) {
  const base = {
    toName: coordinadorNombre || "Coordinador",
    perfil: perfil || "Perfil",
    cliente: cliente || "N/A",
    modulo: modulo || "N/A",
    nota: observaciones || "Sin nota registrada",
    url: portalUrl || buildPortalUrl("solicitudesCoord")
  };

  if (estado === "Reclutamiento") {
    return {
      subject: `🔍 Actualización: Tu solicitud para ${base.perfil} ya está en Reclutamiento`,
      text:
        `Hola ${base.toName},\n\n` +
        `Te informamos que hemos iniciado la búsqueda activa de candidatos para tu solicitud de ${base.perfil} para el cliente ${base.cliente}.\n` +
        `Estamos filtrando hojas de vida que cumplan con los requisitos del módulo ${base.modulo}.\n\n` +
        `Ver solicitud en el sistema: ${base.url}\n`,
      html: buildEmailLayout({
        title: "Solicitud en fase de reclutamiento",
        intro: `Hola <strong>${base.toName}</strong>, iniciamos la búsqueda activa de candidatos.`,
        blocks: [
          { label: "Perfil", value: base.perfil },
          { label: "Cliente", value: base.cliente },
          { label: "Módulo", value: base.modulo },
          { label: "Estado", value: "Reclutamiento" }
        ],
        ctaLabel: "Ver solicitud en el sistema",
        ctaUrl: base.url
      })
    };
  }

  if (estado === "Entrevistas") {
    return {
      subject: `🤝 Actualización: Iniciamos fase de entrevistas para ${base.perfil}`,
      text:
        `Hola ${base.toName},\n\n` +
        `¡Buenas noticias! Ya tenemos candidatos pre-seleccionados para la vacante de ${base.perfil}.\n` +
        `En los próximos días estaremos coordinando las agendas para las entrevistas técnicas/administrativas.\n\n` +
        `Ver solicitud en el sistema: ${base.url}\n`,
      html: buildEmailLayout({
        title: "Solicitud en fase de entrevistas",
        intro: `Hola <strong>${base.toName}</strong>, ya contamos con candidatos pre-seleccionados.`,
        blocks: [
          { label: "Perfil", value: base.perfil },
          { label: "Cliente", value: base.cliente },
          { label: "Estado", value: "Entrevistas" }
        ],
        ctaLabel: "Ver solicitud en el sistema",
        ctaUrl: base.url
      })
    };
  }

  if (estado === "Contratado") {
    return {
      subject: `✅ ¡Misión Cumplida! Vacante cubierta para ${base.perfil}`,
      text:
        `Hola ${base.toName},\n\n` +
        `Nos alegra informarte que el proceso para ${base.perfil} ha finalizado con éxito.\n` +
        `El candidato ha sido seleccionado y el proceso de contratación está en marcha.\n` +
        `La solicitud se marca como completada.\n\n` +
        `Ver solicitud en el sistema: ${base.url}\n`,
      html: buildEmailLayout({
        title: "Solicitud completada",
        intro: `Hola <strong>${base.toName}</strong>, la vacante fue cubierta exitosamente.`,
        blocks: [
          { label: "Perfil", value: base.perfil },
          { label: "Cliente", value: base.cliente },
          { label: "Estado", value: "Contratado" }
        ],
        ctaLabel: "Ver solicitud en el sistema",
        ctaUrl: base.url
      })
    };
  }

  if (estado === "Cancelado") {
    return {
      subject: `🚫 Notificación: Solicitud Cancelada - ${base.perfil}`,
      text:
        `Hola ${base.toName},\n\n` +
        `Se ha registrado la cancelación de la solicitud para ${base.perfil}.\n` +
        `Motivo/Nota: ${base.nota}\n\n` +
        `Por favor, revisa los detalles y comienza el proceso correspondiente.\n\n` +
        `Ver solicitud en el sistema: ${base.url}\n`,
      html: buildEmailLayout({
        title: "Solicitud cancelada",
        intro: `Hola <strong>${base.toName}</strong>, se registró la cancelación de la solicitud.`,
        blocks: [
          { label: "Perfil", value: base.perfil },
          { label: "Cliente", value: base.cliente },
          { label: "Estado", value: "Cancelado" },
          { label: "Motivo/Nota", value: base.nota }
        ],
        ctaLabel: "Ver solicitud en el sistema",
        ctaUrl: base.url
      })
    };
  }

  return null;
}

const normalizeValue = (value) => String(value || "").toLowerCase().trim();
const isGuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );

const ID_TABLES = Object.freeze({
  bancos: "bancos",
  roles: "roles",
  tipoCuentaBancaria: "tipo_cuenta_bancaria",
  documentoIdentidad: "documento_identidad",
  clientes: "clientes",
  tipoAsignacion: "tipo_asignacion",
  modulo: "modulo",
  usuarios: "usuarios",
  consultorias: "consultorias",
  tarifaConsultor: "tarifa_consultor",
  registroAsignaciones: "registro_asignaciones",
  cuentaCobro: "cuenta_cobro",
  reporteHoras: "reporte_horas",
  solicitudesRrhh: "solicitudes_rrhh",
  preregistroPersonas: "preregistro_personas"
});

const ALLOWED_PUBLIC_ID_TABLES = new Set(Object.values(ID_TABLES));

function isNumericId(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function makePublicIdNotFoundError(tableName, value) {
  const err = new Error(`No se encontró registro para ${tableName}`);
  err.code = "PUBLIC_ID_NOT_FOUND";
  err.table = tableName;
  err.value = value;
  return err;
}

function normalizeIdInput(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

async function resolveInternalId(db, tableName, value, { required = false } = {}) {
  const raw = normalizeIdInput(value);
  if (!raw) {
    if (required) throw makePublicIdNotFoundError(tableName, value);
    return null;
  }

  if (isNumericId(raw)) return Number(raw);
  if (!isGuid(raw)) {
    if (required) throw makePublicIdNotFoundError(tableName, value);
    return null;
  }

  if (!ALLOWED_PUBLIC_ID_TABLES.has(tableName)) {
    throw new Error(`Tabla no permitida para resolver public_id: ${tableName}`);
  }

  const result = await db.query(
    `SELECT id FROM ${tableName} WHERE public_id = $1 LIMIT 1`,
    [raw]
  );
  const resolved = result.rows[0]?.id || null;
  if (!resolved && required) throw makePublicIdNotFoundError(tableName, value);
  return resolved;
}

async function resolveInternalIds(db, tableName, values = []) {
  if (!Array.isArray(values) || values.length === 0) return [];

  const normalized = values.map((value) => normalizeIdInput(value));
  const publicIds = [];
  const publicSet = new Set();

  for (const raw of normalized) {
    if (!raw) throw makePublicIdNotFoundError(tableName, raw);
    if (isNumericId(raw)) continue;
    if (!isGuid(raw)) throw makePublicIdNotFoundError(tableName, raw);
    if (!publicSet.has(raw)) {
      publicSet.add(raw);
      publicIds.push(raw);
    }
  }

  const byPublicId = new Map();
  if (publicIds.length > 0) {
    if (!ALLOWED_PUBLIC_ID_TABLES.has(tableName)) {
      throw new Error(`Tabla no permitida para resolver public_id: ${tableName}`);
    }
    const result = await db.query(
      `SELECT id, public_id FROM ${tableName} WHERE public_id = ANY($1::uuid[])`,
      [publicIds]
    );
    for (const row of result.rows || []) {
      byPublicId.set(String(row.public_id), row.id);
    }
    for (const raw of publicIds) {
      if (!byPublicId.has(raw)) {
        throw makePublicIdNotFoundError(tableName, raw);
      }
    }
  }

  return normalized.map((raw) => (isNumericId(raw) ? Number(raw) : byPublicId.get(raw)));
}

const MAX_TICKETS_POR_ASIGNACION = 10;

function toNullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function buildUserResponse(userRow) {
  return {
    id: userRow?.public_id || (userRow?.id ? String(userRow.id) : null),
    nombre_usuario: userRow?.nombre_usuario || "",
    email: userRow?.email || "",
    rol: userRow?.rol || "",
    rol_usuario_id: userRow?.rol_usuario_id || null,
    tipo_consultor: userRow?.tipo_consultor || null
  };
}

function withPublicId(row) {
  if (!row || typeof row !== "object") return row;
  if (!row.public_id) return row;
  return {
    ...row,
    id: row.public_id
  };
}

function graphGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "graph.microsoft.com",
      path,
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (e) {
            resolve({});
          }
        } else {
          reject(new Error(`Graph error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function graphGetBinary(path, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "graph.microsoft.com",
      path,
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const statusCode = Number(res.statusCode || 0);
        if (statusCode >= 200 && statusCode < 300) {
          return resolve({
            statusCode,
            buffer,
            contentType: String(res.headers["content-type"] || "image/jpeg")
          });
        }
        return reject(
          new Error(
            `Graph binary error ${statusCode}: ${buffer.toString("utf8")}`
          )
        );
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function graphPost(path, accessToken, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const options = {
      hostname: "graph.microsoft.com",
      path,
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (e) {
            resolve({});
          }
        } else {
          reject(new Error(`Graph error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function graphPutBinary(path, accessToken, buffer, contentType = "application/octet-stream") {
  return new Promise((resolve, reject) => {
    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
    const options = {
      hostname: "graph.microsoft.com",
      path,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": contentType,
        "Content-Length": payload.length
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (e) {
            resolve({});
          }
        } else {
          reject(new Error(`Graph error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function encodeGraphPath(pathValue) {
  return String(pathValue || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function sanitizePathSegment(value, fallback = "sin-valor") {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*#%{}~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

function sanitizePdfFileName(value, fallback = "documento.pdf") {
  const safe = sanitizePathSegment(value || fallback, fallback).replace(/\.+/g, ".");
  if (!safe.toLowerCase().endsWith(".pdf")) return `${safe}.pdf`;
  return safe;
}

function parsePdfDataUrl(dataUrl) {
  const raw = String(dataUrl || "");
  const match = raw.match(/^data:(application\/pdf|application\/octet-stream);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  try {
    return Buffer.from(match[2], "base64");
  } catch (err) {
    return null;
  }
}

function isPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  return buffer.slice(0, 4).toString("utf8") === "%PDF";
}

async function ensureGraphFolder(accessToken, userEmail, parentPath, folderName) {
  const encodedUser = encodeURIComponent(userEmail);
  const safeFolderName = sanitizePathSegment(folderName, "carpeta");
  const requestPath = parentPath
    ? `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(parentPath)}:/children`
    : `/v1.0/users/${encodedUser}/drive/root/children`;

  try {
    await graphPost(requestPath, accessToken, {
      name: safeFolderName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail"
    });
  } catch (err) {
    const errorText = String(err.message || "");
    const alreadyExists =
      errorText.includes("nameAlreadyExists") ||
      errorText.includes("itemAlreadyExists");
    if (!alreadyExists) {
      throw err;
    }
  }

  return parentPath ? `${parentPath}/${safeFolderName}` : safeFolderName;
}

function resolveGraphPath(nextLink) {
  if (!nextLink) return null;
  if (nextLink.startsWith("https://graph.microsoft.com")) {
    try {
      const url = new URL(nextLink);
      return `${url.pathname}${url.search}`;
    } catch (err) {
      return null;
    }
  }
  return nextLink;
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch (err) {
    return null;
  }
}

function parseGraphErrorStatus(message) {
  const match = String(message || "").match(/Graph(?: binary)? error (\d{3})/);
  return match ? Number(match[1]) : null;
}

async function graphGetAll(path, accessToken, maxPages = 20) {
  const values = [];
  let nextPath = path;
  let pages = 0;

  while (nextPath && pages < maxPages) {
    const data = await graphGet(nextPath, accessToken);
    if (Array.isArray(data?.value)) {
      values.push(...data.value);
    }
    nextPath = resolveGraphPath(data?.["@odata.nextLink"]);
    pages += 1;
  }

  return values;
}

function buildClickSignUrl(pathName) {
  const suffix = String(pathName || "").replace(/^\/+/, "");
  return `${CLICKSIGN_API_BASE}/${suffix}`;
}

function normalizeClickSignBaseUrl(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (raw.endsWith("/cs/v1")) return raw;
  return `${raw}/cs/v1`;
}

function buildClickSignCustomUrl(baseUrl, pathName) {
  const base = normalizeClickSignBaseUrl(baseUrl);
  const suffix = String(pathName || "").replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

function maskSecret(value, visible = 4) {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.length <= visible) return "*".repeat(raw.length);
  return `${"*".repeat(Math.max(0, raw.length - visible))}${raw.slice(-visible)}`;
}

function buildClickSignAuthHeaders({ includeLegacyHeader = true, includeJsonHeaders = true } = {}) {
  const headers = {
    Authorization: `x-api-key ${CLICKSIGN_API_KEY}`
  };
  if (includeLegacyHeader) {
    headers["x-api-key"] = CLICKSIGN_API_KEY;
  }
  if (includeJsonHeaders) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    headers.Accept = "application/json";
  }
  return headers;
}

function getByPath(source, pathName) {
  const parts = String(pathName || "").split(".");
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }
    current = current[part];
  }
  return current;
}

function pickStringByPaths(source, paths = []) {
  for (const pathName of paths) {
    const value = getByPath(source, pathName);
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function parseJsonSafe(rawText) {
  try {
    return JSON.parse(rawText || "{}");
  } catch (err) {
    return { raw: String(rawText || "") };
  }
}

function jsonRequest({ method = "GET", url, headers = {}, body = null, timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload =
      body === null || body === undefined
        ? null
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));

    const requestHeaders = { ...headers };
    if (payload && !requestHeaders["Content-Type"] && !requestHeaders["content-type"]) {
      requestHeaders["Content-Type"] = "application/json";
    }
    if (payload && !requestHeaders["Content-Length"] && !requestHeaders["content-length"]) {
      requestHeaders["Content-Length"] = String(payload.length);
    }

    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: requestHeaders
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const status = Number(res.statusCode || 0);
          const parsedBody = parseJsonSafe(data);
          if (status >= 200 && status < 300) {
            resolve({ status, data: parsedBody });
            return;
          }
          const err = new Error(`HTTP ${status} ${method} ${parsed.pathname}`);
          err.status = status;
          err.response = parsedBody;
          reject(err);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("HTTP_TIMEOUT"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function binaryRequest({ method = "GET", url, headers = {}, body = null, timeoutMs = 30000, maxRedirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload =
      body === null || body === undefined
        ? null
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));

    const requestHeaders = { ...headers };
    if (payload && !requestHeaders["Content-Length"] && !requestHeaders["content-length"]) {
      requestHeaders["Content-Length"] = String(payload.length);
    }

    const transport = parsed.protocol === "http:" ? http : https;
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: requestHeaders
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        const location = String(res.headers?.location || "").trim();
        if (status >= 300 && status < 400 && location && maxRedirects > 0) {
          const redirectedUrl = new URL(location, parsed).toString();
          res.resume();
          return resolve(
            binaryRequest({
              method: "GET",
              url: redirectedUrl,
              headers,
              body: null,
              timeoutMs,
              maxRedirects: maxRedirects - 1
            })
          );
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (status >= 200 && status < 300) {
            return resolve({
              status,
              buffer,
              contentType: String(res.headers?.["content-type"] || "").toLowerCase(),
              finalUrl: parsed.toString()
            });
          }
          const err = new Error(`HTTP ${status} ${method} ${parsed.pathname}`);
          err.status = status;
          err.response = parseJsonSafe(buffer.toString("utf8"));
          reject(err);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("HTTP_TIMEOUT"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseBase64Pdf(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;
  const fromDataUrl = parsePdfDataUrl(raw);
  if (isPdfBuffer(fromDataUrl)) return fromDataUrl;

  const compact = normalizeBase64Input(raw);
  if (!compact) return null;
  try {
    const buffer = Buffer.from(compact, "base64");
    return isPdfBuffer(buffer) ? buffer : null;
  } catch (err) {
    return null;
  }
}

function parseBase64Buffer(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;
  const compact = normalizeBase64Input(raw);
  if (!compact) return null;
  try {
    const buffer = Buffer.from(compact, "base64");
    return buffer.length ? buffer : null;
  } catch (err) {
    return null;
  }
}

function normalizeBase64Input(rawValue) {
  const compact = String(rawValue || "").replace(/\s+/g, "");
  if (!compact) return "";
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return "";
  const missingPadding = normalized.length % 4;
  return missingPadding ? `${normalized}${"=".repeat(4 - missingPadding)}` : normalized;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch (err) {
    return false;
  }
}

function sameResourceUrl(a, b) {
  const ua = String(a || "").trim();
  const ub = String(b || "").trim();
  if (!ua || !ub) return false;
  return ua === ub;
}

function applyTemplatePlaceholders(template, values = {}) {
  let output = String(template || "");
  for (const [key, value] of Object.entries(values)) {
    const safeValue = encodeURIComponent(String(value || ""));
    output = output.replace(new RegExp(`\\{${key}\\}`, "gi"), safeValue);
  }
  return output.trim();
}

function extractSignedPdfCandidate(source) {
  if (!source || typeof source !== "object") return null;
  const fileUrl = pickStringByPaths(source, [
    "signed_file_url",
    "signed_url",
    "file_url",
    "document_url",
    "signature.signed_file_url",
    "signature.file_url",
    "signature.document_url",
    "signature.file.0.url",
    "signature.files.0.url",
    "data.signed_file_url",
    "data.file_url",
    "data.document_url",
    "data.signature.file.0.url",
    "data.signature.files.0.url"
  ]);
  const fileBase64 = pickStringByPaths(source, [
    "signed_file_base64",
    "file_base64",
    "document_base64",
    "signature.signed_file_base64",
    "signature.file_base64",
    "signature.document_base64",
    "signature.file.0.content",
    "signature.files.0.content",
    "data.signed_file_base64",
    "data.file_base64",
    "data.document_base64",
    "data.signature.file.0.content",
    "data.signature.files.0.content"
  ]);
  const fileName = pickStringByPaths(source, [
    "signed_file_name",
    "signed_filename",
    "file_name",
    "filename",
    "signature.file.0.filename",
    "signature.files.0.filename",
    "data.signature.file.0.filename",
    "data.signature.files.0.filename"
  ]);

  if (!fileUrl && !fileBase64) return null;
  return {
    url: fileUrl,
    base64: fileBase64,
    fileName: sanitizePdfFileName(fileName || "CuentaCobroFirmada.pdf", "CuentaCobroFirmada.pdf")
  };
}

async function resolveSignedPdfFromSource(source, preferredName = "CuentaCobroFirmada.pdf") {
  const candidate = extractSignedPdfCandidate(source);
  if (!candidate) return null;

  const fromBase64 = parseBase64Pdf(candidate.base64);
  if (isPdfBuffer(fromBase64)) {
    return {
      buffer: fromBase64,
      fileName: candidate.fileName || preferredName,
      source: "payload_base64"
    };
  }

  let candidateUrl = String(candidate.url || "").trim();
  if (candidateUrl && !isHttpUrl(candidateUrl) && candidateUrl.startsWith("/")) {
    try {
      candidateUrl = new URL(candidateUrl, `${CLICKSIGN_API_BASE}/`).toString();
    } catch (err) {
      candidateUrl = "";
    }
  }
  if (!isHttpUrl(candidateUrl)) return null;

  const tryHeaders = [
    {},
    CLICKSIGN_API_KEY ? buildClickSignAuthHeaders({ includeJsonHeaders: false }) : {}
  ];

  for (const headers of tryHeaders) {
    try {
      const downloaded = await binaryRequest({
        method: "GET",
        url: candidateUrl,
        headers
      });
      if (isPdfBuffer(downloaded.buffer)) {
        return {
          buffer: downloaded.buffer,
          fileName: candidate.fileName || preferredName,
          source: "payload_url"
        };
      }
      if (downloaded.contentType.includes("application/json")) {
        const nested = parseJsonSafe(downloaded.buffer.toString("utf8"));
        const nestedResolved = await resolveSignedPdfFromSource(nested, preferredName);
        if (nestedResolved) return nestedResolved;
      }
    } catch (err) {
      // Se sigue con otras variantes/cabeceras.
    }
  }

  return null;
}

function buildClickSignLookupRequests({ requestId = "", contractId = "", signatureId = "" } = {}) {
  const requests = [];
  const rid = String(requestId || "").trim();
  const cid = String(contractId || "").trim();
  const sidRaw = String(signatureId || "").trim();
  const sid = /^\d+$/.test(sidRaw) ? sidRaw : "";
  const buildApiRequestId = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

  if (rid) {
    requests.push(
      { method: "GET", path: `get_signature?request_id=${encodeURIComponent(rid)}` },
      { method: "GET", path: `signature_status?request_id=${encodeURIComponent(rid)}` },
      { method: "GET", path: `get_signature_status?request_id=${encodeURIComponent(rid)}` },
      { method: "GET", path: `get_signature/${encodeURIComponent(rid)}` },
      { method: "GET", path: `signature_status/${encodeURIComponent(rid)}` },
      {
        method: "POST",
        path: "get_signature",
        body: { request: "GET_SIGNATURE", request_id: buildApiRequestId("get-signature"), user: CLICKSIGN_USER, request_id_search: rid }
      },
      {
        method: "POST",
        path: "get_signature",
        body: { request: "GET_SIGNATURE", request_id: buildApiRequestId("get-signature"), user: CLICKSIGN_USER, signature: { request_id: rid } }
      },
      {
        method: "POST",
        path: "get_signature",
        body: { request: "GET_SIGNATURE", request_id: rid, user: CLICKSIGN_USER }
      },
      {
        method: "POST",
        path: "signature_status",
        body: { request: "GET_SIGNATURE_STATUS", request_id: buildApiRequestId("signature-status"), user: CLICKSIGN_USER, request_id_search: rid }
      },
      {
        method: "POST",
        path: "signature_status",
        body: { request: "GET_SIGNATURE_STATUS", request_id: buildApiRequestId("signature-status"), user: CLICKSIGN_USER, signature: { request_id: rid } }
      },
      {
        method: "POST",
        path: "signature_status",
        body: { request: "GET_SIGNATURE_STATUS", request_id: rid, user: CLICKSIGN_USER }
      },
      {
        method: "POST",
        path: "get_signature_status",
        body: { request: "GET_SIGNATURE_STATUS", request_id: buildApiRequestId("get-signature-status"), user: CLICKSIGN_USER, request_id_search: rid }
      }
    );
  }

  if (cid) {
    requests.push(
      { method: "GET", path: `get_signature?contract_id=${encodeURIComponent(cid)}` },
      { method: "GET", path: `signature_status?contract_id=${encodeURIComponent(cid)}` },
      { method: "GET", path: `get_signature_status?contract_id=${encodeURIComponent(cid)}` },
      {
        method: "POST",
        path: "get_signature",
        body: { request: "GET_SIGNATURE", request_id: buildApiRequestId("get-signature"), contract_id: cid, user: CLICKSIGN_USER }
      },
      {
        method: "POST",
        path: "get_signature",
        body: { request: "GET_SIGNATURE", request_id: buildApiRequestId("get-signature"), user: CLICKSIGN_USER, signature: { contract_id: cid } }
      },
      {
        method: "POST",
        path: "signature_status",
        body: { request: "GET_SIGNATURE_STATUS", request_id: buildApiRequestId("signature-status"), user: CLICKSIGN_USER, contract_id: cid }
      },
      {
        method: "POST",
        path: "signature_status",
        body: { request: "GET_SIGNATURE_STATUS", request_id: buildApiRequestId("signature-status"), user: CLICKSIGN_USER, signature: { contract_id: cid } }
      },
      {
        method: "POST",
        path: "get_signature_status",
        body: { request: "GET_SIGNATURE_STATUS", request_id: buildApiRequestId("get-signature-status"), user: CLICKSIGN_USER, contract_id: cid }
      }
    );
  }

  if (sid) {
    requests.push(
      { method: "GET", path: `get_signature?signature_id=${encodeURIComponent(sid)}` },
      { method: "GET", path: `signature_status?signature_id=${encodeURIComponent(sid)}` },
      { method: "GET", path: `get_signature_status?signature_id=${encodeURIComponent(sid)}` },
      {
        method: "POST",
        path: "get_signature",
        body: { request: "GET_SIGNATURE", request_id: buildApiRequestId("get-signature"), user: CLICKSIGN_USER, signature_id: sid }
      },
      {
        method: "POST",
        path: "get_signature",
        body: { request: "GET_SIGNATURE", request_id: buildApiRequestId("get-signature"), user: CLICKSIGN_USER, signature: { signature_id: sid } }
      },
      {
        method: "POST",
        path: "signature_status",
        body: { request: "GET_SIGNATURE_STATUS", request_id: buildApiRequestId("signature-status"), user: CLICKSIGN_USER, signature_id: sid }
      },
      {
        method: "POST",
        path: "signature_status",
        body: { request: "GET_SIGNATURE_STATUS", request_id: buildApiRequestId("signature-status"), user: CLICKSIGN_USER, signature: { signature_id: sid } }
      }
    );
  }

  return requests;
}

function buildCuentaCobroFolderContext(cuenta = {}) {
  const fechaBase = String(cuenta.fecha_correspondiente || cuenta.created_at || new Date().toISOString()).slice(0, 10);
  const consultorFolder = sanitizePathSegment(
    cuenta.nombre_usuario || `Consultor_${cuenta.created_by || "NA"}`,
    `Consultor_${cuenta.created_by || "NA"}`
  );
  const cuentaFolderToken = String(cuenta.public_id || cuenta.id || "cuenta").split("-")[0];
  const cuentaFolderName = `CuentaCobro_${cuentaFolderToken}_${fechaBase}`;
  return { consultorFolder, cuentaFolderToken, cuentaFolderName };
}

async function uploadSignedPdfToOneDrive(cuenta, pdfBuffer, fileName, { accessToken = "" } = {}) {
  if (!ONEDRIVE_ENABLED) {
    const err = new Error("ONEDRIVE_DISABLED");
    err.code = "ONEDRIVE_DISABLED";
    throw err;
  }
  if (!isPdfBuffer(pdfBuffer)) {
    const err = new Error("SIGNED_PDF_INVALID");
    err.code = "SIGNED_PDF_INVALID";
    throw err;
  }

  let token = String(accessToken || "").trim();
  if (!token) {
    try {
      token = await getGraphAccessToken();
    } catch (err) {
      const tokenErr = new Error(`No se pudo obtener token de Microsoft Graph: ${err?.message || err}`);
      tokenErr.code = "GRAPH_TOKEN_ERROR";
      throw tokenErr;
    }
  }
  const encodedUser = encodeURIComponent(ONEDRIVE_TARGET_USER);
  await graphGet(`/v1.0/users/${encodedUser}/drive`, token);

  const { consultorFolder, cuentaFolderToken, cuentaFolderName } = buildCuentaCobroFolderContext(cuenta);
  let targetPath = sanitizePathSegment(ONEDRIVE_ROOT_FOLDER, "AdjuntosCuentasCobro");
  targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, "", targetPath);
  targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, consultorFolder);
  targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, cuentaFolderName);

  const safeName = sanitizePdfFileName(
    fileName || `CuentaCobroFirmada_${cuentaFolderToken}.pdf`,
    `CuentaCobroFirmada_${cuentaFolderToken}.pdf`
  );
  const uploadPath = `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(`${targetPath}/${safeName}`)}:/content`;
  const uploaded = await graphPutBinary(uploadPath, token, pdfBuffer, "application/pdf");

  return {
    carpeta: targetPath,
    archivo: {
      id: uploaded.id,
      nombre: uploaded.name || safeName,
      url: uploaded.webUrl || ""
    }
  };
}

async function resolveSignedPdfFromClickSign({ event, requestId, contractId, publicId, signatureId }) {
  const defaultName = sanitizePdfFileName(
    `CuentaCobroFirmada_${publicId || requestId || "documento"}.pdf`,
    "CuentaCobroFirmada.pdf"
  );

  const direct = await resolveSignedPdfFromSource(event, defaultName);
  if (direct) return direct;

  const templateUrl = applyTemplatePlaceholders(CLICKSIGN_SIGNED_FILE_URL_TEMPLATE, {
    request_id: requestId || "",
    contract_id: contractId || "",
    public_id: publicId || ""
  });
  if (isHttpUrl(templateUrl)) {
    try {
      const downloaded = await binaryRequest({
        method: "GET",
        url: templateUrl,
        headers: CLICKSIGN_API_KEY
          ? buildClickSignAuthHeaders({ includeJsonHeaders: false })
          : {}
      });
      if (isPdfBuffer(downloaded.buffer)) {
        return {
          buffer: downloaded.buffer,
          fileName: defaultName,
          source: "template_url"
        };
      }
    } catch (err) {
      // Se continúa con consultas de fallback.
    }
  }

  const lookupRequests = buildClickSignLookupRequests({ requestId, contractId, signatureId });
  for (const lookup of lookupRequests) {
    try {
      const response = await jsonRequest({
        method: lookup.method,
        url: buildClickSignUrl(lookup.path),
        headers: buildClickSignAuthHeaders(),
        body: lookup.body || null
      });
      const resolved = await resolveSignedPdfFromSource(response.data, defaultName);
      if (resolved) {
        return {
          ...resolved,
          source: `lookup_${lookup.path}`
        };
      }
    } catch (err) {
      // Algunos endpoints no existen según plan contratado; se ignora y continúa.
    }
  }

  return null;
}

function extractClickSignSignatureId(source) {
  return pickStringByPaths(source, [
    "signature.signature_id",
    "signature.signatureId",
    "signature.id",
    "signature_id",
    "signatureId",
    "id",
    "file_list.signature_id",
    "file_list.signatureId",
    "data.signature.signature_id",
    "data.signature.signatureId",
    "data.signature.id",
    "data.signature_id",
    "data.signatureId",
    "data.file_list.signature_id",
    "data.file_list.signatureId",
    "result.signature.signature_id",
    "result.signature.signatureId",
    "result.signature_id",
    "result.signatureId"
  ]);
}

function normalizeClickSignFileEntries(source) {
  const candidates = [
    getByPath(source, "file_list.files"),
    getByPath(source, "data.file_list.files"),
    getByPath(source, "result.file_list.files"),
    getByPath(source, "signature.file"),
    getByPath(source, "signature.files"),
    getByPath(source, "data.signature.file"),
    getByPath(source, "data.signature.files"),
    getByPath(source, "file"),
    getByPath(source, "files")
  ];
  const entries = [];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const fileId = String(item.file_id || item.id || "").trim();
      const rawFileType = String(item.file_type || item.type || item.file_group || item.group || "").trim();
      const fileType = rawFileType.toLowerCase().replace(/\s+/g, "_");
      const fileName = sanitizePdfFileName(
        item.filename || item.file_name || item.name || "DocumentoClickSign.pdf",
        "DocumentoClickSign.pdf"
      );
      if (!fileId) continue;
      entries.push({ fileId, fileType, fileName });
    }
  }
  return entries;
}

async function fetchClickSignFileListEntries({ requestId, contractId, signatureId }) {
  const signatureIdRaw = String(signatureId || "").trim();
  const signatureIdValue = /^\d+$/.test(signatureIdRaw) ? signatureIdRaw : "";
  if (!signatureIdValue && !requestId && !contractId) return [];

  const basePayload = {
    request: "GET_FILE_LIST",
    request_id: `file-list-${Date.now()}`,
    user: CLICKSIGN_USER
  };
  const bodyCandidates = [];
  if (signatureIdValue) {
    bodyCandidates.push({ ...basePayload, signature_id: signatureIdValue });
    bodyCandidates.push({ ...basePayload, password: CLICKSIGN_API_KEY, signature_id: signatureIdValue });
    bodyCandidates.push({ ...basePayload, signature: { signature_id: signatureIdValue } });
    bodyCandidates.push({ ...basePayload, password: CLICKSIGN_API_KEY, signature: { signature_id: signatureIdValue } });
  }
  if (requestId) {
    bodyCandidates.push({ ...basePayload, request_id_search: requestId });
    bodyCandidates.push({ ...basePayload, signature: { request_id: requestId } });
    bodyCandidates.push({ ...basePayload, password: CLICKSIGN_API_KEY, request_id_search: requestId });
    bodyCandidates.push({ ...basePayload, password: CLICKSIGN_API_KEY, signature: { request_id: requestId } });
  }
  if (contractId) {
    bodyCandidates.push({ ...basePayload, contract_id: contractId });
    bodyCandidates.push({ ...basePayload, signature: { contract_id: contractId } });
    bodyCandidates.push({ ...basePayload, password: CLICKSIGN_API_KEY, contract_id: contractId });
    bodyCandidates.push({ ...basePayload, password: CLICKSIGN_API_KEY, signature: { contract_id: contractId } });
  }

  for (const body of bodyCandidates) {
    try {
      const response = await jsonRequest({
        method: "POST",
        url: buildClickSignUrl("get_file_list"),
        headers: buildClickSignAuthHeaders(),
        body
      });
      const entries = normalizeClickSignFileEntries(response?.data || {});
      if (entries.length > 0) {
        return entries;
      }
    } catch (err) {
      // Se ignora y continúa con otras variantes.
    }
  }

  return [];
}

async function fetchClickSignFilesCatalog({ event, requestId, contractId, signatureId }) {
  const fromEvent = normalizeClickSignFileEntries(event);
  if (fromEvent.length > 0) {
    return { entries: fromEvent, source: "event" };
  }

  const fromFileList = await fetchClickSignFileListEntries({ requestId, contractId, signatureId });
  if (fromFileList.length > 0) {
    return { entries: fromFileList, source: "get_file_list" };
  }

  const signatureIdRaw = String(signatureId || extractClickSignSignatureId(event) || "").trim();
  const signatureIdValue = /^\d+$/.test(signatureIdRaw) ? signatureIdRaw : "";
  const bodies = [];
  if (requestId) {
    bodies.push({ request: "GET_SIGNATURE", request_id: `sig-${Date.now()}`, user: CLICKSIGN_USER, signature: { request_id: requestId } });
    bodies.push({ request: "GET_SIGNATURE", request_id: `sig-${Date.now()}-rid`, user: CLICKSIGN_USER, request_id_search: requestId });
  }
  if (contractId) {
    bodies.push({ request: "GET_SIGNATURE", request_id: `sig-${Date.now()}-cid`, user: CLICKSIGN_USER, signature: { contract_id: contractId } });
    bodies.push({ request: "GET_SIGNATURE", request_id: `sig-${Date.now()}-cid2`, user: CLICKSIGN_USER, contract_id: contractId });
  }
  if (signatureIdValue) {
    bodies.push({ request: "GET_SIGNATURE", request_id: `sig-${Date.now()}-sid`, user: CLICKSIGN_USER, signature_id: signatureIdValue });
    bodies.push({ request: "GET_SIGNATURE", request_id: `sig-${Date.now()}-sid2`, user: CLICKSIGN_USER, signature: { signature_id: signatureIdValue } });
    bodies.push({ request: "GET_SIGNATURE", request_id: `sig-${Date.now()}-sid3`, user: CLICKSIGN_USER, password: CLICKSIGN_API_KEY, signature_id: signatureIdValue });
    bodies.push({ request: "GET_SIGNATURE", request_id: `sig-${Date.now()}-sid4`, user: CLICKSIGN_USER, password: CLICKSIGN_API_KEY, signature: { signature_id: signatureIdValue } });
  }
  bodies.push({ request: "GET_SIGNATURE", request_id: `sig-${Date.now()}-fallback`, user: CLICKSIGN_USER, request_id: requestId || undefined, contract_id: contractId || undefined });

  for (const body of bodies) {
    try {
      const response = await jsonRequest({
        method: "POST",
        url: buildClickSignUrl("get_signature"),
        headers: buildClickSignAuthHeaders(),
        body
      });
      const entries = normalizeClickSignFileEntries(response?.data || {});
      if (entries.length > 0) {
        return { entries, source: "get_signature" };
      }
    } catch (err) {
      // Se ignora y continúa con otras variantes.
    }
  }

  return { entries: [], source: "" };
}

async function fetchClickSignFileBuffer(fileId) {
  const fileIdValue = String(fileId || "").trim();
  if (!fileIdValue) return null;
  const bodyVariants = [
    { request: "GET_FILE", request_id: `file-${Date.now()}`, user: CLICKSIGN_USER, file_id: fileIdValue },
    { request: "GET_FILE", request_id: `file-${Date.now()}-alt`, user: CLICKSIGN_USER, password: CLICKSIGN_API_KEY, file_id: fileIdValue },
    { request: "GET_FILE", request_id: `file-${Date.now()}-legacy`, user: CLICKSIGN_USER, file: { file_id: fileIdValue } },
    { request: "GET_FILE", request_id: `file-${Date.now()}-legacy2`, user: CLICKSIGN_USER, password: CLICKSIGN_API_KEY, file: { file_id: fileIdValue } }
  ];

  for (const body of bodyVariants) {
    try {
      const response = await binaryRequest({
        method: "POST",
        url: buildClickSignUrl("get_file"),
        headers: buildClickSignAuthHeaders(),
        body
      });
      if (isPdfBuffer(response?.buffer)) {
        return response.buffer;
      }
      const data = parseJsonSafe(response?.buffer?.toString("utf8") || "");
      const rawBase64 = pickStringByPaths(data, [
        "file.content",
        "file.file_content",
        "content",
        "data.file.content",
        "data.content"
      ]);
      const buffer = parseBase64Buffer(rawBase64);
      if (buffer && buffer.length > 0) return buffer;
    } catch (err) {
      // continúa con variante alterna.
    }
  }

  return null;
}

async function resolveClickSignArtifacts({ event, requestId, contractId, publicId, signatureId }) {
  const catalog = await fetchClickSignFilesCatalog({ event, requestId, contractId, signatureId });
  const byType = new Map();
  for (const entry of catalog.entries) {
    if (!byType.has(entry.fileType)) byType.set(entry.fileType, []);
    byType.get(entry.fileType).push(entry);
  }

  const hasCatalogEntries = Array.isArray(catalog.entries) && catalog.entries.length > 0;
  let signedPdf = null;
  let signedFileId = "";
  const signedEntry =
    byType.get("signed_contract")?.[0] ||
    byType.get("signed")?.[0] ||
    byType.get("contract_signed")?.[0] ||
    byType.get("signed_once")?.[0] ||
    byType.get("signature_stamp")?.[0] ||
    byType.get("signatory_stamp")?.[0] ||
    null;

  if (signedEntry) {
    signedFileId = String(signedEntry.fileId || "").trim();
    const buffer = await fetchClickSignFileBuffer(signedEntry.fileId);
    if (isPdfBuffer(buffer)) {
      signedPdf = {
        buffer,
        fileName: sanitizePdfFileName(signedEntry.fileName || `CuentaCobroFirmada_${publicId || "documento"}.pdf`, "CuentaCobroFirmada.pdf"),
        source: "get_file_signed_contract"
      };
    }
  }

  // Solo usa fallback legacy cuando no hay catálogo, para evitar confundir START_FILES/show_landing con firmado.
  if (!signedPdf && !hasCatalogEntries) {
    signedPdf = await resolveSignedPdfFromClickSign({ event, requestId, contractId, publicId, signatureId });
  }

  const extraFiles = [];
  const uploadedEntry =
    byType.get("uploaded")?.[0] ||
    byType.get("uploaded_files")?.[0] ||
    null;
  if (uploadedEntry && String(uploadedEntry.fileId || "").trim() !== signedFileId) {
    const uploadedBuffer = await fetchClickSignFileBuffer(uploadedEntry.fileId);
    if (isPdfBuffer(uploadedBuffer)) {
      extraFiles.push({
        kind: "seguridad_social_firma",
        fileName: sanitizePdfFileName(uploadedEntry.fileName || `SeguridadSocial_${publicId || "cuenta"}.pdf`, "SeguridadSocial.pdf"),
        buffer: uploadedBuffer
      });
    }
  }
  const evidenceEntry =
    byType.get("evidence")?.[0] ||
    byType.get("signatory_evidence")?.[0] ||
    byType.get("signature_evidence")?.[0] ||
    null;
  if (evidenceEntry && String(evidenceEntry.fileId || "").trim() !== signedFileId) {
    const evidenceBuffer = await fetchClickSignFileBuffer(evidenceEntry.fileId);
    if (isPdfBuffer(evidenceBuffer)) {
      extraFiles.push({
        kind: "evidencia_firma",
        fileName: sanitizePdfFileName(evidenceEntry.fileName || `EvidenciaFirma_${publicId || "cuenta"}.pdf`, "EvidenciaFirma.pdf"),
        buffer: evidenceBuffer
      });
    }
  }
  const attachmentEntry =
    byType.get("contract_files")?.[0] ||
    byType.get("attachment_files")?.[0] ||
    byType.get("attachments")?.[0] ||
    byType.get("attachment")?.[0] ||
    null;
  if (attachmentEntry && String(attachmentEntry.fileId || "").trim() !== signedFileId) {
    const attachmentBuffer = await fetchClickSignFileBuffer(attachmentEntry.fileId);
    if (isPdfBuffer(attachmentBuffer)) {
      extraFiles.push({
        kind: "anexo_firma",
        fileName: sanitizePdfFileName(attachmentEntry.fileName || `AnexoFirma_${publicId || "cuenta"}.pdf`, "AnexoFirma.pdf"),
        buffer: attachmentBuffer
      });
    }
  }

  return {
    signedPdf,
    extraFiles,
    catalogSource: catalog.source || null
  };
}

async function uploadClickSignExtraFilesToOneDrive(cuenta, extraFiles = [], targetPathHint = "") {
  if (!ONEDRIVE_ENABLED || !Array.isArray(extraFiles) || extraFiles.length === 0) return { uploaded: [], carpeta: targetPathHint || "" };

  const token = await getGraphAccessToken();
  const encodedUser = encodeURIComponent(ONEDRIVE_TARGET_USER);
  await graphGet(`/v1.0/users/${encodedUser}/drive`, token);

  let targetPath = String(targetPathHint || "").trim();
  if (!targetPath) {
    const { consultorFolder, cuentaFolderName } = buildCuentaCobroFolderContext(cuenta);
    targetPath = sanitizePathSegment(ONEDRIVE_ROOT_FOLDER, "AdjuntosCuentasCobro");
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, "", targetPath);
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, consultorFolder);
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, cuentaFolderName);
  }

  const uploaded = [];
  for (const file of extraFiles) {
    if (!file?.buffer || !isPdfBuffer(file.buffer)) continue;
    const safeName = sanitizePdfFileName(file.fileName || `${file.kind || "archivo"}.pdf`, `${file.kind || "archivo"}.pdf`);
    const uploadPath = `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(`${targetPath}/${safeName}`)}:/content`;
    const result = await graphPutBinary(uploadPath, token, file.buffer, "application/pdf");
    uploaded.push({
      kind: file.kind,
      id: result.id || "",
      nombre: result.name || safeName,
      url: result.webUrl || ""
    });
  }

  return { uploaded, carpeta: targetPath };
}

function getClickSignLandingUrl(responseBody) {
  const directPaths = [
    "sign_url",
    "url_firma",
    "landing_url",
    "signature_url",
    "url",
    "signature.url",
    "signature.signatories.0.url",
    "signature.signatories.0.sign_url",
    "signature.signatories.0.landing_url",
    "signatories.0.url",
    "signatories.0.landing_url",
    "signatories.0.sign_url",
    "data.landing_url",
    "data.signature.signatories.0.url",
    "data.signatories.0.landing_url"
  ];
  return pickStringByPaths(responseBody, directPaths);
}

function isClickSignConfigured() {
  return Boolean(CLICKSIGN_API_KEY && CLICKSIGN_USER && CLICKSIGN_CONFIG_ID > 0);
}

async function getCuentaCobroEstadoEnFirma() {
  if (estadoCuentaCobroEnFirmaCache) return estadoCuentaCobroEnFirmaCache;
  try {
    const result = await pool.query(
      `
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = 'tipo_estado_reporte'
      ORDER BY e.enumsortorder
      `
    );
    const labels = (result.rows || []).map((row) => String(row.enumlabel || "").trim()).filter(Boolean);
    const byNorm = new Map(
      labels.map((label) => [
        normalizeEnumLabel(label),
        label
      ])
    );
    estadoCuentaCobroEnFirmaCache =
      byNorm.get("enfirma") ||
      byNorm.get("en_firma") ||
      byNorm.get("revision") ||
      byNorm.get("revisión") ||
      labels[0] ||
      "Pendiente";
    return estadoCuentaCobroEnFirmaCache;
  } catch (err) {
    estadoCuentaCobroEnFirmaCache = "Pendiente";
    return estadoCuentaCobroEnFirmaCache;
  }
}

async function getCuentaCobroEstadoAprobado() {
  if (estadoCuentaCobroAprobadoCache) return estadoCuentaCobroAprobadoCache;
  try {
    const result = await pool.query(
      `
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = 'tipo_estado_reporte'
      ORDER BY e.enumsortorder
      `
    );
    const labels = (result.rows || []).map((row) => String(row.enumlabel || "").trim()).filter(Boolean);
    const byNorm = new Map(labels.map((label) => [normalizeEnumLabel(label), label]));
    estadoCuentaCobroAprobadoCache =
      byNorm.get("aprobado") ||
      byNorm.get("aprobada") ||
      byNorm.get("finalizado") ||
      byNorm.get("cerrado") ||
      byNorm.get("pagado") ||
      byNorm.get("enfirma") ||
      byNorm.get("en_firma") ||
      labels[0] ||
      "Pendiente";
    return estadoCuentaCobroAprobadoCache;
  } catch (err) {
    estadoCuentaCobroAprobadoCache = "Pendiente";
    return estadoCuentaCobroAprobadoCache;
  }
}

function normalizeClickSignStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (["signed", "completed", "done", "success", "firmado", "aprobado", "stamp_generated", "evidence_generated"].includes(raw)) return "signed";
  if (["rejected", "declined", "failed", "error", "cancelled", "canceled", "rechazado", "cancelado"].includes(raw)) return "rejected";
  if (["pending", "in_progress", "inprogress", "started", "sent", "created", "open", "en_firma", "start_signature", "start"].includes(raw)) return "pending";
  return raw;
}

async function fetchClickSignSignatureSnapshot({ requestId = "", contractId = "", signatureId = "" } = {}) {
  const lookupRequests = buildClickSignLookupRequests({ requestId, contractId, signatureId });
  const statusPaths = [
    "signature.status",
    "signature.signature_status",
    "signature_status",
    "status",
    "data.signature.status",
    "data.signature.signature_status",
    "data.signature_status",
    "data.status",
    "signature.signatories.0.status",
    "data.signatories.0.status"
  ];

  let pendingCandidate = null;
  let lastEvent = null;

  for (const lookup of lookupRequests) {
    try {
      const response = await jsonRequest({
        method: lookup.method,
        url: buildClickSignUrl(lookup.path),
        headers: buildClickSignAuthHeaders(),
        body: lookup.body || null
      });
      const event = response?.data && typeof response.data === "object" ? response.data : {};
      lastEvent = event;

      const signedCandidate = extractSignedPdfCandidate(event);
      if (signedCandidate?.url || signedCandidate?.base64) {
        return {
          event,
          rawStatus: "signed",
          status: "signed",
          source: `lookup:${lookup.path}`
        };
      }

      const rawStatus = pickStringByPaths(event, statusPaths);
      const status = normalizeClickSignStatus(rawStatus);
      const resolvedSignatureId = String(extractClickSignSignatureId(event) || "").trim();
      if (resolvedSignatureId && !pendingCandidate) {
        pendingCandidate = {
          event,
          rawStatus: rawStatus || "pending",
          status: status || "pending",
          source: `lookup:${lookup.path}`
        };
      }

      if (status === "signed" || status === "rejected") {
        return {
          event,
          rawStatus,
          status,
          source: `lookup:${lookup.path}`
        };
      }

      if (!pendingCandidate && status === "pending") {
        pendingCandidate = {
          event,
          rawStatus,
          status,
          source: `lookup:${lookup.path}`
        };
      }
    } catch (err) {
      // Algunos endpoints no existen según plan contratado; se ignoran.
    }
  }

  if (pendingCandidate) return pendingCandidate;
  return {
    event: lastEvent || {},
    rawStatus: "",
    status: "",
    source: ""
  };
}

function extractPublicIdFromContract(contractId) {
  const match = String(contractId || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match ? match[0] : "";
}

async function assertCuentaCobroOwnerAccess(cuentaInternalId, req) {
  const role = normalizeValue(req.user?.rol);
  if (["administrador", "coordinador"].includes(role)) return;
  const owner = await pool.query("SELECT created_by FROM cuenta_cobro WHERE id = $1", [cuentaInternalId]);
  const createdBy = owner.rows[0]?.created_by;
  if (!createdBy || String(createdBy) !== String(req.user?.id)) {
    const err = new Error("Acceso denegado");
    err.code = "ACCESS_DENIED";
    throw err;
  }
}

async function getCuentaCobroPdfContext(cuentaInternalId) {
  const cuentaRes = await pool.query(
    `
    SELECT
      cc.*,
      u.nombre_usuario,
      u.email,
      u.cedula,
      u.direccion,
      u.telefono,
      u.ciudad,
      u.nro_cuenta_bancaria,
      u.moneda_cobro,
      b.titulo AS banco,
      tcb.titulo AS tipo_cuenta,
      di.titulo AS tipo_documento
    FROM cuenta_cobro cc
      JOIN usuarios u ON cc.created_by = u.id
      LEFT JOIN bancos b ON u.banco_id = b.id
      LEFT JOIN tipo_cuenta_bancaria tcb ON u.tipo_cuenta_id = tcb.id
      LEFT JOIN documento_identidad di ON u.tipo_documento_id = di.id
    WHERE cc.id = $1
    `,
    [cuentaInternalId]
  );
  const cuenta = cuentaRes.rows[0] || null;
  if (!cuenta) return { cuenta: null, detalles: [] };

  const detallesRes = await pool.query(
    `
    SELECT
      rh.id,
      rh.public_id,
      c.titulo AS cliente,
      m.titulo AS modulo,
      ta.titulo AS tipo_asignacion,
      u.nombre_usuario AS consultor_responsable,
      rh.nro_caso_int_ext,
      rh.horas_reportadas,
      rh.cantidad_dias_reportados,
      rh.total_cobrar
    FROM reporte_horas rh
      LEFT JOIN clientes c ON rh.cliente_id = c.id
      LEFT JOIN modulo m ON rh.modulo_id = m.id
      LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
      LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
    WHERE rh.id_cuenta_cobro = $1
    ORDER BY rh.id DESC
    `,
    [cuentaInternalId]
  );

  return {
    cuenta,
    detalles: detallesRes.rows || []
  };
}

function formatCuentaCobroCurrency(value) {
  return new Intl.NumberFormat("es-CO", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatCuentaCobroDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const months = [
    "Enero",
    "Febrero",
    "Marzo",
    "Abril",
    "Mayo",
    "Junio",
    "Julio",
    "Agosto",
    "Septiembre",
    "Octubre",
    "Noviembre",
    "Diciembre"
  ];
  return `${date.getDate()} de ${months[date.getMonth()]} de ${date.getFullYear()}`;
}

/*function writeCuentaCobroPdf(doc, cuenta, detalles) {
  const totalNumeros = Number(cuenta.total_cuenta_cobro || 0);
  const totalLetras = cuenta.total_letras || buildTotalLetras(totalNumeros, cuenta.moneda_cobro || "COP");

  doc.fontSize(12).text(`Cuenta de Cobro N° ${cuenta.public_id || cuenta.id}`, { align: "right" });
  doc.moveDown(1);
  doc.fontSize(11).text(`${formatCuentaCobroDate(cuenta.created_at)}, ${cuenta.ciudad_cobro || ""}`);
  doc.moveDown(1.5);

  doc.fontSize(12).font("Helvetica-Bold").text("SILVER CONSULTING S.A.S.", { align: "center" });
  doc.text("NIT 901.149.190-0", { align: "center" });
  doc.moveDown(1.5);

  doc.font("Helvetica-Bold").text("DEBE A:", { align: "center" });
  doc.font("Helvetica").text(cuenta.nombre_usuario || "", { align: "center" });
  doc.text(`${cuenta.tipo_documento || "Documento"}: ${cuenta.cedula || ""}`, { align: "center" });
  doc.moveDown(1);

  doc.font("Helvetica-Bold").text("LA SUMA DE:", { align: "center" });
  doc.font("Helvetica-Bold").text(`${formatCuentaCobroCurrency(totalNumeros)} (${totalLetras})`, { align: "center" });
  doc.moveDown(1.5);

  doc.font("Helvetica-Bold").text("Por concepto de:", { continued: true });
  doc.font("Helvetica").text(
    ` Honorarios de Consultorias: ${cuenta.descripcion || "Cuenta de cobro"} del ${cuenta.fecha_periodo_inicio || ""} al ${cuenta.fecha_periodo_fin || ""}`
  );
  doc.moveDown(1);

  doc.font("Helvetica").text(`Direccion: ${cuenta.direccion || "-"}`);
  doc.text(`Telefono: ${cuenta.telefono || "-"}`);
  doc.text(`No de Cuenta Bancaria: ${cuenta.nro_cuenta_bancaria || "-"}`);
  doc.text(`Banco: ${cuenta.banco || "-"}`);
  doc.text(`Tipo de Cuenta: ${cuenta.tipo_cuenta || "-"}`);
  doc.text(`Titular: ${cuenta.nombre_usuario || "-"}`);
  doc.text(`${cuenta.tipo_documento || "Documento"}: ${cuenta.cedula || "-"}`);
  doc.moveDown(1.5);

  doc.font("Helvetica-Bold").text("Detalle de Cuenta de Cobro");
  doc.moveDown(0.5);

  const tableStartY = doc.y;
  const colX = { cliente: 40, consultor: 170, tipo: 300, caso: 400, cant: 470, total: 520 };
  doc.fontSize(9).font("Helvetica-Bold");
  doc.text("Cliente", colX.cliente, tableStartY);
  doc.text("Consultor", colX.consultor, tableStartY);
  doc.text("Tipo", colX.tipo, tableStartY);
  doc.text("Caso", colX.caso, tableStartY);
  doc.text("Cant.", colX.cant, tableStartY, { width: 40, align: "right" });
  doc.text("Total", colX.total, tableStartY, { width: 60, align: "right" });
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(9);

  let y = doc.y + 2;
  for (const detalle of detalles || []) {
    doc.text(detalle.cliente || "-", colX.cliente, y, { width: 120 });
    doc.text(detalle.consultor_responsable || "-", colX.consultor, y, { width: 120 });
    doc.text(detalle.tipo_asignacion || "-", colX.tipo, y, { width: 90 });
    doc.text(detalle.nro_caso_int_ext || "-", colX.caso, y, { width: 60 });
    const cantidad = Number(detalle.cantidad_dias_reportados || 0) > 0
      ? `${detalle.cantidad_dias_reportados} D`
      : `${Number(detalle.horas_reportadas || 0)} H`;
    doc.text(cantidad, colX.cant, y, { width: 40, align: "right" });
    doc.text(formatCuentaCobroCurrency(detalle.total_cobrar), colX.total, y, { width: 60, align: "right" });
    y += 14;
    if (y > doc.page.height - 60) {
      doc.addPage();
      y = 50;
    }
  }
}*/

// ============================================================
//  writeCuentaCobroPdf  —  versión corregida
//  Fix: header sin solapamiento, fechas formateadas, espaciado
// ============================================================

const COLOR = {
  azulOscuro: "#20272F",
  turquesa: "#189FA9",
  azulMedio: "#1C61AB",
  grisClaro: "#F4F6F9",
  grisLinea: "#D5DCE8",
  blanco: "#FFFFFF",
  textoPrin: "#20272F",
  textoSec: "#4A5568",
  naranjaSilver: "#FF6000",
};

const MARGIN = { top: 40, left: 40, right: 40, bottom: 50 };

function pageWidth(doc) {
  return doc.page.width - MARGIN.left - MARGIN.right;
}

function fillRect(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).fill(color).restore();
}

function hLine(doc, x, y, w, color = COLOR.grisLinea, lineWidth = 0.5) {
  doc.save()
    .strokeColor(color)
    .lineWidth(lineWidth)
    .moveTo(x, y).lineTo(x + w, y)
    .stroke()
    .restore();
}

// Formatea fecha sin mostrar UTC — acepta string ISO o Date
function fmtFecha(value) {
  if (value === undefined || value === null || value === "") return "-";

  let year = 0;
  let month = 0;
  let day = 0;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const iso = value.toISOString().slice(0, 10);
    [year, month, day] = iso.split("-").map(Number);
  } else {
    const raw = String(value).trim();
    const fromIso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (fromIso) {
      year = Number(fromIso[1]);
      month = Number(fromIso[2]);
      day = Number(fromIso[3]);
    } else {
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) return raw;
      const iso = parsed.toISOString().slice(0, 10);
      [year, month, day] = iso.split("-").map(Number);
    }
  }

  if (!year || !month || !day) return String(value);
  const meses = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
  ];
  return `${day} de ${meses[month - 1]} de ${year}`;
}

function infoRow(doc, x, y, label, value, labelWidth = 90) {
  const w = pageWidth(doc) / 2 - labelWidth - 10;
  doc.fontSize(8.5).font("Helvetica-Bold").fillColor(COLOR.textoPrin)
    .text(label, x, y, { width: labelWidth, lineBreak: false });
  doc.font("Helvetica").fillColor(COLOR.textoSec)
    .text(String(value || "-"), x + labelWidth, y, { width: w, lineBreak: false });
}

function sectionTitle(doc, title, y) {
  const ML = MARGIN.left;
  fillRect(doc, ML, y, 3, 13, COLOR.turquesa);
  doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR.azulOscuro)
    .text(title, ML + 10, y + 1, { lineBreak: false });
  return y + 20;
}

// ── Función principal ─────────────────────────────────────────
function writeCuentaCobroPdf(doc, cuenta, detalles) {
  const PW = pageWidth(doc);
  const ML = MARGIN.left;
  const PW_TOTAL = doc.page.width; // ancho real de página

  const totalNumeros = Number(cuenta.total_cuenta_cobro || 0);
  const totalLetras = buildTotalLetras(totalNumeros, cuenta.moneda_cobro || "COP");
  const monedaSimbolo = String(cuenta.moneda_cobro || "COP").toUpperCase() === "USD" ? "USD" : "COP";
  const nombreConsultor = cuenta.nombre_usuario || "Consultor";
  const cedulaConsultor = cuenta.cedula || "-";

  // ══════════════════════════════════════════════
  // 1. HEADER — dos bloques separados sin solaparse
  // ══════════════════════════════════════════════
  const headerH = 80;
  fillRect(doc, 0, 0, PW_TOTAL, headerH, COLOR.azulMedio);

  // — Bloque izquierdo: empresa
  doc.fontSize(15).font("Helvetica-Bold").fillColor(COLOR.blanco)
    .text("SILVER CONSULTING S.A.S.", ML, 16, { width: PW / 2, lineBreak: false });

  doc.fontSize(8).font("Helvetica").fillColor(COLOR.blanco)
    .text("NIT 901.149.190-0", ML, 34, { width: PW / 2, lineBreak: false });

  // — Bloque derecho: tipo doc + número + fecha
  const rightX = ML + PW / 2;
  const rightW = PW / 2;

  doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR.blanco)
    .text("CUENTA DE COBRO", rightX, 16, { width: rightW, align: "right", lineBreak: false });

  const numCuenta = String(cuenta.public_id || cuenta.id || "").substring(0, 18);
  doc.fontSize(8).font("Helvetica").fillColor(COLOR.blanco)
    .text(`N° ${numCuenta}`, rightX, 30, { width: rightW, align: "right", lineBreak: false });

  const fechaDoc = fmtFecha(cuenta.created_at);
  const ciudadDoc = cuenta.ciudad_cobro || "";
  doc.fontSize(8).fillColor(COLOR.blanco)
    .text(`${fechaDoc}  ·  ${ciudadDoc}`, rightX, 44, { width: rightW, align: "right", lineBreak: false });

  // Banda turquesa inferior del header
  fillRect(doc, 0, headerH, PW_TOTAL, 4, COLOR.naranjaSilver);

  let curY = headerH + 18;

  // ══════════════════════════════════════════════
  // 2. DEBE A — tarjeta con 2 columnas
  // ══════════════════════════════════════════════
  curY = sectionTitle(doc, "DEBE A", curY);

  const cardPad = 12;
  const cardH = 72;
  doc.save()
    .roundedRect(ML, curY, PW, cardH, 5)
    .strokeColor(COLOR.grisLinea).lineWidth(0.8).stroke()
    .restore();

  const c1x = ML + cardPad;
  const c2x = ML + PW / 2 + cardPad;
  const rh = 15;
  let ry = curY + 10;

  infoRow(doc, c1x, ry, "Nombre:", cuenta.nombre_usuario || "-");
  infoRow(doc, c2x, ry, "Teléfono:", cuenta.telefono || "-");
  ry += rh;

  infoRow(doc, c1x, ry, "Documento:",
    `${cuenta.tipo_documento || "CC"}: ${cuenta.cedula || "-"}`);
  infoRow(doc, c2x, ry, "Dirección:", cuenta.direccion || "-");
  ry += rh;

  infoRow(doc, c1x, ry, "Banco:", cuenta.banco || "-");
  infoRow(doc, c2x, ry, "No. Cuenta:", cuenta.nro_cuenta_bancaria || "-");
  ry += rh;

  infoRow(doc, c1x, ry, "Tipo cuenta:", cuenta.tipo_cuenta || "-");

  curY += cardH + 14;

  // ══════════════════════════════════════════════
  // 3. VALOR A COBRAR
  // ══════════════════════════════════════════════
  curY = sectionTitle(doc, "VALOR A COBRAR", curY);

  const totalBoxH = 52;
  fillRect(doc, ML, curY, PW, totalBoxH, "#EAF7F8");
  doc.save()
    .roundedRect(ML, curY, PW, totalBoxH, 5)
    .strokeColor(COLOR.turquesa).lineWidth(1).stroke()
    .restore();

  doc.fontSize(20).font("Helvetica-Bold").fillColor(COLOR.azulMedio)
    .text(
      `${monedaSimbolo}  ${formatCuentaCobroCurrency(totalNumeros)}`,
      ML + 14, curY + 8, { lineBreak: false }
    );

  // Limpiar "PESOS PESOS" duplicado si viene así
  const letrasLimpias = totalLetras.replace(/\bPESOS\s+PESOS\b/gi, "PESOS");
  doc.fontSize(8.5).font("Helvetica").fillColor(COLOR.textoSec)
    .text(`Valor en letras: ${letrasLimpias}`, ML + 14, curY + 34, { width: PW - 28, lineBreak: false });

  curY += totalBoxH + 14;

  // ══════════════════════════════════════════════
  // 4. CONCEPTO
  // ══════════════════════════════════════════════
  curY = sectionTitle(doc, "CONCEPTO", curY);

  const periodoInicio = fmtFecha(cuenta.fecha_periodo_inicio);
  const periodoFin = fmtFecha(cuenta.fecha_periodo_fin);

  doc.fontSize(8.5).font("Helvetica").fillColor(COLOR.textoSec)
    .text(
      `Honorarios de Consultoría — ${cuenta.descripcion || "Cuenta de cobro"}\n` +
      `Período: ${periodoInicio}  al  ${periodoFin}`,
      ML, curY, { width: PW, lineBreak: true }
    );

  // Texto legal mezclado dentro de concepto
  curY = doc.y + 8;
  doc.fontSize(7.5).font("Helvetica").fillColor(COLOR.textoSec)
    .text(
      "Manifiesto bajo la gravedad de juramento que en mi depuración del impuesto sobre la renta no usaré costos y sí la renta exenta del 25% contenida en el numeral 10 del artículo 206 del ET.",
      ML,
      curY,
      { width: PW, align: "justify" }
    );

  curY = doc.y + 12;

  // ══════════════════════════════════════════════
  // 5. TABLA DE DETALLES
  // ══════════════════════════════════════════════
  curY = sectionTitle(doc, "DETALLE DE SERVICIOS", curY);

  const cols = [
    { label: "Cliente", key: "cliente", w: 115 },
    { label: "Consultor", key: "consultor_responsable", w: 110 },
    { label: "Tipo", key: "tipo_asignacion", w: 85 },
    { label: "Caso / Req.", key: "nro_caso_int_ext", w: 70 },
    { label: "Cant.", key: "_cant", w: 38, align: "right" },
    { label: "Total", key: "_total", w: 62, align: "right" },
  ];

  // Ajustar anchos para que sumen exactamente PW
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  const diff = PW - totalW;
  cols[0].w += diff; // absorber diferencia en la primera columna

  // Calcular X de cada columna
  let cx = ML;
  cols.forEach(c => { c.x = cx; cx += c.w; });

  const ROW_H = 16;
  const HEADER_H = 18;

  function drawTableHeader(y) {
    fillRect(doc, ML, y, PW, HEADER_H, COLOR.azulOscuro);
    cols.forEach(c => {
      doc.fontSize(8).font("Helvetica-Bold").fillColor(COLOR.blanco)
        .text(c.label, c.x + 4, y + 5, { width: c.w - 8, align: c.align || "left", lineBreak: false });
    });
    return y + HEADER_H;
  }

  curY = drawTableHeader(curY);

  (detalles || []).forEach((d, i) => {
    if (curY + ROW_H > doc.page.height - MARGIN.bottom) {
      doc.addPage();
      curY = MARGIN.top;
      curY = drawTableHeader(curY);
    }

    if (i % 2 === 0) fillRect(doc, ML, curY, PW, ROW_H, COLOR.grisClaro);
    hLine(doc, ML, curY + ROW_H, PW);

    const cant = Number(d.cantidad_dias_reportados || 0) > 0
      ? `${d.cantidad_dias_reportados} D`
      : `${Number(d.horas_reportadas || 0)} H`;

    const vals = {
      cliente: d.cliente || "-",
      consultor_responsable: d.consultor_responsable || "-",
      tipo_asignacion: d.tipo_asignacion || "-",
      nro_caso_int_ext: d.nro_caso_int_ext || "-",
      _cant: cant,
      _total: formatCuentaCobroCurrency(d.total_cobrar),
    };

    cols.forEach(c => {
      doc.fontSize(8).font("Helvetica").fillColor(COLOR.textoPrin)
        .text(vals[c.key], c.x + 4, curY + 4,
          { width: c.w - 8, align: c.align || "left", lineBreak: false, ellipsis: true });
    });

    curY += ROW_H;
  });

  // Borde inferior tabla
  hLine(doc, ML, curY, PW, COLOR.azulOscuro, 1);

  //Fila TOTAL
  curY += 1;
  const totalRowH = 18;
  fillRect(doc, ML, curY, PW, totalRowH, "#E8ECF4");

  // Etiqueta "TOTAL" — ocupa todo el ancho menos la última columna
  doc.fontSize(8.5).font("Helvetica-Bold").fillColor(COLOR.azulOscuro)
    .text("TOTAL", ML + 4, curY + 5,
      { width: cols[cols.length - 1].x - ML - 8, align: "right", lineBreak: false });

  // Valor — moneda + número como un solo string en la última columna
  const totalStr = `${monedaSimbolo} ${formatCuentaCobroCurrency(totalNumeros)}`;
  const lastCol = cols[cols.length - 1];

  // Reducir fuente si el string no cabe
  let fs = 10;
  doc.font("Helvetica-Bold");
  while (fs > 6.5 && doc.fontSize(fs).widthOfString(totalStr) > lastCol.w - 8) {
    fs -= 0.3;
  }

  doc.fontSize(fs).font("Helvetica-Bold").fillColor(COLOR.azulMedio)
    .text(totalStr, lastCol.x + 4, curY + 5,
      { width: lastCol.w - 8, align: "right", lineBreak: false });

  curY += totalRowH + 12;

  // ══════════════════════════════════════════════
  // 6. PIE + FIRMA
  // ══════════════════════════════════════════════
  if (curY > doc.page.height - 120) {
    doc.addPage();
    curY = MARGIN.top;
  }

  hLine(doc, ML, curY, PW);
  curY += 10;

  doc.fontSize(7.5).font("Helvetica").fillColor(COLOR.textoSec)
    .text(
      "Documento generado electrónicamente — Silver Consulting S.A.S.  ·  NIT 901.149.190-0  ·  Medellín, Colombia",
      ML, curY, { width: PW, align: "center", lineBreak: false }
    );

  curY = doc.y + 16;
  doc.fontSize(8).font("Helvetica").fillColor(COLOR.textoSec)
    .text("Cordialmente,", ML, curY);

  curY = doc.y + 6;
  doc.fontSize(8).font("Helvetica-Bold").fillColor(COLOR.textoPrin)
    .text(nombreConsultor, ML, curY);

  curY = doc.y + 2;
  doc.fontSize(8).font("Helvetica").fillColor(COLOR.textoSec)
    .text(`C.C. ${cedulaConsultor}`, ML, curY);
}

//--------------------------------------------------------------//
function generateCuentaCobroPdfBuffer(cuenta, detalles) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 40 });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    writeCuentaCobroPdf(doc, cuenta, detalles);
    doc.end();
  });
}

const hasAccess = (req, { roles = [], tipos = [] }) => {
  const userRole = normalizeValue(req.user?.rol);
  const userTipo = normalizeValue(req.user?.tipo_consultor);
  const allowedRoles = roles.map(normalizeValue);
  const allowedTipos = tipos.map(normalizeValue);
  return (
    (allowedRoles.length > 0 && allowedRoles.includes(userRole)) ||
    (allowedTipos.length > 0 && allowedTipos.includes(userTipo))
  );
};

const isAsociadoUser = (req) => normalizeValue(req?.user?.tipo_consultor) === "asociado";

const requireAccess = ({ roles = [], tipos = [] } = {}) => (req, res, next) => {
  if (!roles.length && !tipos.length) return next();
  if (!req.user) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "No autorizado" });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Token inválido" });
    }
  }
  if (!hasAccess(req, { roles, tipos })) {
    return res.status(403).json({ error: "Acceso denegado" });
  }
  return next();
};

const requireAuthenticated = (req, res, next) => {
  if (req.user?.id) return next();
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No autorizado" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido" });
  }
};

/* ===============================
   SERVIR ARCHIVOS DEL FRONTEND
=============================== */
// Ajusta esta ruta si tu carpeta 'front' está¡ en otro nivel relativo
// Frontend se sirve por separado (no está¡ en este contenedor)

/* ===============================
   RUTAS DE VISTAS (SPA)
=============================== */
// (sin rutas de vistas aquí)

/* ===============================
   API - CLIENTES (AQUÍ ESTABA EL FALTANTE)
=============================== */

// 1. OBTENER TODOS
app.get("/clientes", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        public_id AS id,
        titulo,
        nit,
        prefijo,
        correlativo,
        activo,
        created_at,
        updated_at
      FROM clientes
      WHERE activo = true
      ORDER BY id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener clientes" });
  }
});

// 2. CREAR CLIENTE
app.post("/clientes", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { titulo, nit, prefijo } = req.body;

  try {
    // Validar duplicados
    const check = await pool.query("SELECT id FROM clientes WHERE (nit = $1 OR titulo = $2) AND activo = true", [nit, titulo]);
    if (check.rows.length > 0) {
      return res.status(400).json({ error: "El cliente o NIT ya existe en la base de datos" });
    }

    // Calcular siguiente correlativo (MAX + 1)
    const corrRes = await pool.query("SELECT COALESCE(MAX(correlativo), 0) + 1 as next_val FROM clientes");
    const nuevoCorrelativo = corrRes.rows[0].next_val;

    const result = await pool.query(
      `INSERT INTO clientes (titulo, nit, prefijo, correlativo, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING
         public_id AS id,
         titulo,
         nit,
         prefijo,
         correlativo,
         activo,
         created_at,
         updated_at`,
      [titulo, nit, prefijo || '', nuevoCorrelativo]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar en BD" });
  }
});

// 3. EDITAR CLIENTE
app.put("/clientes/:id", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { id } = req.params;
  const { titulo, nit, prefijo } = req.body;

  try {
    const clienteId = await resolveInternalId(pool, ID_TABLES.clientes, id, { required: true });
    const result = await pool.query(
      `UPDATE clientes
       SET titulo = $1, nit = $2, prefijo = $3
       WHERE id = $4
       RETURNING
         public_id AS id,
         titulo,
         nit,
         prefijo,
         correlativo,
         activo,
         created_at,
         updated_at`,
      [titulo, nit, prefijo, clienteId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Cliente no encontrado" });
    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar" });
  }
});

// 4. ELIMINAR CLIENTE (Soft Delete)
app.delete("/clientes/:id", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { id } = req.params;

  try {
    const clienteId = await resolveInternalId(pool, ID_TABLES.clientes, id, { required: true });
    // Validar dependencias (Ejemplo: si tienes tabla consultorias)
    // const check = await pool.query("SELECT id FROM consultorias WHERE id_cliente = $1", [id]);
    // if (check.rows.length > 0) return res.status(400).json({ tiene_consultorias: true });

    await pool.query("UPDATE clientes SET activo = false WHERE id = $1", [clienteId]);
    res.json({ ok: true });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al eliminar" });
  }
});

/* ===============================
   API - CATÁLOGOS
=============================== */

// Consultores activos
app.get("/consultores", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.public_id AS id,
        u.nombre_usuario AS nombre,
        u.moneda_cobro AS moneda
      FROM usuarios u
      LEFT JOIN roles r ON u.rol_usuario_id = r.id
      WHERE u.activo = true
        AND (r.titulo IN ('Consultor', 'Consultor Principal') OR u.tipo_consultor IS NOT NULL)
      ORDER BY u.nombre_usuario ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener consultores" });
  }
});

// Consultores principales disponibles (no asociados)
app.get("/consultores/principales", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.public_id AS id,
        u.nombre_usuario,
        u.email
      FROM usuarios u
      LEFT JOIN roles r ON u.rol_usuario_id = r.id
      WHERE u.activo = true
        AND (r.titulo IN ('Consultor', 'Consultor Principal', 'Mesa de Servicio'))
        AND (u.tipo_consultor IS NULL OR LOWER(u.tipo_consultor::text) <> 'asociado')
      ORDER BY u.nombre_usuario ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener consultores principales" });
  }
});

// Consultores asociados por principal
app.get("/sub-consultores/:principalId", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { principalId } = req.params;
  try {
    if (!principalId) return res.json([]);
    const principalInternalId = await resolveInternalId(pool, ID_TABLES.usuarios, principalId, { required: true });
    const result = await pool.query(
      `
      SELECT
        u.public_id AS id,
        u.nombre_usuario,
        u.email
      FROM usuarios u
      WHERE u.activo = true
        AND u.id_consultor_principal = $1
        AND LOWER(u.tipo_consultor::text) = 'asociado'
      ORDER BY u.nombre_usuario ASC
      `,
      [principalInternalId]
    );
    res.json(result.rows);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.json([]);
    console.error(err);
    res.status(500).json({ error: "Error al obtener consultores asociados" });
  }
});

// Consultores disponibles para asociar
app.get("/sub-consultores/disponibles/:principalId", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { principalId } = req.params;
  try {
    if (!principalId) return res.json([]);
    const principalInternalId = await resolveInternalId(pool, ID_TABLES.usuarios, principalId, { required: true });
    const result = await pool.query(
      `
      SELECT
        u.public_id AS id,
        u.nombre_usuario,
        u.email
      FROM usuarios u
      LEFT JOIN roles r ON u.rol_usuario_id = r.id
      WHERE u.activo = true
        AND u.id <> $1
        AND u.id_consultor_principal IS NULL
        AND (r.titulo IN ('Consultor', 'Consultor Principal', 'Mesa de Servicio'))
        AND (u.tipo_consultor IS NULL OR LOWER(u.tipo_consultor::text) <> 'asociado')
      ORDER BY u.nombre_usuario ASC
      `,
      [principalInternalId]
    );
    res.json(result.rows);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.json([]);
    console.error(err);
    res.status(500).json({ error: "Error al obtener consultores disponibles" });
  }
});

// Asociar consultor a principal
app.post("/sub-consultores/asociar", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { principal_id, asociado_id } = req.body;
  try {
    if (!principal_id || !asociado_id) {
      return res.status(400).json({ error: "Faltan datos para asociar" });
    }
    const principalId = await resolveInternalId(pool, ID_TABLES.usuarios, principal_id, { required: true });
    const asociadoId = await resolveInternalId(pool, ID_TABLES.usuarios, asociado_id, { required: true });

    const principal = await pool.query(
      "SELECT id, tipo_consultor FROM usuarios WHERE id = $1 AND activo = true",
      [principalId]
    );
    if (principal.rows.length === 0) {
      return res.status(404).json({ error: "Consultor principal no encontrado" });
    }
    const principalTipo = normalizeValue(principal.rows[0].tipo_consultor);
    if (principalTipo === "asociado") {
      return res.status(400).json({ error: "Un consultor asociado no puede tener asociados" });
    }

    const asociado = await pool.query(
      "SELECT id, id_consultor_principal FROM usuarios WHERE id = $1 AND activo = true",
      [asociadoId]
    );
    if (asociado.rows.length === 0) {
      return res.status(404).json({ error: "Consultor asociado no encontrado" });
    }
    if (String(asociado.rows[0].id_consultor_principal || "") !== "") {
      return res.status(400).json({ error: "El consultor ya está¡ asociado a otro principal" });
    }

    await pool.query(
      `UPDATE usuarios
       SET id_consultor_principal = $1,
           tipo_consultor = 'Asociado',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [principalId, asociadoId]
    );

    res.json({ ok: true });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Consultor no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al asociar consultor" });
  }
});

// Desvincular consultor asociado
app.delete("/sub-consultores/:asociadoId", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { asociadoId } = req.params;
  const { principal_id } = req.body || {};
  try {
    if (!asociadoId || !principal_id) {
      return res.status(400).json({ error: "Faltan datos para desvincular" });
    }
    const asociadoInternalId = await resolveInternalId(pool, ID_TABLES.usuarios, asociadoId, { required: true });
    const principalInternalId = await resolveInternalId(pool, ID_TABLES.usuarios, principal_id, { required: true });

    const asociado = await pool.query(
      "SELECT id, id_consultor_principal FROM usuarios WHERE id = $1 AND activo = true",
      [asociadoInternalId]
    );
    if (asociado.rows.length === 0) {
      return res.status(404).json({ error: "Consultor asociado no encontrado" });
    }
    if (String(asociado.rows[0].id_consultor_principal || "") !== String(principalInternalId)) {
      return res.status(403).json({ error: "No autorizado para desvincular" });
    }

    await pool.query(
      `UPDATE usuarios
       SET id_consultor_principal = NULL,
           tipo_consultor = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [asociadoInternalId]
    );

    res.json({ ok: true });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Consultor no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al desvincular consultor" });
  }
});

// Módulos activos
app.get("/modulos", requireAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT public_id AS id, titulo
      FROM modulo
      WHERE activo = true
      ORDER BY titulo ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener módulos" });
  }
});

/* ===============================
   API - CATÁLOGOS ADMIN
=============================== */

// Módulos (admin)
app.get("/admin/modulos", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        public_id AS id,
        titulo,
        nombre_completo,
        descripcion,
        activo,
        created_at,
        updated_at
      FROM modulo
      ORDER BY titulo ASC
      `
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar módulos" });
  }
});

app.post("/admin/modulos", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const titulo = String(req.body?.titulo || "").trim();
  const nombreCompleto = String(req.body?.nombre_completo || "").trim() || null;
  const descripcion = String(req.body?.descripcion || "").trim() || null;
  const activo = req.body?.activo === undefined ? true : Boolean(req.body?.activo);
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });
    const dup = await pool.query(
      "SELECT id FROM modulo WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) LIMIT 1",
      [titulo]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe un módulo con ese título" });
    }
    const result = await pool.query(
      `
      INSERT INTO modulo (titulo, nombre_completo, descripcion, activo)
      VALUES ($1, $2, $3, $4)
      RETURNING public_id AS id, titulo, nombre_completo, descripcion, activo, created_at, updated_at
      `,
      [titulo, nombreCompleto, descripcion, activo]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear módulo" });
  }
});

app.put("/admin/modulos/:id", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { id } = req.params;
  const titulo = String(req.body?.titulo || "").trim();
  const nombreCompleto = String(req.body?.nombre_completo || "").trim() || null;
  const descripcion = String(req.body?.descripcion || "").trim() || null;
  const activo = req.body?.activo;
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });
    const moduloId = await resolveInternalId(pool, ID_TABLES.modulo, id, { required: true });
    const dup = await pool.query(
      "SELECT id FROM modulo WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) AND id <> $2 LIMIT 1",
      [titulo, moduloId]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe un módulo con ese título" });
    }
    const result = await pool.query(
      `
      UPDATE modulo
      SET titulo = $1,
          nombre_completo = $2,
          descripcion = $3,
          activo = COALESCE($4::boolean, activo),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING public_id AS id, titulo, nombre_completo, descripcion, activo, created_at, updated_at
      `,
      [titulo, nombreCompleto, descripcion, activo === undefined ? null : Boolean(activo), moduloId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Módulo no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar módulo" });
  }
});

app.delete("/admin/modulos/:id", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { id } = req.params;
  try {
    const moduloId = await resolveInternalId(pool, ID_TABLES.modulo, id, { required: true });
    const result = await pool.query(
      `
      UPDATE modulo
      SET activo = false,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING public_id AS id
      `,
      [moduloId]
    );
    res.json(result.rows[0] || { ok: true });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Módulo no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al eliminar módulo" });
  }
});

// Roles (admin)
app.get("/admin/roles", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        public_id AS id,
        titulo,
        descripcion,
        activo,
        created_at,
        updated_at
      FROM roles
      ORDER BY titulo ASC
      `
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar roles" });
  }
});

app.post("/admin/roles", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const titulo = String(req.body?.titulo || "").trim();
  const descripcion = String(req.body?.descripcion || "").trim() || null;
  const activo = req.body?.activo === undefined ? true : Boolean(req.body?.activo);
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });
    const dup = await pool.query(
      "SELECT id FROM roles WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) LIMIT 1",
      [titulo]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe un rol con ese título" });
    }
    const result = await pool.query(
      `
      INSERT INTO roles (titulo, descripcion, activo)
      VALUES ($1, $2, $3)
      RETURNING public_id AS id, titulo, descripcion, activo, created_at, updated_at
      `,
      [titulo, descripcion, activo]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear rol" });
  }
});

app.put("/admin/roles/:id", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { id } = req.params;
  const titulo = String(req.body?.titulo || "").trim();
  const descripcion = String(req.body?.descripcion || "").trim() || null;
  const activo = req.body?.activo;
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });
    const rolId = await resolveInternalId(pool, ID_TABLES.roles, id, { required: true });
    const dup = await pool.query(
      "SELECT id FROM roles WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) AND id <> $2 LIMIT 1",
      [titulo, rolId]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe un rol con ese título" });
    }
    const result = await pool.query(
      `
      UPDATE roles
      SET titulo = $1,
          descripcion = $2,
          activo = COALESCE($3::boolean, activo),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING public_id AS id, titulo, descripcion, activo, created_at, updated_at
      `,
      [titulo, descripcion, activo === undefined ? null : Boolean(activo), rolId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Rol no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar rol" });
  }
});

app.delete("/admin/roles/:id", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { id } = req.params;
  try {
    const rolId = await resolveInternalId(pool, ID_TABLES.roles, id, { required: true });
    const inUse = await pool.query(
      "SELECT id FROM usuarios WHERE rol_usuario_id = $1 LIMIT 1",
      [rolId]
    );
    if (inUse.rows.length > 0) {
      return res.status(400).json({ error: "No se puede eliminar: el rol está asignado a usuarios" });
    }
    const result = await pool.query(
      `
      UPDATE roles
      SET activo = false,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING public_id AS id
      `,
      [rolId]
    );
    res.json(result.rows[0] || { ok: true });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Rol no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al eliminar rol" });
  }
});

// Bancos (admin)
app.get("/admin/bancos", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        public_id AS id,
        titulo,
        codigo_bancolombia,
        codigo_conversor,
        activo,
        created_at,
        updated_at
      FROM bancos
      ORDER BY titulo ASC
      `
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar bancos" });
  }
});

app.post("/admin/bancos", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const titulo = String(req.body?.titulo || "").trim();
  const codigoBancolombia = String(req.body?.codigo_bancolombia || "").trim() || null;
  const codigoConversor = String(req.body?.codigo_conversor || "").trim() || null;
  const activo = req.body?.activo === undefined ? true : Boolean(req.body?.activo);
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });
    const dup = await pool.query(
      "SELECT id FROM bancos WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) LIMIT 1",
      [titulo]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe un banco con ese título" });
    }
    const result = await pool.query(
      `
      INSERT INTO bancos (titulo, codigo_bancolombia, codigo_conversor, activo)
      VALUES ($1, $2, $3, $4)
      RETURNING public_id AS id, titulo, codigo_bancolombia, codigo_conversor, activo, created_at, updated_at
      `,
      [titulo, codigoBancolombia, codigoConversor, activo]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear banco" });
  }
});

app.put("/admin/bancos/:id", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { id } = req.params;
  const titulo = String(req.body?.titulo || "").trim();
  const codigoBancolombia = String(req.body?.codigo_bancolombia || "").trim() || null;
  const codigoConversor = String(req.body?.codigo_conversor || "").trim() || null;
  const activo = req.body?.activo;
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });
    const bancoId = await resolveInternalId(pool, ID_TABLES.bancos, id, { required: true });
    const dup = await pool.query(
      "SELECT id FROM bancos WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) AND id <> $2 LIMIT 1",
      [titulo, bancoId]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe un banco con ese título" });
    }
    const result = await pool.query(
      `
      UPDATE bancos
      SET titulo = $1,
          codigo_bancolombia = $2,
          codigo_conversor = $3,
          activo = COALESCE($4::boolean, activo),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING public_id AS id, titulo, codigo_bancolombia, codigo_conversor, activo, created_at, updated_at
      `,
      [titulo, codigoBancolombia, codigoConversor, activo === undefined ? null : Boolean(activo), bancoId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Banco no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar banco" });
  }
});

app.delete("/admin/bancos/:id", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { id } = req.params;
  try {
    const bancoId = await resolveInternalId(pool, ID_TABLES.bancos, id, { required: true });
    const inUse = await pool.query(
      "SELECT id FROM usuarios WHERE banco_id = $1 LIMIT 1",
      [bancoId]
    );
    if (inUse.rows.length > 0) {
      return res.status(400).json({ error: "No se puede eliminar: el banco está asignado a usuarios" });
    }
    const result = await pool.query(
      `
      UPDATE bancos
      SET activo = false,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING public_id AS id
      `,
      [bancoId]
    );
    res.json(result.rows[0] || { ok: true });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Banco no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al eliminar banco" });
  }
});

// Roles por usuario (admin)
app.get("/admin/usuarios-roles", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        u.public_id AS id,
        u.nombre_usuario,
        u.email,
        u.activo,
        r.public_id AS rol_id,
        r.titulo AS rol
      FROM usuarios u
      LEFT JOIN roles r ON r.id = u.rol_usuario_id
      WHERE u.activo = true
      ORDER BY u.nombre_usuario ASC
      `
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar usuarios" });
  }
});

app.put("/admin/usuarios/:id/rol", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { id } = req.params;
  const { rol_id } = req.body || {};
  try {
    if (!rol_id) return res.status(400).json({ error: "Falta rol_id" });
    const userId = await resolveInternalId(pool, ID_TABLES.usuarios, id, { required: true });
    const rolId = await resolveInternalId(pool, ID_TABLES.roles, rol_id, { required: true });
    const result = await pool.query(
      `
      UPDATE usuarios
      SET rol_usuario_id = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING public_id AS id, nombre_usuario, email
      `,
      [rolId, userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Usuario o rol no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar rol de usuario" });
  }
});

// Tipos de asignación activos
app.get("/tipos-asignacion", requireAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT public_id AS id, titulo
      FROM tipo_asignacion
      WHERE activo = true
      ORDER BY id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tipos de asignación" });
  }
});

// Bancos activos
app.get("/bancos", requireAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT public_id AS id, titulo
      FROM bancos
      WHERE activo = true
      ORDER BY titulo ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener bancos" });
  }
});


/* ===============================
   API - RRHH SOLICITUDES
=============================== */

// Listar solicitudes (coordinador ve las suyas, reclutador ve todas)
app.get("/rrhh/solicitudes", requireAccess({ roles: ["Coordinador", "Reclutador", "Administrador"] }), async (req, res) => {
  try {
    const role = normalizeValue(req.user?.rol);
    const params = [];
    let where = "";
    if (role === "coordinador") {
      params.push(req.user?.id);
      where = "WHERE s.coordinador_id = $1";
    }
    const result = await pool.query(
      `
      SELECT
        s.public_id AS id,
        coord.public_id AS coordinador_id,
        c.public_id AS cliente_id,
        m.public_id AS modulo_id,
        s.perfil,
        s.nivel,
        s.tiempo,
        s.ubicacion,
        s.modalidad,
        s.fecha_inicio_esperada,
        s.tipo_proyecto,
        s.experiencia,
        s.presupuesto,
        s.descripcion,
        s.informacion_adicional,
        s.prioridad,
        s.estado,
        s.observaciones_rrhh,
        s.created_at,
        s.updated_at,
        c.titulo AS cliente,
        m.titulo AS modulo,
        coord.nombre_usuario AS solicitante
      FROM solicitudes_rrhh s
        LEFT JOIN clientes c ON s.cliente_id = c.id
        LEFT JOIN modulo m ON s.modulo_id = m.id
        LEFT JOIN usuarios coord ON s.coordinador_id = coord.id
      ${where}
      ORDER BY s.created_at DESC
      `,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener solicitudes" });
  }
});

// Crear solicitud (solo coordinador)
app.post("/rrhh/solicitudes", requireAccess({ roles: ["Coordinador", "Administrador"] }), async (req, res) => {
  const {
    cliente_id,
    modulo_id,
    perfil,
    nivel,
    tiempo,
    ubicacion,
    modalidad,
    fecha_inicio_esperada,
    tipo_proyecto,
    experiencia,
    presupuesto,
    descripcion,
    informacion_adicional,
    prioridad
  } = req.body;
  try {
    if (!cliente_id || !modulo_id || !perfil || !nivel) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }
    const clienteId = await resolveInternalId(pool, ID_TABLES.clientes, cliente_id, { required: true });
    const moduloId = await resolveInternalId(pool, ID_TABLES.modulo, modulo_id, { required: true });
    const result = await pool.query(
      `
      INSERT INTO solicitudes_rrhh
        (
          coordinador_id,
          cliente_id,
          modulo_id,
          perfil,
          nivel,
          tiempo,
          ubicacion,
          modalidad,
          fecha_inicio_esperada,
          tipo_proyecto,
          experiencia,
          presupuesto,
          descripcion,
          informacion_adicional,
          prioridad
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id
      `,
      [
        req.user?.id,
        clienteId,
        moduloId,
        perfil,
        nivel,
        tiempo || null,
        ubicacion || "Remoto",
        modalidad || "Full time",
        fecha_inicio_esperada || null,
        tipo_proyecto || null,
        experiencia || null,
        presupuesto || null,
        descripcion || null,
        informacion_adicional || null,
        prioridad || "Media"
      ]
    );
    const createdInternalId = result.rows[0]?.id;
    const createdRes = await pool.query(
      `
      SELECT
        s.public_id AS id,
        coord.public_id AS coordinador_id,
        c.public_id AS cliente_id,
        m.public_id AS modulo_id,
        s.perfil,
        s.nivel,
        s.tiempo,
        s.ubicacion,
        s.modalidad,
        s.fecha_inicio_esperada,
        s.tipo_proyecto,
        s.experiencia,
        s.presupuesto,
        s.descripcion,
        s.informacion_adicional,
        s.prioridad,
        s.estado,
        s.observaciones_rrhh,
        s.created_at,
        s.updated_at,
        c.titulo AS cliente,
        m.titulo AS modulo,
        coord.nombre_usuario AS solicitante
      FROM solicitudes_rrhh s
      LEFT JOIN clientes c ON c.id = s.cliente_id
      LEFT JOIN modulo m ON m.id = s.modulo_id
      LEFT JOIN usuarios coord ON coord.id = s.coordinador_id
      WHERE s.id = $1
      `,
      [createdInternalId]
    );
    const created = createdRes.rows[0];

    try {
      const [detalleSolicitud, reclutadores] = await Promise.all([
        pool.query(
          `
          SELECT
            s.id,
            s.perfil,
            s.nivel,
            s.prioridad,
            s.estado,
            c.titulo AS cliente,
            m.titulo AS modulo,
            u.nombre_usuario AS coordinador_nombre
          FROM solicitudes_rrhh s
            LEFT JOIN clientes c ON c.id = s.cliente_id
            LEFT JOIN modulo m ON m.id = s.modulo_id
            LEFT JOIN usuarios u ON u.id = s.coordinador_id
          WHERE s.id = $1
          `,
          [createdInternalId]
        ),
        pool.query(
          `
          SELECT u.email
          FROM usuarios u
            JOIN roles r ON r.id = u.rol_usuario_id
          WHERE u.activo = true
            AND u.email IS NOT NULL
            AND LOWER(r.titulo) = LOWER('Reclutador')
          `
        )
      ]);

      const info = detalleSolicitud.rows[0];
      const destinatarios = reclutadores.rows.map((r) => r.email).filter(Boolean);
      if (info && destinatarios.length) {
        const portalUrl = buildPortalUrl("solicitudesRecl");
        await sendEmailSafe({
          ...getGraphContext(req),
          to: destinatarios,
          subject: `Nueva Solicitud de Reclutamiento - ${info.perfil || "Perfil"}`,
          text:
            `Hola Equipo de Reclutamiento,\n\n` +
            `Se ha creado una nueva solicitud de reclutamiento en el sistema.\n\n` +
            `Perfil: ${info.perfil || "N/A"}\n` +
            `Cliente: ${info.cliente || "N/A"}\n` +
            `Módulo: ${info.modulo || "N/A"}\n` +
            `Nivel: ${info.nivel || "N/A"}\n` +
            `Prioridad: ${info.prioridad || "N/A"}\n` +
            `Coordinador solicitante: ${info.coordinador_nombre || "N/A"}\n\n` +
            `Por favor, revisa los detalles y comienza el proceso correspondiente.\n\n` +
            `Ver Solicitud en el Sistema: ${portalUrl}\n`,
          html: buildEmailLayout({
            title: "Nueva Solicitud de Reclutamiento",
            intro: "Hola Equipo de Reclutamiento, se creó una nueva solicitud de reclutamiento en el sistema.",
            blocks: [
              { label: "Perfil", value: info.perfil || "N/A" },
              { label: "Cliente", value: info.cliente || "N/A" },
              { label: "Módulo", value: info.modulo || "N/A" },
              { label: "Nivel", value: info.nivel || "N/A" },
              { label: "Prioridad", value: info.prioridad || "N/A" },
              { label: "Solicitante", value: info.coordinador_nombre || "N/A" }
            ],
            ctaLabel: "Ver Solicitud en el Sistema",
            ctaUrl: portalUrl
          })
        });
      }
    } catch (mailErr) {
      console.error("Error preparando notificación de nueva solicitud RRHH:", mailErr);
    }

    res.json(created);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(400).json({ error: "Cliente o módulo no válido" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al crear solicitud" });
  }
});

// Actualizar estado y/o notas (solo reclutador)
app.put("/rrhh/solicitudes/:id", requireAccess({ roles: ["Reclutador", "Administrador"] }), async (req, res) => {
  const { id } = req.params;
  const { estado, observaciones_rrhh } = req.body || {};
  try {
    const solicitudId = await resolveInternalId(pool, ID_TABLES.solicitudesRrhh, id, { required: true });
    const solicitudInfo = await pool.query(
      `
      SELECT
        s.id,
        s.estado AS estado_actual,
        s.perfil,
        s.observaciones_rrhh,
        c.titulo AS cliente,
        m.titulo AS modulo,
        u.email AS coordinador_email,
        u.nombre_usuario AS coordinador_nombre
      FROM solicitudes_rrhh s
        LEFT JOIN clientes c ON c.id = s.cliente_id
        LEFT JOIN modulo m ON m.id = s.modulo_id
        LEFT JOIN usuarios u ON u.id = s.coordinador_id
      WHERE s.id = $1
      `,
      [solicitudId]
    );

    if (solicitudInfo.rows.length === 0) {
      return res.status(404).json({ error: "Solicitud no encontrada" });
    }

    const before = solicitudInfo.rows[0];
    if (before.estado_actual === "Contratado" && estado && estado !== "Contratado") {
      return res.status(422).json({ error: "Una solicitud en estado Contratado no puede volver a estados anteriores" });
    }
    const fields = [];
    const values = [];
    let idx = 1;

    if (estado) {
      fields.push(`estado = $${idx++}`);
      values.push(estado);
    }
    if (observaciones_rrhh !== undefined) {
      fields.push(`observaciones_rrhh = $${idx++}`);
      values.push(observaciones_rrhh);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: "No hay cambios para actualizar" });
    }

    values.push(solicitudId);
    const result = await pool.query(
      `
      UPDATE solicitudes_rrhh
      SET ${fields.join(", ")}
      WHERE id = $${idx}
      RETURNING id
      `,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Solicitud no encontrada" });
    }
    const updatedId = result.rows[0]?.id;
    const updatedRes = await pool.query(
      `
      SELECT
        s.public_id AS id,
        coord.public_id AS coordinador_id,
        c.public_id AS cliente_id,
        m.public_id AS modulo_id,
        s.perfil,
        s.nivel,
        s.tiempo,
        s.ubicacion,
        s.modalidad,
        s.fecha_inicio_esperada,
        s.tipo_proyecto,
        s.experiencia,
        s.presupuesto,
        s.descripcion,
        s.informacion_adicional,
        s.prioridad,
        s.estado,
        s.observaciones_rrhh,
        s.created_at,
        s.updated_at,
        c.titulo AS cliente,
        m.titulo AS modulo,
        coord.nombre_usuario AS solicitante
      FROM solicitudes_rrhh s
      LEFT JOIN clientes c ON c.id = s.cliente_id
      LEFT JOIN modulo m ON m.id = s.modulo_id
      LEFT JOIN usuarios coord ON coord.id = s.coordinador_id
      WHERE s.id = $1
      `,
      [updatedId]
    );
    const updated = updatedRes.rows[0];

    const estadoFinal = updated.estado;
    const cambioEstado = Boolean(estado) && String(before.estado_actual || "") !== String(estadoFinal || "");
    if (cambioEstado && isRrhhEstadoNotificable(estadoFinal) && before.coordinador_email) {
      const contenido = buildRrhhEstadoEmailContent({
        estado: estadoFinal,
        perfil: updated.perfil || before.perfil,
        cliente: before.cliente,
        modulo: before.modulo,
        coordinadorNombre: before.coordinador_nombre,
        observaciones: updated.observaciones_rrhh,
        portalUrl: buildPortalUrl("solicitudesCoord")
      });
      if (contenido) {
        await sendEmailSafe({
          ...getGraphContext(req),
          to: before.coordinador_email,
          subject: contenido.subject,
          text: contenido.text,
          html: contenido.html
        });
      }
    }

    res.json(updated);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Solicitud no encontrada" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar solicitud" });
  }
});

registerPreregistroRoutes({
  app,
  pool,
  resolveInternalId,
  ID_TABLES,
  normalizeValue,
  requireAccess,
  getGraphContext,
  sendEmailSafe,
  buildEmailLayout
});
/* ===============================
   AUTH
=============================== */

app.post("/auth/register", async (req, res) => {
  if (String(process.env.AUTH_MODE || "").toLowerCase() === "ms_only") {
    return res.status(403).json({ error: "Registro deshabilitado. Usa Microsoft SSO." });
  }
  const { nombre_usuario, email, password } = req.body;

  try {
    if (!nombre_usuario || !email || !password) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const existe = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: "El correo ya está¡ registrado" });
    }

    const rolRes = await pool.query(
      "SELECT id FROM roles WHERE titulo = 'Consultor' LIMIT 1"
    );
    const rolId = rolRes.rows[0]?.id || null;

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (nombre_usuario, email, password_hash, rol_usuario_id, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, public_id, nombre_usuario, email, rol_usuario_id`,
      [nombre_usuario, email, hash, rolId]
    );

    const user = result.rows[0];
    res.json({
      ok: true,
      user: {
        id: user.public_id || (user.id ? String(user.id) : null),
        nombre_usuario: user.nombre_usuario,
        email: user.email,
        rol_usuario_id: user.rol_usuario_id
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al registrar" });
  }
});

app.post("/auth/login", async (req, res) => {
  if (String(process.env.AUTH_MODE || "").toLowerCase() === "ms_only") {
    return res.status(403).json({ error: "Login deshabilitado. Usa Microsoft SSO." });
  }
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const result = await pool.query(
      `SELECT u.id, u.public_id, u.nombre_usuario, u.email, u.password_hash, u.rol_usuario_id, u.tipo_consultor, r.titulo AS rol
         FROM usuarios u
         LEFT JOIN roles r ON u.rol_usuario_id = r.id
         WHERE u.email = $1 AND u.activo = true`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const payload = {
      id: user.id,
      public_id: user.public_id || null,
      nombre_usuario: user.nombre_usuario,
      email: user.email,
      rol: user.rol || "",
      rol_usuario_id: user.rol_usuario_id,
      tipo_consultor: user.tipo_consultor || null
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
    res.json({ token, user: buildUserResponse(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "No autorizado" });
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      `SELECT u.id, u.public_id, u.nombre_usuario, u.email, u.rol_usuario_id, u.tipo_consultor, r.titulo AS rol
         FROM usuarios u
         LEFT JOIN roles r ON u.rol_usuario_id = r.id
         WHERE u.id = $1 AND u.activo = true`,
      [decoded.id]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Usuario no válido" });
    }
    res.json({ user: buildUserResponse(result.rows[0]) });
  } catch (err) {
    res.status(401).json({ error: "Token inválido" });
  }
});

app.get("/auth/photo", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "No autorizado" });
    jwt.verify(token, JWT_SECRET);

    const graphAccessToken = String(req.headers["x-graph-access-token"] || "").trim();
    if (!graphAccessToken) {
      return res.json({
        hasPhoto: false,
        message: "No tiene foto de perfil"
      });
    }

    const photo = await graphGetBinary("/v1.0/me/photo/$value", graphAccessToken);
    return res.json({
      hasPhoto: true,
      contentType: photo.contentType || "image/jpeg",
      data: photo.buffer.toString("base64")
    });
  } catch (err) {
    if (err?.name === "JsonWebTokenError" || err?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token inválido" });
    }
    const status = parseGraphErrorStatus(err?.message);
    if (status === 404) {
      return res.json({
        hasPhoto: false,
        message: "No tiene foto de perfil"
      });
    }
    if (status === 401 || status === 403) {
      return res.json({
        hasPhoto: false,
        message: "No se pudo validar la sesión de Microsoft para la foto"
      });
    }
    console.error("Error obteniendo foto de perfil Microsoft:", err?.message || err);
    return res.status(500).json({
      hasPhoto: false,
      message: "Error al cargar foto de perfil"
    });
  }
});

app.post("/auth/microsoft", async (req, res) => {
  const accessToken = req.body?.access_token;
  if (!accessToken) {
    return res.status(400).json({ error: "access_token requerido" });
  }

  const tokenPayload = decodeJwtPayload(accessToken);
  const aud = tokenPayload?.aud || null;
  const scope = tokenPayload?.scp || "";
  const isGraphAud =
    aud === "https://graph.microsoft.com" ||
    aud === "00000003-0000-0000-c000-000000000000";

  if (!isGraphAud) {
    return res.status(401).json({
      error: "El token recibido no es de Microsoft Graph. Solicita el scope User.Read en el frontend."
    });
  }

  try {
    const me = await graphGet("/v1.0/me?$select=id,mail,userPrincipalName,displayName,mobilePhone", accessToken);
    const oid = me.id;
    const email = me.mail || me.userPrincipalName;
    const nombre = me.displayName || email;
    const telefono = me.mobilePhone || null;

    if (!oid || !email) {
      return res.status(400).json({ error: "No se pudo obtener información del usuario" });
    }

    const allowedGroups = (process.env.AZURE_ALLOWED_GROUPS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowedGroupsNormalized = new Set(allowedGroups.map(normalizeValue));
    const allowedGroupIds = allowedGroups.filter(isGuid);
    const allowedGroupNames = allowedGroups.filter((g) => !isGuid(g));

    if (allowedGroups.length > 0) {
      let groups = [];
      let matchedGroup = null;
      let allowed = false;

      if (allowedGroupIds.length > 0) {
        const check = await graphPost("/v1.0/me/checkMemberGroups", accessToken, {
          groupIds: allowedGroupIds
        });
        const matchedIds = Array.isArray(check?.value) ? check.value : [];
        if (matchedIds.length > 0) {
          matchedGroup = { id: matchedIds[0], name: null };
          allowed = true;
        }
      }

      if (!allowed && allowedGroupNames.length > 0) {
        const memberOf = await graphGetAll("/v1.0/me/transitiveMemberOf?$select=id,displayName", accessToken);
        groups = memberOf.map((g) => ({
          id: g.id,
          name: g.displayName
        }));
        matchedGroup = groups.find(
          (g) =>
            allowedGroupsNormalized.has(normalizeValue(g.id)) ||
            allowedGroupsNormalized.has(normalizeValue(g.name))
        ) || null;
        allowed = Boolean(matchedGroup);
      }

      if (!allowed) {
        return res.status(403).json({ error: "Usuario sin acceso al grupo permitido" });
      }
    }

    const roleRes = await pool.query(
      "SELECT id, titulo FROM roles WHERE LOWER(titulo) = LOWER('Consultor') LIMIT 1"
    );
    const rolId = roleRes.rows[0]?.id || null;
    const rolTitulo = roleRes.rows[0]?.titulo || "Consultor";
    if (!rolId) {
      return res.status(500).json({ error: "No existe el rol 'Consultor' en la tabla roles" });
    }

    let userRes = await pool.query(
      `SELECT u.id, u.public_id, u.nombre_usuario, u.email, u.rol_usuario_id, u.tipo_consultor, u.azure_oid, r.titulo AS rol
       FROM usuarios u
       LEFT JOIN roles r ON u.rol_usuario_id = r.id
       WHERE (u.azure_oid = $1 OR u.email = $2) AND u.activo = true
       LIMIT 1`,
      [oid, email]
    );

    if (userRes.rows.length === 0) {
      userRes = await pool.query(
        `INSERT INTO usuarios
          (nombre_usuario, email, rol_usuario_id, activo, telefono, created_by, azure_oid)
         VALUES ($1, $2, $3, true, $4, 'ms_sso', $5)
         RETURNING id, public_id, nombre_usuario, email, rol_usuario_id`,
        [nombre, email, rolId, telefono, oid]
      );
    } else {
      const user = userRes.rows[0];
      if (!user.azure_oid) {
        await pool.query(
          "UPDATE usuarios SET azure_oid = $1 WHERE id = $2",
          [oid, user.id]
        );
      }
    }

    const userRow = userRes.rows[0];
    if (!userRow?.id) {
      return res.status(500).json({ error: "No se pudo crear o recuperar el usuario de Microsoft en BD" });
    }
    const payload = {
      id: userRow.id,
      public_id: userRow.public_id || null,
      nombre_usuario: userRow.nombre_usuario || nombre,
      email: userRow.email || email,
      rol: userRow.rol || rolTitulo,
      rol_usuario_id: userRow.rol_usuario_id || rolId,
      tipo_consultor: userRow.tipo_consultor || null
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
    res.json({
      token,
      user: buildUserResponse({
        ...userRow,
        rol: userRow.rol || rolTitulo
      })
    });
  } catch (err) {
    const status = parseGraphErrorStatus(err.message);
    if (status === 401 || status === 403) {
      return res.status(401).json({
        error: "Token Microsoft inválido o sin permisos en Graph (revisa consentimiento de User.Read)."
      });
    }
    console.error("Error auth microsoft (interno):", err.message);

    if (err.code === "28P01") {
      return res.status(500).json({ error: "Credenciales de base de datos inválidas (DB_USER/DB_PASSWORD)" });
    }
    if (err.code === "3D000") {
      return res.status(500).json({ error: "Base de datos no existe (DB_NAME)" });
    }
    if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      return res.status(500).json({ error: "No se pudo conectar a la base de datos (DB_HOST/DB_PORT)" });
    }
    if (err.code === "42703") {
      return res.status(500).json({
        error:
          "Falta una columna requerida en la BD. Ejecuta la migracion db/migrations/2026-02-24-add-public-id.sql y reinicia el backend."
      });
    }
    if (err.code === "23505") {
      return res.status(500).json({ error: "Conflicto de datos al crear usuario (email/azure_oid duplicado)" });
    }
    if (err.code === "23502") {
      return res.status(500).json({ error: "Campo obligatorio nulo al crear usuario en BD" });
    }
    return res.status(500).json({ error: "Error interno al procesar autenticación Microsoft" });
  }
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      db_pool: getPoolStats()
    });
  } catch (err) {
    res.status(503).json({
      status: "unhealthy",
      db_pool: getPoolStats()
    });
  }
});

// Debug temporal para validar autenticación Click&Sign (base URL + header + user).
// Uso:
//   GET /debug/clicksign?token=... [&user=...] [&base=...]
app.get("/debug/clicksign", async (req, res) => {
  try {
    if (!DEBUG_CLICKSIGN_TOKEN) {
      return res.status(404).json({ error: "Ruta no disponible" });
    }

    const inboundToken = String(
      req.query?.token || req.headers["x-debug-token"] || ""
    ).trim();
    if (!inboundToken || inboundToken !== DEBUG_CLICKSIGN_TOKEN) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const apiKey = CLICKSIGN_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: "Falta CLICKSIGN_API_KEY en entorno" });
    }

    const requestedUser = String(req.query?.user || "").trim();
    const requestedBase = String(req.query?.base || "").trim();

    const userCandidates = Array.from(
      new Set([requestedUser, CLICKSIGN_USER].map((v) => String(v || "").trim()).filter(Boolean))
    );
    if (userCandidates.length === 0) {
      return res.status(400).json({ error: "Falta user para prueba (CLICKSIGN_USER o ?user=...)" });
    }

    const baseCandidates = Array.from(
      new Set(
        [requestedBase, CLICKSIGN_API_BASE, "https://api.lleida.net/cs/v1", "https://api.clickandsign.eu/cs/v1"]
          .map((v) => normalizeClickSignBaseUrl(v))
          .filter(Boolean)
      )
    );

    const headerModes = [
      {
        mode: "x-api-key",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json"
        }
      },
      {
        mode: "authorization",
        headers: {
          Authorization: `x-api-key ${apiKey}`,
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json"
        }
      },
      {
        mode: "both",
        headers: {
          "x-api-key": apiKey,
          Authorization: `x-api-key ${apiKey}`,
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json"
        }
      }
    ];

    const attempts = [];
    let seq = 0;
    for (const base of baseCandidates) {
      for (const user of userCandidates) {
        for (const headerMode of headerModes) {
          seq += 1;
          const requestId = `dbg-${Date.now()}-${seq}`;
          const targetUrl = buildClickSignCustomUrl(base, "get_config_list");
          const attempt = {
            target: targetUrl,
            base,
            header_mode: headerMode.mode,
            user,
            request_id: requestId
          };

          try {
            const response = await jsonRequest({
              method: "POST",
              url: targetUrl,
              headers: headerMode.headers,
              body: {
                request: "GET_CONFIG_LIST",
                request_id: requestId,
                user
              },
              timeoutMs: 20000
            });
            attempts.push({
              ...attempt,
              ok: true,
              http_status: response.status,
              code: response?.data?.code ?? response?.data?.result?.code ?? null,
              status: response?.data?.status ?? response?.data?.result?.status ?? "OK",
              sample: response.data
            });
          } catch (err) {
            attempts.push({
              ...attempt,
              ok: false,
              http_status: Number(err?.status || 0) || null,
              code: err?.response?.code ?? err?.response?.result?.code ?? null,
              status: err?.response?.status ?? err?.response?.result?.status ?? err?.message ?? "ERROR",
              sample: err?.response ?? null
            });
          }
        }
      }
    }

    const success = attempts.filter((a) => a.ok);
    return res.json({
      ok: success.length > 0,
      configured: {
        api_base: normalizeClickSignBaseUrl(CLICKSIGN_API_BASE),
        api_key_masked: maskSecret(apiKey),
        clicksign_user: CLICKSIGN_USER
      },
      tested: {
        users: userCandidates,
        bases: baseCandidates,
        header_modes: headerModes.map((h) => h.mode)
      },
      summary: {
        total_attempts: attempts.length,
        success_attempts: success.length
      },
      success,
      attempts
    });
  } catch (err) {
    return res.status(500).json({ error: "Error debug Click&Sign", detalle: err?.message || String(err) });
  }
});

const authMiddleware = (req, res, next) => {
  const publicPaths = ["/", "/auth/login", "/auth/register", "/auth/me", "/auth/microsoft"];
  if (publicPaths.includes(req.path) || req.path.startsWith("/auth/")) return next();
  if (req.path.startsWith("/webhooks/")) return next();
  if (req.method === "OPTIONS") return next();

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) return res.status(401).json({ error: "No autorizado" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido" });
  }
};

app.use(authMiddleware);

// Coordinadores activos
app.get("/coordinadores", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.public_id AS id,
        u.nombre_usuario AS nombre
      FROM usuarios u
      LEFT JOIN roles r ON u.rol_usuario_id = r.id
      WHERE u.activo = true
        AND (
          r.titulo = 'Coordinador'
          OR u.rol_usuario_id = (SELECT id FROM roles WHERE titulo = 'Coordinador' LIMIT 1)
        )
      ORDER BY u.nombre_usuario ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener coordinadores" });
  }
});

// Tarifa vigente de un consultor
app.get("/tarifa-consultor", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { consultor_id, cliente_id, modulo_id, tipo_asignacion_id } = req.query;
  try {
    if (!consultor_id || !cliente_id) {
      return res.status(400).json({ error: "Faltan parámetros requeridos" });
    }
    const consultorId = await resolveInternalId(pool, ID_TABLES.usuarios, consultor_id, { required: true });
    const clienteId = await resolveInternalId(pool, ID_TABLES.clientes, cliente_id, { required: true });
    const moduloId = await resolveInternalId(pool, ID_TABLES.modulo, modulo_id, { required: false });
    const tipoAsignacionId = await resolveInternalId(pool, ID_TABLES.tipoAsignacion, tipo_asignacion_id, { required: false });
    const result = await pool.query(
      `SELECT obtener_tarifa_consultor($1, $2, $3, $4) AS valor_tarifa`,
      [consultorId, clienteId, moduloId || null, tipoAsignacionId || null]
    );
    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "No se encontraron referencias para calcular tarifa" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al obtener tarifa" });
  }
});

/* ===============================
   API - TARIFAS
=============================== */

// Obtener tarifas
app.get("/tarifas", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        tc.public_id AS id,
        c.public_id AS cliente_id,
        u.public_id AS consultor_id,
        m.public_id AS modulo_id,
        ta.public_id AS tipo_asignacion_id,
        tc.valor_tarifa AS valor,
        tc.activo,
        c.titulo AS nombre_cliente,
        u.nombre_usuario AS nombre_consultor,
        m.titulo AS nombre_modulo,
        ta.titulo AS tipo_asignacion,
        u.moneda_cobro AS moneda
      FROM tarifa_consultor tc
      JOIN clientes c ON c.id = tc.id_cliente
      JOIN usuarios u ON u.id = tc.consultor_id
      LEFT JOIN modulo m ON m.id = tc.modulo_id
      LEFT JOIN tipo_asignacion ta ON ta.id = tc.id_tipo_asignacion
      WHERE tc.activo = true
      ORDER BY tc.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tarifas" });
  }
});

// Crear tarifa
app.post("/tarifas", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { cliente_id, consultor_id, modulo_id, tipo_asignacion_id, valor } = req.body;

  try {
    if (!cliente_id || !consultor_id || !tipo_asignacion_id || !valor) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }
    const clienteId = await resolveInternalId(pool, ID_TABLES.clientes, cliente_id, { required: true });
    const consultorId = await resolveInternalId(pool, ID_TABLES.usuarios, consultor_id, { required: true });
    const moduloId = await resolveInternalId(pool, ID_TABLES.modulo, modulo_id, { required: false });
    const tipoAsignacionId = await resolveInternalId(pool, ID_TABLES.tipoAsignacion, tipo_asignacion_id, { required: true });

    const result = await pool.query(
      `WITH ins AS (
         INSERT INTO tarifa_consultor
           (id_cliente, consultor_id, modulo_id, id_tipo_asignacion, valor_tarifa, activo)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING id
       )
       SELECT
         tc.public_id AS id,
         c.public_id AS cliente_id,
         u.public_id AS consultor_id,
         m.public_id AS modulo_id,
         ta.public_id AS tipo_asignacion_id,
         tc.valor_tarifa AS valor,
         tc.activo,
         c.titulo AS nombre_cliente,
         u.nombre_usuario AS nombre_consultor,
         m.titulo AS nombre_modulo,
         ta.titulo AS tipo_asignacion,
         u.moneda_cobro AS moneda
       FROM tarifa_consultor tc
       JOIN clientes c ON c.id = tc.id_cliente
       JOIN usuarios u ON u.id = tc.consultor_id
       LEFT JOIN modulo m ON m.id = tc.modulo_id
       LEFT JOIN tipo_asignacion ta ON ta.id = tc.id_tipo_asignacion
       WHERE tc.id = (SELECT id FROM ins)`,
      [
        clienteId,
        consultorId,
        moduloId || null,
        tipoAsignacionId || null,
        valor
      ]
    );
    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(400).json({ error: "Cliente, consultor, módulo o tipo de asignación no válido" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al guardar tarifa" });
  }
});

// Actualizar tarifa
app.put("/tarifas/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;
  const { cliente_id, consultor_id, modulo_id, tipo_asignacion_id, valor } = req.body;

  try {
    const tarifaId = await resolveInternalId(pool, ID_TABLES.tarifaConsultor, id, { required: true });
    const clienteId = await resolveInternalId(pool, ID_TABLES.clientes, cliente_id, { required: true });
    const consultorId = await resolveInternalId(pool, ID_TABLES.usuarios, consultor_id, { required: true });
    const moduloId = await resolveInternalId(pool, ID_TABLES.modulo, modulo_id, { required: false });
    const tipoAsignacionId = await resolveInternalId(pool, ID_TABLES.tipoAsignacion, tipo_asignacion_id, { required: true });
    const result = await pool.query(
      `WITH upd AS (
         UPDATE tarifa_consultor
         SET id_cliente = $1,
             consultor_id = $2,
             modulo_id = $3,
             id_tipo_asignacion = $4,
             valor_tarifa = $5
         WHERE id = $6
         RETURNING id
       )
       SELECT
         tc.public_id AS id,
         c.public_id AS cliente_id,
         u.public_id AS consultor_id,
         m.public_id AS modulo_id,
         ta.public_id AS tipo_asignacion_id,
         tc.valor_tarifa AS valor,
         tc.activo,
         c.titulo AS nombre_cliente,
         u.nombre_usuario AS nombre_consultor,
         m.titulo AS nombre_modulo,
         ta.titulo AS tipo_asignacion,
         u.moneda_cobro AS moneda
       FROM tarifa_consultor tc
       JOIN clientes c ON c.id = tc.id_cliente
       JOIN usuarios u ON u.id = tc.consultor_id
       LEFT JOIN modulo m ON m.id = tc.modulo_id
       LEFT JOIN tipo_asignacion ta ON ta.id = tc.id_tipo_asignacion
       WHERE tc.id = (SELECT id FROM upd)`,
      [
        clienteId,
        consultorId,
        moduloId || null,
        tipoAsignacionId || null,
        valor,
        tarifaId
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Tarifa no encontrada" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Tarifa o referencias no encontradas" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar tarifa" });
  }
});

// Eliminar tarifa (soft delete)
app.delete("/tarifas/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;

  try {
    const tarifaId = await resolveInternalId(pool, ID_TABLES.tarifaConsultor, id, { required: true });
    await pool.query("UPDATE tarifa_consultor SET activo = false WHERE id = $1", [tarifaId]);
    res.json({ ok: true });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Tarifa no encontrada" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al eliminar tarifa" });
  }
});

/* ===============================
   API - CONSULTORÍAS (ASIGNACIÓN COORDINADORES)
=============================== */

// Obtener consultorías
app.get("/consultorias", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  try {
    let coordinadorId = null;
    if (req.query.coordinador_id) {
      coordinadorId = await resolveInternalId(
        pool,
        ID_TABLES.usuarios,
        req.query.coordinador_id,
        { required: true }
      );
    }
    const result = await pool.query(`
      SELECT
        c.public_id AS id,
        cli.public_id AS cliente_id,
        u.public_id AS coordinador_id,
        ta.public_id AS tipo_asignacion_id,
        c.descripcion_consultoria,
        c.activo,
        cli.titulo AS nombre_cliente,
        u.nombre_usuario AS nombre_coordinador,
        ta.titulo AS tipo_asignacion
      FROM consultorias c
      JOIN clientes cli ON cli.id = c.id_cliente
      LEFT JOIN usuarios u ON u.id = c.coordinador_responsable_id
      LEFT JOIN tipo_asignacion ta ON ta.id = c.id_tipo_asignacion
      WHERE c.activo = true
        AND ($1::int IS NULL OR c.coordinador_responsable_id = $1)
      ORDER BY c.id DESC
    `, [coordinadorId]);
    res.json(result.rows);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.json([]);
    console.error(err);
    res.status(500).json({ error: "Error al obtener consultorías" });
  }
});

// Crear consultoría
app.post("/consultorias", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { cliente_id, coordinador_id, tipo_asignacion_id, descripcion_consultoria } = req.body;

  try {
    if (!cliente_id || !coordinador_id || !tipo_asignacion_id) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }
    const clienteId = await resolveInternalId(pool, ID_TABLES.clientes, cliente_id, { required: true });
    const coordinadorId = await resolveInternalId(pool, ID_TABLES.usuarios, coordinador_id, { required: true });
    const tipoAsignacionId = await resolveInternalId(pool, ID_TABLES.tipoAsignacion, tipo_asignacion_id, { required: true });

    const result = await pool.query(
      `WITH ins AS (
         INSERT INTO consultorias
           (id_cliente, coordinador_responsable_id, id_tipo_asignacion, descripcion_consultoria, activo)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id
       )
       SELECT
         c.public_id AS id,
         cli.public_id AS cliente_id,
         u.public_id AS coordinador_id,
         ta.public_id AS tipo_asignacion_id,
         c.descripcion_consultoria,
         c.activo,
         cli.titulo AS nombre_cliente,
         u.nombre_usuario AS nombre_coordinador,
         ta.titulo AS tipo_asignacion
       FROM consultorias c
       JOIN clientes cli ON cli.id = c.id_cliente
       LEFT JOIN usuarios u ON u.id = c.coordinador_responsable_id
       LEFT JOIN tipo_asignacion ta ON ta.id = c.id_tipo_asignacion
       WHERE c.id = (SELECT id FROM ins)`,
      [
        clienteId,
        coordinadorId,
        tipoAsignacionId,
        descripcion_consultoria || null
      ]
    );
    const created = result.rows[0];

    // Email al coordinador asignado
    const mailInfo = await pool.query(
      `SELECT
         u.email AS coordinador_email,
         u.nombre_usuario AS coordinador_nombre,
         c.titulo AS cliente,
         ta.titulo AS tipo_asignacion
       FROM usuarios u
         JOIN clientes c ON c.id = $1
         JOIN tipo_asignacion ta ON ta.id = $2
        WHERE u.id = $3`,
      [clienteId, tipoAsignacionId, coordinadorId]
    );
    const row = mailInfo.rows[0];
    if (row?.coordinador_email) {
      const portalUrl = buildPortalUrl("mis-asignaciones-coordinador");
      await sendEmailSafe({
        ...getGraphContext(req),
        to: row.coordinador_email,
        subject: `Nueva consultoría asignada - ${row.cliente}`,
        text:
          `Hola ${row.coordinador_nombre || ""},\n` +
          `Se creó una consultoría para el cliente ${row.cliente}.\n` +
          `Tipo de asignación: ${row.tipo_asignacion}.\n` +
          `Descripción: ${descripcion_consultoria || "Sin descripción"}.\n` +
          `Revisa en: ${portalUrl}\n`,
        html: buildEmailLayout({
          title: "Nueva consultoría asignada",
          intro: `Hola <strong>${row.coordinador_nombre || "Coordinador"}</strong>, se creó una consultoría para que inicies gestión operativa.`,
          blocks: [
            { label: "Cliente", value: row.cliente },
            { label: "Tipo de asignación", value: row.tipo_asignacion || "N/A" },
            { label: "Descripción", value: descripcion_consultoria || "Sin descripción" }
          ],
          ctaLabel: "Ver consultoría en el portal",
          ctaUrl: portalUrl
        })
      });
    }

    res.json(created);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(400).json({ error: "Cliente, coordinador o tipo de asignación no válido" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al guardar consultoría" });
  }
});

// Actualizar consultoría
app.put("/consultorias/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;
  const { cliente_id, coordinador_id, tipo_asignacion_id, descripcion_consultoria } = req.body;

  try {
    const consultoriaId = await resolveInternalId(pool, ID_TABLES.consultorias, id, { required: true });
    const clienteId = await resolveInternalId(pool, ID_TABLES.clientes, cliente_id, { required: true });
    const coordinadorId = await resolveInternalId(pool, ID_TABLES.usuarios, coordinador_id, { required: true });
    const tipoAsignacionId = await resolveInternalId(pool, ID_TABLES.tipoAsignacion, tipo_asignacion_id, { required: true });
    const result = await pool.query(
      `WITH upd AS (
         UPDATE consultorias
         SET id_cliente = $1,
             coordinador_responsable_id = $2,
             id_tipo_asignacion = $3,
             descripcion_consultoria = $4
         WHERE id = $5
         RETURNING id
       )
       SELECT
         c.public_id AS id,
         cli.public_id AS cliente_id,
         u.public_id AS coordinador_id,
         ta.public_id AS tipo_asignacion_id,
         c.descripcion_consultoria,
         c.activo,
         cli.titulo AS nombre_cliente,
         u.nombre_usuario AS nombre_coordinador,
         ta.titulo AS tipo_asignacion
       FROM consultorias c
       JOIN clientes cli ON cli.id = c.id_cliente
       LEFT JOIN usuarios u ON u.id = c.coordinador_responsable_id
       LEFT JOIN tipo_asignacion ta ON ta.id = c.id_tipo_asignacion
       WHERE c.id = (SELECT id FROM upd)`,
      [
        clienteId,
        coordinadorId,
        tipoAsignacionId,
        descripcion_consultoria || null,
        consultoriaId
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Consultoría no encontrada" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Consultoría o referencias no encontradas" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar consultoría" });
  }
});

// Eliminar consultoría (soft delete)
app.delete("/consultorias/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;

  try {
    const consultoriaId = await resolveInternalId(pool, ID_TABLES.consultorias, id, { required: true });
    await pool.query("UPDATE consultorias SET activo = false WHERE id = $1", [consultoriaId]);
    res.json({ ok: true });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Consultoría no encontrada" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al eliminar consultoría" });
  }
});

/* ===============================
   API - MIS ASIGNACIONES (COORDINADOR)
=============================== */

// Listar asignaciones activas para coordinador
app.get("/mis-asignaciones-coordinador", requireAccess({ roles: ["Coordinador"] }), async (req, res) => {
  try {
    const userId = req.user?.id || req.query.coordinador_id;
    const result = await pool.query(`
        SELECT
          ra.public_id AS id,
          con.public_id AS consultoria_id,
          c.public_id AS cliente_id,
          c.titulo AS cliente,
          u.nombre_usuario AS consultor_responsable,
          coord.nombre_usuario AS coordinador,
          m.titulo AS modulo,
          ta.titulo AS tipo_asignacion,
          ta.public_id AS tipo_asignacion_id,
          con.descripcion_consultoria,
          u.public_id AS consultor_responsable_id,
          m.public_id AS id_modulo,
          ra.estado,
          ra.tipo_servicio,
          ra.valor_hora,
          ra.valor_dia,
          ra.total_pagar,
          ra.cantidad_dias,
          ra.fecha_inicio,
          ra.fecha_fin,
          ra.nro_caso_interno,
          ra.nro_caso_cliente,
          ra.observacion
        FROM registro_asignaciones ra
          JOIN consultorias con ON ra.id_consultoria = con.id
          JOIN clientes c ON con.id_cliente = c.id
          LEFT JOIN usuarios u ON ra.consultor_responsable_id = u.id
          LEFT JOIN usuarios coord ON con.coordinador_responsable_id = coord.id
          LEFT JOIN modulo m ON ra.id_modulo = m.id
          LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
        WHERE con.activo = true
          AND ($1::int IS NULL OR con.coordinador_responsable_id = $1)
        ORDER BY ra.id DESC
      `, [userId || null]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener asignaciones" });
  }
});

// Listar asignaciones activas para consultor
app.get("/mis-asignaciones", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  try {
    const userId = req.user?.id || req.query.consultor_id;
    const result = await pool.query(`
      SELECT
        ra.public_id AS id,
        con.public_id AS consultoria_id,
        c.public_id AS cliente_id,
        c.titulo AS nombre_cliente,
        coord.nombre_usuario AS nombre_coordinador,
        m.titulo AS nombre_modulo,
        ta.titulo AS nombre_tipo_asignacion,
        ra.horas_asignadas,
        ra.cantidad_dias,
        ra.valor_hora,
        ra.valor_dia,
        ra.total_pagar,
        ra.estado,
        ra.tipo_servicio,
        ra.nro_caso_interno,
        ra.nro_caso_cliente,
        ra.fecha_fin,
        ra.observacion,
        lr.estado_reporte,
        lr.motivo_rechazo
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        JOIN clientes c ON con.id_cliente = c.id
        LEFT JOIN usuarios coord ON con.coordinador_responsable_id = coord.id
        LEFT JOIN modulo m ON ra.id_modulo = m.id
        LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
        LEFT JOIN LATERAL (
          SELECT rh.estado_reporte, rh.motivo_rechazo
          FROM reporte_horas rh
          WHERE rh.id_registro_asignacion = ra.id
          ORDER BY rh.created_at DESC
          LIMIT 1
        ) lr ON true
      WHERE (
        $1::int IS NULL
        OR ra.consultor_responsable_id = $1
        OR ra.consultor_responsable_id IN (
          SELECT u.id
          FROM usuarios u
          WHERE u.activo = true
            AND u.id_consultor_principal = $1
        )
      )
      ORDER BY ra.id DESC
    `, [userId || null]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener asignaciones" });
  }
});

// Asignaciones disponibles para registro de horas (consultor)
app.get("/registro-horas-asignaciones", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  try {
    const estados = await getEstadoAsignacionValues();
    const userId = req.user?.id || req.query.consultor_id;
    const result = await pool.query(`
      SELECT
        ra.public_id AS id,
        con.public_id AS consultoria_id,
        c.public_id AS cliente_id,
        c.titulo AS nombre_cliente,
        coord.nombre_usuario AS nombre_coordinador,
        m.titulo AS nombre_modulo,
        ta.titulo AS nombre_tipo_asignacion,
        ra.horas_asignadas,
        ra.cantidad_dias,
        CASE
          WHEN ra.horas_asignadas IS NULL THEN NULL
          ELSE GREATEST(ra.horas_asignadas - COALESCE(uso.horas_aprobadas, 0), 0)
        END AS horas_disponibles,
        CASE
          WHEN ra.cantidad_dias IS NULL THEN NULL
          ELSE GREATEST(ra.cantidad_dias - COALESCE(uso.dias_aprobados, 0), 0)
        END AS dias_disponibles,
        ra.valor_hora,
        ra.valor_dia,
        ra.total_pagar,
        ra.estado,
        ra.tipo_servicio,
        ra.nro_caso_interno,
        ra.nro_caso_cliente,
        ra.fecha_fin,
        ra.observacion,
        lr.estado_reporte,
        lr.motivo_rechazo
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        JOIN clientes c ON con.id_cliente = c.id
        LEFT JOIN usuarios coord ON con.coordinador_responsable_id = coord.id
        LEFT JOIN modulo m ON ra.id_modulo = m.id
        LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
        LEFT JOIN LATERAL (
          SELECT rh.estado_reporte, rh.motivo_rechazo
          FROM reporte_horas rh
          WHERE rh.id_registro_asignacion = ra.id
          ORDER BY rh.created_at DESC
          LIMIT 1
        ) lr ON true
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(CASE WHEN rh.estado_reporte = 'Aprobado' THEN rh.horas_reportadas ELSE 0 END), 0) AS horas_aprobadas,
            COALESCE(SUM(CASE WHEN rh.estado_reporte = 'Aprobado' THEN rh.cantidad_dias_reportados ELSE 0 END), 0) AS dias_aprobados
          FROM reporte_horas rh
          WHERE rh.id_registro_asignacion = ra.id
        ) uso ON true
      WHERE (
        $1::int IS NULL
        OR ra.consultor_responsable_id = $1
        OR ra.consultor_responsable_id IN (
          SELECT u.id
          FROM usuarios u
          WHERE u.activo = true
            AND u.id_consultor_principal = $1
        )
      )
        AND (lr.estado_reporte IS NULL OR lr.estado_reporte IN ('Rechazado', 'Aprobado'))
        AND ra.estado IN ($2::tipo_estado_asignacion, $3::tipo_estado_asignacion)
        AND NOT (
          COALESCE(con.id_tipo_asignacion, 0) IN (5, 6)
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) IN ('mesa de servicio', 'fabrica', 'fábrica')
        )
        AND (
          LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%horas por demanda%'
          OR (
            (
              LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%full%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%part%'
            )
            AND (ra.cantidad_dias IS NULL OR ra.cantidad_dias > COALESCE(uso.dias_aprobados, 0))
          )
          OR (
            NOT (
              LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%full%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%part%'
            )
            AND (ra.horas_asignadas IS NULL OR ra.horas_asignadas > COALESCE(uso.horas_aprobadas, 0))
          )
        )
      ORDER BY ra.id DESC
    `, [userId || null, estados.abierto, estados.proceso]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener asignaciones para registro" });
  }
});

// Reportar horas
app.post("/reportar-horas", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  const {
    id_registro_asignacion,
    horas_reportadas,
    cantidad_dias_reportados,
    total_cobrar,
    tipo_servicio,
    nro_caso_int_ext
  } = req.body;

  try {
    const horasReportadasNum = toNullableNumber(horas_reportadas);
    const diasReportadosNum = toNullableInteger(cantidad_dias_reportados);
    const totalCobrarNum = toNullableNumber(total_cobrar);

    if (!id_registro_asignacion) {
      return res.status(400).json({ error: "Falta id_registro_asignacion" });
    }
    const registroAsignacionId = await resolveInternalId(
      pool,
      ID_TABLES.registroAsignaciones,
      id_registro_asignacion,
      { required: true }
    );

    const existente = await pool.query(
      `SELECT id, estado_reporte
         FROM reporte_horas
         WHERE id_registro_asignacion = $1
           AND estado_reporte IN ('Pendiente', 'Rechazado')
         ORDER BY updated_at DESC NULLS LAST, id DESC
         LIMIT 1`,
      [registroAsignacionId]
    );
    const existenteRow = existente.rows[0];
    if (existenteRow?.estado_reporte === "Pendiente") {
      return res.status(400).json({ error: "Ya hay un reporte pendiente para esta asignación" });
    }

    const meta = await pool.query(`
      SELECT
        ra.id,
        ra.estado AS estado_asignacion,
        ra.id_modulo,
        ra.horas_asignadas,
        ra.cantidad_dias,
        ra.consultor_responsable_id,
        con.id_cliente,
        con.id_tipo_asignacion,
        con.coordinador_responsable_id,
        ta.titulo AS tipo_asignacion_titulo
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
      WHERE ra.id = $1
    `, [registroAsignacionId]);

    if (meta.rows.length === 0) {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }

    const info = meta.rows[0];
    const estadosAsignacion = await getEstadoAsignacionValues();
    if (!isAsignacionReportableEstado(info.estado_asignacion, estadosAsignacion)) {
      return res.status(400).json({ error: "La asignación está cerrada y no permite nuevos reportes." });
    }
    const tipoAsignacionId = Number(info.id_tipo_asignacion || 0);
    const tipoAsignacionTitulo = String(info.tipo_asignacion_titulo || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
    const esMesaOFabrica =
      [5, 6].includes(tipoAsignacionId) ||
      ["mesa de servicio", "fabrica"].includes(tipoAsignacionTitulo);
    if (esMesaOFabrica) {
      return res.status(400).json({
        error: "Las asignaciones de Mesa/Fábrica se registran en el módulo de Mesa/Fábrica, no en Registro Horas."
      });
    }

    const esMensual =
      tipoAsignacionTitulo.includes("full") ||
      tipoAsignacionTitulo.includes("part");
    const esHorasPorDemanda = tipoAsignacionTitulo.includes("horas por demanda");
    const cantidadSolicitada = esMensual
      ? Number(diasReportadosNum || 0)
      : Number(horasReportadasNum || 0);

    if (!(cantidadSolicitada > 0)) {
      return res.status(400).json({ error: esMensual ? "Debes reportar días mayores a 0" : "Debes reportar horas mayores a 0" });
    }

    if (!esHorasPorDemanda) {
      const uso = await pool.query(
        `
        SELECT
          COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN horas_reportadas ELSE 0 END), 0) AS horas_aprobadas,
          COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN cantidad_dias_reportados ELSE 0 END), 0) AS dias_aprobados
        FROM reporte_horas
        WHERE id_registro_asignacion = $1
        `,
        [registroAsignacionId]
      );
      const horasAprobadas = Number(uso.rows[0]?.horas_aprobadas || 0);
      const diasAprobadas = Number(uso.rows[0]?.dias_aprobadas || 0);
      const horasAsignadas = toNullableNumber(info.horas_asignadas);
      const diasAsignados = toNullableNumber(info.cantidad_dias);

      if (esMensual && diasAsignados !== null) {
        const disponibles = Math.max(diasAsignados - diasAprobadas, 0);
        if (cantidadSolicitada > disponibles) {
          return res.status(400).json({ error: `Excede días disponibles de la asignación (${disponibles})` });
        }
      }
      if (!esMensual && horasAsignadas !== null) {
        const disponibles = Math.max(horasAsignadas - horasAprobadas, 0);
        if (cantidadSolicitada > disponibles) {
          return res.status(400).json({ error: `Excede horas disponibles de la asignación (${disponibles})` });
        }
      }
    }

    const consultorId = info.consultor_responsable_id || req.user?.id || null;
    let consultorPrincipalId = null;
    if (consultorId) {
      const principalRes = await pool.query(
        "SELECT id_consultor_principal, tipo_consultor FROM usuarios WHERE id = $1",
        [consultorId]
      );
      const principalRow = principalRes.rows[0];
      if (principalRow?.id_consultor_principal) {
        consultorPrincipalId = principalRow.id_consultor_principal;
      }
    }
    let result;
    if (existenteRow?.estado_reporte === "Rechazado") {
      result = await pool.query(
        `UPDATE reporte_horas
           SET horas_reportadas = $1,
               cantidad_dias_reportados = $2,
               total_cobrar = $3,
               tipo_servicio = $4,
               nro_caso_int_ext = $5,
               cliente_id = $6,
               tipo_asignacion_id = $7,
               modulo_id = $8,
               coordinador_id = $9,
               consultor_responsable_id = $10,
               consultor_principal_id = $11,
               estado_reporte = 'Pendiente',
               motivo_rechazo = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $12
           RETURNING *`,
        [
          horasReportadasNum,
          diasReportadosNum,
          totalCobrarNum,
          tipo_servicio || null,
          nro_caso_int_ext || null,
          info.id_cliente,
          info.id_tipo_asignacion,
          info.id_modulo,
          info.coordinador_responsable_id,
          consultorId,
          consultorPrincipalId,
          existenteRow.id
        ]
      );
    } else {
      result = await pool.query(
        `INSERT INTO reporte_horas
            (id_registro_asignacion, horas_reportadas, cantidad_dias_reportados, total_cobrar,
             tipo_servicio, nro_caso_int_ext, cliente_id, tipo_asignacion_id, modulo_id,
             coordinador_id, consultor_responsable_id, consultor_principal_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING *`,
        [
          registroAsignacionId,
          horasReportadasNum,
          diasReportadosNum,
          totalCobrarNum,
          tipo_servicio || null,
          nro_caso_int_ext || null,
          info.id_cliente,
          info.id_tipo_asignacion,
          info.id_modulo,
          info.coordinador_responsable_id,
          consultorId,
          consultorPrincipalId,
          req.user?.id || consultorId
        ]
      );
    }

    const estados = await getEstadoAsignacionValues();
    await pool.query(
      `UPDATE registro_asignaciones
       SET estado = $2::tipo_estado_asignacion
       WHERE id = $1`,
      [registroAsignacionId, estados.proceso]
    );

    // Email al coordinador para aprobación
    const correoInfo = await pool.query(
      `SELECT
         ucoord.email AS coordinador_email,
         ucoord.nombre_usuario AS coordinador_nombre,
         ucons.nombre_usuario AS consultor_nombre,
         c.titulo AS cliente,
         ta.titulo AS tipo_asignacion
       FROM consultorias con
         JOIN clientes c ON con.id_cliente = c.id
         LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
         LEFT JOIN usuarios ucoord ON ucoord.id = con.coordinador_responsable_id
         LEFT JOIN usuarios ucons ON ucons.id = $2
       WHERE con.id = (
         SELECT id_consultoria FROM registro_asignaciones WHERE id = $1
       )`,
      [registroAsignacionId, consultorId]
    );
    const correoRow = correoInfo.rows[0];
    if (correoRow?.coordinador_email) {
      const portalUrl = buildPortalUrl("aprobar-rechazar-coordinador");
      await sendEmailSafe({
        ...getGraphContext(req),
        to: correoRow.coordinador_email,
        subject: `⏳ Aprobación pendiente: reporte de ${correoRow.consultor_nombre || "consultor"}`,
        text:
          `Hola ${correoRow.coordinador_nombre || ""},\n` +
          `El consultor ${correoRow.consultor_nombre || ""} reportó horas.\n` +
          `Cliente: ${correoRow.cliente}\n` +
          `Tipo: ${correoRow.tipo_asignacion || "N/A"}\n` +
          `Detalle: ${buildReporteResumen({ horas_reportadas: horasReportadasNum, cantidad_dias_reportados: diasReportadosNum, total_cobrar: totalCobrarNum })}\n` +
          `Revisar: ${portalUrl}\n`,
        html: buildEmailLayout({
          title: "Aprobación pendiente de reporte",
          intro: `Hola <strong>${correoRow.coordinador_nombre || "Coordinador"}</strong>, el consultor <strong>${correoRow.consultor_nombre || "N/A"}</strong> registró horas y requiere validación.`,
          blocks: [
            { label: "Cliente", value: correoRow.cliente || "N/A" },
            { label: "Tipo de asignación", value: correoRow.tipo_asignacion || "N/A" },
            { label: "Resumen", value: buildReporteResumen({ horas_reportadas: horasReportadasNum, cantidad_dias_reportados: diasReportadosNum, total_cobrar: totalCobrarNum }) }
          ],
          ctaLabel: "Revisar y aprobar",
          ctaUrl: portalUrl
        })
      });
    }

    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al reportar horas" });
  }
});

/* ===============================
   API - MESA/FÁBRICA
=============================== */

// Listar tickets mesa/fábrica del consultor
app.get("/mesa-fabrica", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  try {
    const userId = req.user?.id;
    const ocultarMonto = isAsociadoUser(req);
    const estados = await getEstadoAsignacionValues();
    const result = await pool.query(
      `
      SELECT
        ra.public_id AS id,
        ra.nro_caso_interno,
        ra.nro_caso_cliente,
        ra.estado,
        ra.aprobar_coordinador,
        ra.tipo_servicio,
        ra.observacion,
        ra.fecha_inicio,
        ra.fecha_fin,
        ra.valor_hora,
        ta.public_id AS tipo_asignacion_id,
        c.public_id AS cliente_id,
        c.titulo AS nombre_cliente,
        m.public_id AS modulo_id,
        m.titulo AS nombre_modulo,
        ta.titulo AS tipo_asignacion,
        coord.nombre_usuario AS nombre_coordinador,
        rh.estado_reporte AS estado_reporte,
        rh.motivo_rechazo,
        rh.total_cobrar,
        rh.horas_reportadas,
        rh.nro_caso_int_ext,
        rh.public_id AS reporte_id,
        rh.estado_mesa_servicio,
        rh.estado_fabrica,
        rh.observacion_mesa_fabrica,
        rh.fecha_cierre_mesa_fab,
        (SELECT cc.public_id FROM cuenta_cobro cc WHERE cc.id = rh.id_cuenta_cobro) AS id_cuenta_cobro,
        rh.requerimiento,
        rh.perfil_fabrica,
        rh.wricef
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        JOIN clientes c ON con.id_cliente = c.id
        LEFT JOIN usuarios coord ON con.coordinador_responsable_id = coord.id
        LEFT JOIN modulo m ON ra.id_modulo = m.id
        LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
        LEFT JOIN reporte_horas rh
          ON rh.id_registro_asignacion = ra.id
         AND rh.estado_reporte IN ('Revisión', 'Rechazado', 'Pendiente')
      WHERE ra.consultor_responsable_id = $1
        AND ra.estado IN ($2::tipo_estado_asignacion, $3::tipo_estado_asignacion)
        AND (
          COALESCE(con.id_tipo_asignacion, 0) IN (5, 6)
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) IN ('mesa de servicio', 'fabrica', 'fábrica')
        )
      ORDER BY ra.id DESC, rh.created_at DESC NULLS LAST, rh.id DESC
      `,
      [userId, estados.abierto, estados.proceso]
    );
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const ticketRows = rows.map((row) => applyTicketCaseFields(row));
    if (!ocultarMonto) {
      return res.json(ticketRows);
    }
    return res.json(ticketRows.map((row) => ({
      ...row,
      total_cobrar: null,
      valor_hora: null
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tickets" });
  }
});

// Enviar ticket mesa/fábrica a aprobación de coordinador
app.post("/mesa-fabrica/:id/enviar-aprobacion", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  const { id } = req.params;
  const {
    reporte_id,
    horas_reportadas,
    total_cobrar,
    tipo_servicio,
    nro_caso_int_ext,
    nro_caso_cliente,
    nro_caso_interno,
    observacion_mesa_fabrica,
    fecha_cierre_mesa_fab,
    estado_mesa_servicio,
    estado_fabrica,
    requerimiento,
    perfil_fabrica,
    wricef
  } = req.body || {};

  const client = await pool.connect();
  let txStarted = false;
  try {
    const ocultarMonto = isAsociadoUser(req);
    const registroId = await resolveInternalId(
      client,
      ID_TABLES.registroAsignaciones,
      id,
      { required: true }
    );
    const reporteId = await resolveInternalId(
      client,
      ID_TABLES.reporteHoras,
      reporte_id,
      { required: false }
    );
    await client.query("BEGIN");
    txStarted = true;
    const meta = await client.query(
      `
      SELECT
        ra.id,
        ra.estado AS estado_asignacion,
        ra.id_modulo,
        ra.id_consultoria,
        ra.nro_caso_cliente,
        ra.nro_caso_interno,
        ra.tipo_servicio AS ra_tipo_servicio,
        ra.observacion AS ra_observacion,
        ra.fecha_fin,
        ra.total_pagar,
        ra.consultor_responsable_id,
        ucons.id_consultor_principal AS consultor_principal_rel_id,
        con.id_cliente,
        con.id_tipo_asignacion,
        con.coordinador_responsable_id,
        ta.titulo AS tipo_asignacion_titulo
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
        LEFT JOIN usuarios ucons ON ucons.id = ra.consultor_responsable_id
      WHERE ra.id = $1
        AND ra.consultor_responsable_id = $2
      `,
      [registroId, req.user?.id]
    );
    if (!meta.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Ticket no encontrado" });
    }

    const info = meta.rows[0];
    const estadosAsignacion = await getEstadoAsignacionValues();
    if (!isAsignacionReportableEstado(info.estado_asignacion, estadosAsignacion)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La asignación está cerrada y no permite nuevos reportes." });
    }
    const consultorPrincipalId = info.consultor_principal_rel_id || null;
    const tipoAsignacionId = Number(info.id_tipo_asignacion || 0);
    const tipoAsignacionTitulo = String(info.tipo_asignacion_titulo || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
    const esMesaOFabrica =
      [5, 6].includes(tipoAsignacionId) ||
      ["mesa de servicio", "fabrica"].includes(tipoAsignacionTitulo);
    if (!esMesaOFabrica) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Solo Mesa/Fábrica se envía desde este módulo." });
    }
    const scope = getMesaFabricaScope(tipoAsignacionId, tipoAsignacionTitulo, {
      estado_mesa_servicio,
      estado_fabrica,
      tipo_servicio,
      nro_caso_cliente,
      nro_caso_interno,
      nro_caso_int_ext,
      requerimiento,
      perfil_fabrica,
      wricef
    });
    const estadosMesa = await getEstadoMesaValues();
    const estadosFabrica = await getEstadoFabricaValues();
    const estadoMesaNormalizado = resolveEstadoMesaInput(estado_mesa_servicio, estadosMesa);
    const estadoFabricaNormalizado = resolveEstadoFabricaInput(estado_fabrica, estadosFabrica);
    if (scope === "mesa" && estado_mesa_servicio && !estadoMesaNormalizado) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Estado de mesa de servicio inválido" });
    }
    if (scope === "fabrica" && estado_fabrica && !estadoFabricaNormalizado) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Estado de fábrica inválido" });
    }

    const editable = await client.query(
      `SELECT id, estado_reporte, nro_caso_int_ext
       FROM reporte_horas
       WHERE id_registro_asignacion = $1
         AND ($2::int IS NULL OR id = $2::int)
         AND estado_reporte IN ('Revisión', 'Rechazado')
       ORDER BY updated_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [registroId, reporteId || null]
    );
    const editableRow = editable.rows[0];
    const bodyCases = parseTicketCaseFields(nro_caso_int_ext);
    const editableCases = parseTicketCaseFields(editableRow?.nro_caso_int_ext);
    const finalNroCasoCliente =
      normalizeCaseValue(nro_caso_cliente) ||
      bodyCases.nro_caso_cliente ||
      editableCases.nro_caso_cliente ||
      normalizeCaseValue(info.nro_caso_cliente);
    const finalNroCasoInterno =
      normalizeCaseValue(nro_caso_interno) ||
      bodyCases.nro_caso_interno ||
      editableCases.nro_caso_interno ||
      normalizeCaseValue(info.nro_caso_interno);
    const finalNroCaso = serializeTicketCaseFields({
      nroCasoCliente: scope === "mesa" ? finalNroCasoCliente : null,
      nroCasoInterno: scope === "mesa" ? finalNroCasoInterno : null,
      nroCasoIntExtFallback: bodyCases.legacy
    });
    if (scope === "mesa" && (!finalNroCasoCliente || !finalNroCasoInterno)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Debes indicar Nro Caso Interno y Nro Caso Cliente para Mesa de servicio"
      });
    }

    const finalTipoServicio = normalizeTipoServicioInput(tipo_servicio || info.ra_tipo_servicio || "Servicio") || null;
    const finalObservacion = (observacion_mesa_fabrica || info.ra_observacion || "").toString().trim() || null;
    const finalFechaCierre = fecha_cierre_mesa_fab || info.fecha_fin || null;
    const finalHoras = toNullableNumber(horas_reportadas);
    const finalTotalInput = ocultarMonto ? null : toNullableNumber(total_cobrar);
    const finalTotal = finalTotalInput ?? info.total_pagar ?? null;
    const finalRequerimiento = (requerimiento || "").toString().trim() || null;
    const finalPerfilFabrica = normalizePerfilFabricaInput(perfil_fabrica);
    const finalWricef = (wricef || "").toString().trim() || null;
    if (scope === "fabrica" && perfil_fabrica && !finalPerfilFabrica) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Perfil de fábrica inválido" });
    }

    let saved;
    if (reporteId && editableRow) {
      saved = await client.query(
        `UPDATE reporte_horas
         SET horas_reportadas = COALESCE($1, horas_reportadas),
             total_cobrar = COALESCE($2, total_cobrar),
             tipo_servicio = COALESCE($3, tipo_servicio),
             nro_caso_int_ext = COALESCE($4, nro_caso_int_ext),
             observacion_mesa_fabrica = COALESCE($5, observacion_mesa_fabrica),
             fecha_cierre_mesa_fab = COALESCE($6, fecha_cierre_mesa_fab),
             estado_mesa_servicio = COALESCE($7, estado_mesa_servicio),
             estado_fabrica = COALESCE($8, estado_fabrica),
             requerimiento = COALESCE($9, requerimiento),
             perfil_fabrica = COALESCE($10, perfil_fabrica),
             wricef = COALESCE($11, wricef),
             cliente_id = COALESCE(cliente_id, $12),
             tipo_asignacion_id = COALESCE(tipo_asignacion_id, $13),
             modulo_id = COALESCE(modulo_id, $14),
             coordinador_id = COALESCE(coordinador_id, $15),
             consultor_responsable_id = COALESCE(consultor_responsable_id, $16),
             consultor_principal_id = COALESCE($17, consultor_principal_id),
             estado_reporte = 'Pendiente',
             motivo_rechazo = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $18
         RETURNING *`,
        [
          finalHoras,
          finalTotal,
          finalTipoServicio,
          finalNroCaso,
          finalObservacion,
          finalFechaCierre,
          scope === "mesa" ? estadoMesaNormalizado : null,
          scope === "fabrica" ? estadoFabricaNormalizado : null,
          finalRequerimiento,
          finalPerfilFabrica,
          finalWricef,
          info.id_cliente,
          info.id_tipo_asignacion,
          info.id_modulo,
          info.coordinador_responsable_id,
          info.consultor_responsable_id,
          consultorPrincipalId,
          editableRow.id
        ]
      );
    } else if (reporteId && !editableRow) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Solicitud no editable o no encontrada" });
    } else {
      const totalTickets = await client.query(
        `SELECT COUNT(1) AS total FROM reporte_horas WHERE id_registro_asignacion = $1`,
        [registroId]
      );
      const cantidadTickets = Number(totalTickets.rows[0]?.total || 0);
      if (cantidadTickets >= MAX_TICKETS_POR_ASIGNACION) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Máximo de ${MAX_TICKETS_POR_ASIGNACION} tickets por asignación alcanzado`
        });
      }
      saved = await client.query(
        `INSERT INTO reporte_horas
          (id_registro_asignacion, horas_reportadas, total_cobrar, tipo_servicio, nro_caso_int_ext,
           observacion_mesa_fabrica, fecha_cierre_mesa_fab, estado_mesa_servicio, estado_fabrica,
           requerimiento, perfil_fabrica, wricef, cliente_id, tipo_asignacion_id, modulo_id, coordinador_id,
           consultor_responsable_id, consultor_principal_id, created_by, estado_reporte)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'Pendiente')
          RETURNING *`,
        [
          registroId,
          finalHoras,
          finalTotal,
          finalTipoServicio,
          finalNroCaso,
          finalObservacion,
          finalFechaCierre,
          scope === "mesa" ? estadoMesaNormalizado : null,
          scope === "fabrica" ? estadoFabricaNormalizado : null,
          finalRequerimiento,
          finalPerfilFabrica,
          finalWricef,
          info.id_cliente,
          info.id_tipo_asignacion,
          info.id_modulo,
          info.coordinador_responsable_id,
          info.consultor_responsable_id,
          consultorPrincipalId,
          req.user?.id || info.consultor_responsable_id
        ]
      );
    }

    const estados = await getEstadoAsignacionValues();
    await client.query(
      `UPDATE registro_asignaciones
       SET aprobar_coordinador = 'Pendiente'::tipo_aprobacion,
           estado = $2::tipo_estado_asignacion
       WHERE id = $1`,
      [registroId, estados.proceso]
    );

    await client.query("COMMIT");

    // Notificar coordinador
    const correoInfo = await pool.query(
      `SELECT
         ucoord.email AS coordinador_email,
         ucoord.nombre_usuario AS coordinador_nombre,
         ucons.nombre_usuario AS consultor_nombre,
         c.titulo AS cliente,
         ta.titulo AS tipo_asignacion
       FROM consultorias con
         JOIN clientes c ON con.id_cliente = c.id
         LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
         LEFT JOIN usuarios ucoord ON ucoord.id = con.coordinador_responsable_id
         LEFT JOIN usuarios ucons ON ucons.id = $2
       WHERE con.id = $1`,
      [info.id_consultoria, info.consultor_responsable_id]
    );
    const correoRow = correoInfo.rows[0];
    if (correoRow?.coordinador_email) {
      const portalUrl = buildPortalUrl("aprobar-rechazar-coordinador");
      await sendEmailSafe({
        ...getGraphContext(req),
        to: correoRow.coordinador_email,
        subject: `⏳ Ticket enviado a aprobación: ${correoRow.consultor_nombre || "consultor"}`,
        text:
          `Hola ${correoRow.coordinador_nombre || ""},\n` +
          `El consultor ${correoRow.consultor_nombre || ""} envió un ticket de Mesa/Fábrica.\n` +
          `Cliente: ${correoRow.cliente}\n` +
          `Tipo: ${correoRow.tipo_asignacion || "N/A"}\n` +
          `Detalle: ${buildReporteResumen(saved.rows[0] || {})}\n` +
          `Revisar: ${portalUrl}\n`
      });
    }

    const savedRow = withPublicId(saved.rows[0] || {});
    if (ocultarMonto) savedRow.total_cobrar = null;
    res.json(savedRow);
  } catch (err) {
    if (txStarted) {
      await client.query("ROLLBACK");
    }
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Ticket o reporte no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al enviar ticket a aprobación" });
  } finally {
    client.release();
  }
});

// Actualizar ticket mesa/fábrica
app.put("/mesa-fabrica/:id", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  const { id } = req.params;
  const {
    reporte_id,
    nro_caso_int_ext,
    nro_caso_interno,
    nro_caso_cliente,
    tipo_servicio,
    estado,
    estado_ticket,
    estado_mesa_servicio,
    estado_fabrica,
    observacion,
    requerimiento,
    perfil_fabrica,
    wricef,
    fecha_inicio,
    fecha_cierre,
    horas_reportadas,
    total_cobrar
  } = req.body;

  try {
    const ocultarMonto = isAsociadoUser(req);
    const registroId = await resolveInternalId(
      pool,
      ID_TABLES.registroAsignaciones,
      id,
      { required: true }
    );
    const reporteId = await resolveInternalId(
      pool,
      ID_TABLES.reporteHoras,
      reporte_id,
      { required: false }
    );
    const tipoValido = await pool.query(
      `
      SELECT
        con.id_tipo_asignacion,
        ta.titulo AS tipo_asignacion_titulo,
        ra.estado AS estado_asignacion,
        ra.id_modulo,
        ra.id_consultoria,
        ra.valor_hora,
        con.id_cliente,
        con.coordinador_responsable_id,
        ra.consultor_responsable_id,
        ucons.id_consultor_principal AS consultor_principal_rel_id
      FROM registro_asignaciones ra
        JOIN consultorias con ON con.id = ra.id_consultoria
        LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
        LEFT JOIN usuarios ucons ON ucons.id = ra.consultor_responsable_id
      WHERE ra.id = $1
        AND ra.consultor_responsable_id = $2
      `,
      [registroId, req.user?.id]
    );
    if (!tipoValido.rows.length) {
      return res.status(404).json({ error: "Ticket no encontrado" });
    }
    const estadosAsignacion = await getEstadoAsignacionValues();
    if (!isAsignacionReportableEstado(tipoValido.rows[0]?.estado_asignacion, estadosAsignacion)) {
      return res.status(400).json({ error: "La asignación está cerrada y no permite nuevos reportes." });
    }
    const tipoAsignacionId = Number(tipoValido.rows[0]?.id_tipo_asignacion || 0);
    const tipoAsignacionTitulo = String(tipoValido.rows[0]?.tipo_asignacion_titulo || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
    const esMesaOFabrica =
      [5, 6].includes(tipoAsignacionId) ||
      ["mesa de servicio", "fabrica"].includes(tipoAsignacionTitulo);
    if (!esMesaOFabrica) {
      return res.status(400).json({ error: "Solo se permite actualizar tickets de Mesa/Fábrica en este módulo." });
    }
    const scope = getMesaFabricaScope(tipoAsignacionId, tipoAsignacionTitulo, {
      estado_mesa_servicio,
      estado_fabrica,
      tipo_servicio,
      nro_caso_cliente,
      nro_caso_interno,
      requerimiento,
      perfil_fabrica,
      wricef
    });

    const estados = await getEstadoAsignacionValues();
    const estadoNormalizado = resolveEstadoAsignacionInput(estado, estados);
    if (estado && !estadoNormalizado) {
      return res.status(400).json({ error: "Estado de ticket inválido" });
    }
    const tipoServicioNormalizado = normalizeTipoServicioInput(tipo_servicio);
    if (tipo_servicio && !tipoServicioNormalizado) {
      return res.status(400).json({ error: "Tipo de servicio inválido" });
    }
    const estadoMesaRaw = estado_mesa_servicio || (scope === "mesa" ? estado_ticket : null);
    const estadoFabricaRaw = estado_fabrica || (scope === "fabrica" ? estado_ticket : null);
    const estadosMesa = await getEstadoMesaValues();
    const estadosFabrica = await getEstadoFabricaValues();
    const estadoMesaNormalizado = resolveEstadoMesaInput(estadoMesaRaw, estadosMesa);
    const estadoFabricaNormalizado = resolveEstadoFabricaInput(estadoFabricaRaw, estadosFabrica);
    if (scope === "mesa" && estadoMesaRaw && !estadoMesaNormalizado) {
      return res.status(400).json({ error: "Estado de mesa de servicio inválido" });
    }
    if (scope === "fabrica" && estadoFabricaRaw && !estadoFabricaNormalizado) {
      return res.status(400).json({ error: "Estado de fábrica inválido" });
    }

    const result = await pool.query(
      `
      UPDATE registro_asignaciones
      SET estado = COALESCE($1::tipo_estado_asignacion, estado)
      WHERE id = $2
        AND consultor_responsable_id = $3
      RETURNING *
      `,
      [
        estadoNormalizado,
        registroId,
        req.user?.id
      ]
    );

    const finalHoras = toNullableNumber(horas_reportadas);
    const finalTotalInput = ocultarMonto ? null : toNullableNumber(total_cobrar);
    const finalTotal = finalTotalInput ??
      ((finalHoras !== null && finalHoras !== undefined && tipoValido.rows[0]?.valor_hora !== null && tipoValido.rows[0]?.valor_hora !== undefined)
        ? Number(finalHoras) * Number(tipoValido.rows[0].valor_hora)
        : null);
    const finalRequerimiento = (requerimiento || "").toString().trim() || null;
    const finalPerfilFabrica = normalizePerfilFabricaInput(perfil_fabrica);
    const finalWricef = (wricef || "").toString().trim() || null;
    const consultorPrincipalId = tipoValido.rows[0]?.consultor_principal_rel_id || null;
    if (scope === "fabrica" && perfil_fabrica && !finalPerfilFabrica) {
      return res.status(400).json({ error: "Perfil de fábrica inválido" });
    }
    const editable = await pool.query(
      `SELECT id, nro_caso_int_ext
       FROM reporte_horas
       WHERE id_registro_asignacion = $1
         AND ($2::int IS NULL OR id = $2::int)
         AND estado_reporte IN ('Revisión', 'Rechazado')
       ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 1`,
      [registroId, reporteId || null]
    );
    const bodyCases = parseTicketCaseFields(nro_caso_int_ext);
    const editableCases = parseTicketCaseFields(editable.rows[0]?.nro_caso_int_ext);
    const finalNroCasoCliente =
      normalizeCaseValue(nro_caso_cliente) ||
      bodyCases.nro_caso_cliente ||
      editableCases.nro_caso_cliente;
    const finalNroCasoInterno =
      normalizeCaseValue(nro_caso_interno) ||
      bodyCases.nro_caso_interno ||
      editableCases.nro_caso_interno;
    const finalNroCaso = serializeTicketCaseFields({
      nroCasoCliente: scope === "mesa" ? finalNroCasoCliente : null,
      nroCasoInterno: scope === "mesa" ? finalNroCasoInterno : null,
      nroCasoIntExtFallback: bodyCases.legacy
    });
    if (scope === "mesa" && (!finalNroCasoCliente || !finalNroCasoInterno)) {
      return res.status(400).json({
        error: "Debes indicar Nro Caso Interno y Nro Caso Cliente para Mesa de servicio"
      });
    }
    if (!reporteId) {
      const totalTickets = await pool.query(
        `SELECT COUNT(1) AS total
         FROM reporte_horas
         WHERE id_registro_asignacion = $1`,
        [registroId]
      );
      const cantidadTickets = Number(totalTickets.rows[0]?.total || 0);
      if (cantidadTickets >= MAX_TICKETS_POR_ASIGNACION) {
        return res.status(400).json({
          error: `Máximo de ${MAX_TICKETS_POR_ASIGNACION} tickets por asignación alcanzado`
        });
      }
    }
    if (reporteId && editable.rows.length > 0) {
      await pool.query(
        `UPDATE reporte_horas
         SET horas_reportadas = COALESCE($1, horas_reportadas),
             total_cobrar = COALESCE($2, total_cobrar),
             tipo_servicio = COALESCE($3, tipo_servicio),
             nro_caso_int_ext = COALESCE($4, nro_caso_int_ext),
             observacion_mesa_fabrica = COALESCE($5, observacion_mesa_fabrica),
             fecha_cierre_mesa_fab = COALESCE($6, fecha_cierre_mesa_fab),
             estado_mesa_servicio = COALESCE($7, estado_mesa_servicio),
              estado_fabrica = COALESCE($8, estado_fabrica),
              requerimiento = COALESCE($9, requerimiento),
              perfil_fabrica = COALESCE($10, perfil_fabrica),
              wricef = COALESCE($11, wricef),
              consultor_principal_id = COALESCE($12, consultor_principal_id),
              updated_at = CURRENT_TIMESTAMP
         WHERE id = $13`,
        [
          finalHoras,
          finalTotal,
          tipoServicioNormalizado,
          finalNroCaso,
          observacion || null,
          fecha_cierre || null,
          scope === "mesa" ? estadoMesaNormalizado : null,
          scope === "fabrica" ? estadoFabricaNormalizado : null,
          finalRequerimiento,
          finalPerfilFabrica,
          finalWricef,
          consultorPrincipalId,
          editable.rows[0].id
        ]
      );
    } else if (reporteId && editable.rows.length === 0) {
      return res.status(404).json({ error: "Solicitud no editable o no encontrada" });
    } else {
      await pool.query(
        `INSERT INTO reporte_horas
          (id_registro_asignacion, horas_reportadas, total_cobrar, tipo_servicio, nro_caso_int_ext,
           observacion_mesa_fabrica, fecha_cierre_mesa_fab, estado_mesa_servicio, estado_fabrica,
           requerimiento, perfil_fabrica, wricef, cliente_id, tipo_asignacion_id, modulo_id, coordinador_id,
           consultor_responsable_id, consultor_principal_id, created_by, estado_reporte)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'Revisión')`,
        [
          registroId,
          finalHoras,
          finalTotal,
          tipoServicioNormalizado,
          finalNroCaso,
          observacion || null,
          fecha_cierre || null,
          scope === "mesa" ? estadoMesaNormalizado : null,
          scope === "fabrica" ? estadoFabricaNormalizado : null,
          finalRequerimiento,
          finalPerfilFabrica,
          finalWricef,
          tipoValido.rows[0]?.id_cliente || null,
          tipoValido.rows[0]?.id_tipo_asignacion || null,
          tipoValido.rows[0]?.id_modulo || null,
          tipoValido.rows[0]?.coordinador_responsable_id || null,
          tipoValido.rows[0]?.consultor_responsable_id || req.user?.id || null,
          consultorPrincipalId,
          req.user?.id || null
        ]
      );
    }
    res.json(withPublicId(result.rows[0] || {}));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Ticket o reporte no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar ticket" });
  }
});

/* ===============================
   API - CUENTAS DE COBRO
=============================== */

// Registros aprobados por cobrar
app.get("/horas-por-cobrar/:consultorId", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"], tipos: ["Asociado"] }), async (req, res) => {
  const { consultorId } = req.params;
  try {
    const consultorInternalId = await resolveInternalId(pool, ID_TABLES.usuarios, consultorId, { required: true });
    const role = normalizeValue(req.user?.rol);
    if (!["administrador", "coordinador"].includes(role) && String(req.user?.id) !== String(consultorInternalId)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (!consultorInternalId) return res.json([]);
    const result = await pool.query(
      `
      SELECT
        rh.public_id AS id,
        rh.total_cobrar,
        rh.horas_reportadas,
        rh.cantidad_dias_reportados,
        rh.created_at,
        rh.nro_caso_int_ext,
        rh.requerimiento,
        c.titulo AS cliente,
        ta.titulo AS tipo_asignacion
      FROM reporte_horas rh
        LEFT JOIN clientes c ON rh.cliente_id = c.id
        LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
      WHERE rh.estado_reporte = 'Aprobado'
        AND rh.id_cuenta_cobro IS NULL
        AND (
          rh.consultor_responsable_id = $1
          OR rh.consultor_principal_id = $1
          OR rh.consultor_responsable_id IN (
            SELECT u.id
            FROM usuarios u
            WHERE u.activo = true
              AND u.id_consultor_principal = $1
          )
        )
      ORDER BY rh.id DESC
      `,
      [consultorInternalId]
    );
    res.json(result.rows);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.json([]);
    console.error(err);
    res.status(500).json({ error: "Error al obtener registros por cobrar" });
  }
});

// Vista previa de cuenta de cobro (total + letras)
app.post("/cuentas-cobro/preview", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  const { consultor_id, ids_reportes } = req.body;

  if (!consultor_id || !Array.isArray(ids_reportes) || ids_reportes.length === 0) {
    return res.status(400).json({ error: "Faltan datos para previsualizar" });
  }

  try {
    const consultorId = await resolveInternalId(pool, ID_TABLES.usuarios, consultor_id, { required: true });
    const reporteIds = await resolveInternalIds(pool, ID_TABLES.reporteHoras, ids_reportes);
    if (normalizeValue(req.user?.tipo_consultor) === "asociado") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (String(req.user?.id) !== String(consultorId)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    // 1. Obtener moneda del consultor
    const monedaRes = await pool.query(
      "SELECT moneda_cobro FROM usuarios WHERE id = $1",
      [consultorId]
    );
    const moneda = monedaRes.rows[0]?.moneda_cobro || "COP";

    // 2. Calcular totales y fechas
    const meta = await pool.query(
      `SELECT
        COUNT(*) AS count,
        COALESCE(SUM(total_cobrar), 0) AS total,
        MIN(created_at)::date AS min_fecha,
        MAX(created_at)::date AS max_fecha
      FROM reporte_horas
      WHERE id = ANY($1)
        AND estado_reporte = 'Aprobado'
        AND id_cuenta_cobro IS NULL
        AND (
          consultor_responsable_id = $2
          OR consultor_principal_id = $2
          OR consultor_responsable_id IN (
            SELECT u.id
            FROM usuarios u
            WHERE u.activo = true
              AND u.id_consultor_principal = $2
          )
        )`,
      [reporteIds, consultorId]
    );

    const info = meta.rows[0];

    // 3. Validar que todos los registros sean vÁ¡lidos
    if (Number(info.count) !== ids_reportes.length) {
      return res.status(400).json({
        error: "Algunos registros no son válidos para cobro"
      });
    }

    // 4. Convertir a letras
    const total = Number(info.total || 0);
    const total_letras = buildTotalLetras(total, moneda);

    // 5. Retornar respuesta
    res.json({
      total: total,
      total_letras: total_letras,
      moneda: moneda,
      fecha_inicio: info.min_fecha,
      fecha_fin: info.max_fecha
    });

  } catch (error) {
    if (error?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(400).json({ error: "Consultor o reportes inválidos para previsualizar" });
    }
    console.error('[ERROR] Error en /cuentas-cobro/preview:', error);
    res.status(500).json({ error: "Error al calcular preview" });
  }
});

// Crear cuenta de cobro
app.post("/cuentas-cobro", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  const { consultor_id, fecha_inicio, fecha_fin, total_letras, ciudad_cobro, total_numeros, ids_reportes } = req.body;
  if (!consultor_id || !fecha_inicio || !fecha_fin || !total_letras || !ciudad_cobro || !Array.isArray(ids_reportes) || ids_reportes.length === 0) {
    return res.status(400).json({ error: "Faltan datos para generar la cuenta" });
  }

  const client = await pool.connect();
  let txStarted = false;
  try {
    const consultorId = await resolveInternalId(client, ID_TABLES.usuarios, consultor_id, { required: true });
    const reporteIds = await resolveInternalIds(client, ID_TABLES.reporteHoras, ids_reportes);
    if (normalizeValue(req.user?.tipo_consultor) === "asociado") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (String(req.user?.id) !== String(consultorId)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    await client.query("BEGIN");
    txStarted = true;

    const meta = await client.query(
      `
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(total_cobrar), 0) AS total,
        MIN(created_at)::date AS min_fecha,
        MAX(created_at)::date AS max_fecha
      FROM reporte_horas
      WHERE id = ANY($1)
        AND estado_reporte = 'Aprobado'
        AND id_cuenta_cobro IS NULL
        AND (
          consultor_responsable_id = $2
          OR consultor_principal_id = $2
          OR consultor_responsable_id IN (
            SELECT u.id
            FROM usuarios u
            WHERE u.activo = true
              AND u.id_consultor_principal = $2
          )
        )
      `,
      [reporteIds, consultorId]
    );

    const info = meta.rows[0];
    if (Number(info.count) !== ids_reportes.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Algunos registros no son v¡lidos para cobro" });
    }

    if (total_numeros !== undefined && Number(total_numeros) !== Number(info.total || 0)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El total no coincide con los reportes aprobados" });
    }

    const monedaRes = await client.query(
      "SELECT moneda_cobro FROM usuarios WHERE id = $1",
      [consultorId]
    );
    const moneda = monedaRes.rows[0]?.moneda_cobro || "COP";
    const totalLetrasFinal = buildTotalLetras(Number(info.total || 0), moneda);
    const descripcionFinal =
      (typeof req.body.descripcion === "string" && req.body.descripcion.trim()) ||
      `Cuenta de cobro ${fecha_inicio} - ${fecha_fin}`;

    const insert = await client.query(
      `
      INSERT INTO cuenta_cobro
        (descripcion, fecha_correspondiente, fecha_periodo_inicio, fecha_periodo_fin, total_cuenta_cobro, total_letras, ciudad_cobro, created_by)
      VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        descripcionFinal,
        fecha_inicio,
        fecha_fin,
        info.total,
        totalLetrasFinal,
        ciudad_cobro,
        consultorId
      ]
    );

    const cuentaId = insert.rows[0].id;

    await client.query(
      `
      UPDATE reporte_horas
      SET id_cuenta_cobro = $1
      WHERE id = ANY($2)
      `,
      [cuentaId, reporteIds]
    );

    const estados = await getEstadoAsignacionValues();
    await client.query(
      `
      UPDATE registro_asignaciones ra
      SET estado = $2::tipo_estado_asignacion
      FROM consultorias con
      LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
      WHERE ra.id_consultoria = con.id
        AND ra.id IN (
          SELECT id_registro_asignacion
          FROM reporte_horas
          WHERE id = ANY($1)
        )
        AND NOT (
          COALESCE(con.id_tipo_asignacion, 0) IN (5, 6)
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) IN ('mesa de servicio', 'fabrica', 'fábrica')
        )
      `,
      [reporteIds, estados.cerrado]
    );

    await client.query("COMMIT");

    // Email a contabilidad
    const cuenta = insert.rows[0];
    const contabilidadEmail = process.env.EMAIL_TO_CONTABILIDAD || "";
    if (contabilidadEmail) {
      const userInfo = await pool.query(
        `SELECT nombre_usuario, email
         FROM usuarios
         WHERE id = $1`,
        [consultorId]
      );
      const consultor = userInfo.rows[0];
      await sendEmailSafe({
        ...getGraphContext(req),
        to: contabilidadEmail,
        subject: `Nueva cuenta de cobro #${cuenta.public_id || cuenta.id}`,
        text:
          `Se generó una cuenta de cobro.\n` +
          `Consultor: ${consultor?.nombre_usuario || ""} (${consultor?.email || ""})\n` +
          `Periodo: ${cuenta.fecha_periodo_inicio} a ${cuenta.fecha_periodo_fin}\n` +
          `Total: ${cuenta.total_cuenta_cobro}\n` +
          `Descripción: ${cuenta.descripcion || ""}\n`
      });
    }

    res.json({
      ok: true,
      cuenta: {
        ...cuenta,
        id: cuenta.public_id || String(cuenta.id || "")
      }
    });
  } catch (err) {
    if (txStarted) {
      await client.query("ROLLBACK");
    }
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(400).json({ error: "Consultor o reportes inválidos para crear la cuenta" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al generar cuenta de cobro" });
  } finally {
    client.release();
  }
});

// Historial de cuentas de cobro por usuario
app.get("/cuentas-cobro/historial/:userId", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"], tipos: ["Asociado"] }), async (req, res) => {
  const { userId } = req.params;
  const { fecha_inicio, fecha_fin } = req.query;
  try {
    const consultorId = await resolveInternalId(pool, ID_TABLES.usuarios, userId, { required: true });
    const role = normalizeValue(req.user?.rol);
    if (!["administrador", "coordinador"].includes(role) && String(req.user?.id) !== String(consultorId)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (!consultorId) return res.json([]);
    const params = [consultorId];
    let whereFecha = "";
    if (fecha_inicio && fecha_fin) {
      params.push(fecha_inicio, fecha_fin);
      whereFecha = "AND cc.fecha_correspondiente BETWEEN $2 AND $3";
    }
    const result = await pool.query(
      `
      SELECT
        cc.public_id AS id,
        COALESCE(NULLIF(cc.descripcion, ''), 'Cuenta de cobro') AS descripcion,
        cc.fecha_correspondiente,
        cc.fecha_periodo_inicio AS fecha_inicio_periodo,
        cc.fecha_periodo_fin AS fecha_fin_periodo,
        cc.total_cuenta_cobro AS total_numeros,
        cc.total_letras,
        cc.estado,
        cc.datos_adjuntos,
        cc.created_at
      FROM cuenta_cobro cc
      WHERE cc.created_by = $1
        ${whereFecha}
      ORDER BY cc.id DESC
      `,
      params
    );
    res.json(result.rows);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.json([]);
    console.error(err);
    res.status(500).json({ error: "Error al obtener historial de cobros" });
  }
});

// Soportes cargados de cuentas de cobro (solo admin/coordinador)
app.get("/cuentas-cobro/soportes", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { consultor_id } = req.query || {};
  try {
    const consultorId = await resolveInternalId(pool, ID_TABLES.usuarios, consultor_id, { required: false });
    const result = await pool.query(
      `
      SELECT
        cc.public_id AS id,
        cc.created_at,
        cc.fecha_periodo_inicio AS fecha_inicio_periodo,
        cc.fecha_periodo_fin AS fecha_fin_periodo,
        cc.descripcion,
        cc.total_cuenta_cobro AS total_numeros,
        u.public_id AS consultor_id,
        u.nombre_usuario AS consultor_nombre,
        u.email AS consultor_email,
        cc.datos_adjuntos
      FROM cuenta_cobro cc
        JOIN usuarios u ON u.id = cc.created_by
      WHERE cc.datos_adjuntos IS NOT NULL
        AND (
          cc.datos_adjuntos ? 'soportes'
          OR cc.datos_adjuntos #> '{firma,documento_firmado}' IS NOT NULL
        )
        AND ($1::int IS NULL OR cc.created_by = $1)
      ORDER BY cc.id DESC
      `,
      [consultorId || null]
    );
    res.json(result.rows || []);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.json([]);
    console.error(err);
    res.status(500).json({ error: "Error al obtener soportes de cuentas de cobro" });
  }
});

// Detalle de cuenta de cobro
app.get("/cuentas-cobro/detalle/:cuentaId", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"], tipos: ["Asociado"] }), async (req, res) => {
  const { cuentaId } = req.params;
  try {
    const cuentaInternalId = await resolveInternalId(pool, ID_TABLES.cuentaCobro, cuentaId, { required: true });
    const role = normalizeValue(req.user?.rol);
    if (!["administrador", "coordinador"].includes(role)) {
      const owner = await pool.query(
        "SELECT created_by FROM cuenta_cobro WHERE id = $1",
        [cuentaInternalId]
      );
      const createdBy = owner.rows[0]?.created_by;
      if (!createdBy || String(createdBy) !== String(req.user?.id)) {
        return res.status(403).json({ error: "Acceso denegado" });
      }
    }
    const result = await pool.query(
      `
        SELECT
          rh.public_id AS id,
          c.titulo AS cliente,
          m.titulo AS modulo,
          ta.titulo AS tipo_asignacion,
          u.nombre_usuario AS consultor_responsable,
          rh.nro_caso_int_ext,
          rh.horas_reportadas,
          rh.cantidad_dias_reportados,
          rh.total_cobrar
        FROM reporte_horas rh
          LEFT JOIN clientes c ON rh.cliente_id = c.id
          LEFT JOIN modulo m ON rh.modulo_id = m.id
          LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
          LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
      WHERE rh.id_cuenta_cobro = $1
      ORDER BY rh.id DESC
      `,
      [cuentaInternalId]
    );
    res.json(result.rows);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al obtener detalle de cuenta" });
  }
});

// Subir adjuntos (cuenta firmada + seguridad social)
app.post("/cuentas-cobro/:id/adjuntos", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"], tipos: ["Asociado"] }), async (req, res) => {
  const { id } = req.params;
  const {
    cuenta_pdf_nombre,
    cuenta_pdf_base64,
    seguridad_social_nombre,
    seguridad_social_base64
  } = req.body || {};

  if (!cuenta_pdf_base64 || !seguridad_social_base64) {
    return res.status(400).json({ error: "Debe adjuntar ambos archivos en PDF." });
  }

  if (!ONEDRIVE_ENABLED) {
    return res.status(503).json({ error: "Servicio de carga no disponible temporalmente." });
  }

  let graphStage = "init";
  try {
    const cuentaInternalId = await resolveInternalId(pool, ID_TABLES.cuentaCobro, id, { required: true });
    const ownerResult = await pool.query(
      `
      SELECT
        cc.id,
        cc.public_id,
        cc.created_by,
        cc.fecha_correspondiente,
        cc.created_at,
        cc.datos_adjuntos,
        u.nombre_usuario
      FROM cuenta_cobro cc
      JOIN usuarios u ON u.id = cc.created_by
      WHERE cc.id = $1
      `,
      [cuentaInternalId]
    );

    const cuenta = ownerResult.rows[0];
    if (!cuenta) return res.status(404).json({ error: "Cuenta de cobro no encontrada." });

    const role = normalizeValue(req.user?.rol);
    if (!["administrador", "coordinador"].includes(role) && String(cuenta.created_by) !== String(req.user?.id)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }

    const cuentaPdfBuffer = parsePdfDataUrl(cuenta_pdf_base64);
    const seguridadPdfBuffer = parsePdfDataUrl(seguridad_social_base64);

    if (!isPdfBuffer(cuentaPdfBuffer) || !isPdfBuffer(seguridadPdfBuffer)) {
      return res.status(400).json({ error: "Los archivos adjuntos deben estar en formato PDF válido." });
    }

    const maxSize = 8 * 1024 * 1024;
    if (cuentaPdfBuffer.length > maxSize || seguridadPdfBuffer.length > maxSize) {
      return res.status(400).json({ error: "Cada archivo debe pesar máximo 8MB." });
    }

    let token = null;
    try {
      token = await getGraphAccessToken();
    } catch (tokenErr) {
      const delegated = String(req?.headers?.["x-graph-access-token"] || "").trim();
      if (!delegated) throw tokenErr;
      token = delegated;
    }
    const encodedUser = encodeURIComponent(ONEDRIVE_TARGET_USER);
    graphStage = "graph-drive-check";
    await graphGet(`/v1.0/users/${encodedUser}/drive`, token);

    const fechaBase = String(cuenta.fecha_correspondiente || cuenta.created_at || new Date().toISOString()).slice(0, 10);
    const consultorFolder = sanitizePathSegment(cuenta.nombre_usuario || `Consultor_${cuenta.created_by}`, `Consultor_${cuenta.created_by}`);
    const cuentaFolderToken = String(cuenta.public_id || cuenta.id).split("-")[0];
    const cuentaFolderName = `CuentaCobro_${cuentaFolderToken}_${fechaBase}`;

    let targetPath = sanitizePathSegment(ONEDRIVE_ROOT_FOLDER, "AdjuntosCuentasCobro");
    graphStage = "ensure-root-folder";
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, "", targetPath);
    graphStage = "ensure-consultor-folder";
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, consultorFolder);
    graphStage = "ensure-cuenta-folder";
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, cuentaFolderName);

    const cuentaFileName = sanitizePdfFileName(
      cuenta_pdf_nombre || `CuentaCobroFirmada_${cuentaFolderToken}.pdf`,
      `CuentaCobroFirmada_${cuentaFolderToken}.pdf`
    );
    const seguridadFileName = sanitizePdfFileName(
      seguridad_social_nombre || `SeguridadSocial_${cuentaFolderToken}.pdf`,
      `SeguridadSocial_${cuentaFolderToken}.pdf`
    );

    const cuentaPath = `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(`${targetPath}/${cuentaFileName}`)}:/content`;
    const seguridadPath = `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(`${targetPath}/${seguridadFileName}`)}:/content`;

    graphStage = "upload-files";
    const [cuentaUpload, seguridadUpload] = await Promise.all([
      graphPutBinary(cuentaPath, token, cuentaPdfBuffer, "application/pdf"),
      graphPutBinary(seguridadPath, token, seguridadPdfBuffer, "application/pdf")
    ]);

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
      ? cuenta.datos_adjuntos
      : {};

    const adjuntos = {
      ...prevAdjuntos,
      soportes: {
        carpeta: targetPath,
        actualizado_en: new Date().toISOString(),
        cuenta_cobro_original: {
          id: cuentaUpload.id,
          nombre: cuentaUpload.name,
          url: cuentaUpload.webUrl
        },
        cuenta_cobro: {
          id: cuentaUpload.id,
          nombre: cuentaUpload.name,
          url: cuentaUpload.webUrl
        },
        seguridad_social: {
          id: seguridadUpload.id,
          nombre: seguridadUpload.name,
          url: seguridadUpload.webUrl
        }
      }
    };

    await pool.query(
      `
      UPDATE cuenta_cobro
      SET datos_adjuntos = $1::jsonb,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [JSON.stringify(adjuntos), cuentaInternalId]
    );

    res.json({
      ok: true,
      mensaje: "Soportes cargados exitosamente",
      soportes: adjuntos.soportes
    });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ ok: false, error: "Cuenta de cobro no encontrada." });
    }
    const status = parseGraphErrorStatus(err.message);
    console.error("Error cargando adjuntos de cuenta:", err.message, "stage:", graphStage);

    if (status === 401 || status === 403) {
      return res.status(502).json({
        ok: false,
        error: "Servicio de almacenamiento no autorizado. Contacte a soporte."
      });
    }

    if (status === 404) {
      return res.status(502).json({
        ok: false,
        error: "No se encontró el repositorio de archivos configurado. Contacte a soporte."
      });
    }

    res.status(500).json({
      ok: false,
      error: "Error al cargar el archivo. Por favor verifique su conexión o intente más tarde."
    });
  }
});

// Descargar PDF de cuenta de cobro
app.get("/cuentas-cobro/:id/pdf", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"], tipos: ["Asociado"] }), async (req, res) => {
  const { id } = req.params;
  try {
    const cuentaInternalId = await resolveInternalId(pool, ID_TABLES.cuentaCobro, id, { required: true });
    await assertCuentaCobroOwnerAccess(cuentaInternalId, req);
    const { cuenta, detalles } = await getCuentaCobroPdfContext(cuentaInternalId);
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });

    res.setHeader("Content-Type", "application/pdf");
    const publicIdForFile = cuenta.public_id || id;
    res.setHeader("Content-Disposition", `attachment; filename="CuentaCobro_${publicIdForFile}.pdf"`);

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);
    writeCuentaCobroPdf(doc, cuenta, detalles);
    doc.end();
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }
    if (err?.code === "ACCESS_DENIED") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al generar PDF" });
  }
});

app.post("/cuentas-cobro/:id/firma/iniciar", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"], tipos: ["Asociado"] }), async (req, res) => {
  const { id } = req.params;
  if (!isClickSignConfigured()) {
    return res.status(503).json({
      error: "Click&Sign no esta configurado. Falta CLICKSIGN_API_KEY, CLICKSIGN_USER o CLICKSIGN_CONFIG_ID."
    });
  }

  try {
    const cuentaInternalId = await resolveInternalId(pool, ID_TABLES.cuentaCobro, id, { required: true });
    await assertCuentaCobroOwnerAccess(cuentaInternalId, req);

    const { cuenta, detalles } = await getCuentaCobroPdfContext(cuentaInternalId);
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });
    if (!cuenta.email) {
      return res.status(400).json({
        error: "El consultor no tiene correo para iniciar firma digital."
      });
    }

    const firmaExistente =
      cuenta.datos_adjuntos &&
        typeof cuenta.datos_adjuntos === "object" &&
        cuenta.datos_adjuntos.firma &&
        typeof cuenta.datos_adjuntos.firma === "object"
        ? cuenta.datos_adjuntos.firma
        : null;
    const forceRestart = String(req.body?.force || "").toLowerCase() === "true" || req.body?.force === true;
    const firmaEstado = String(firmaExistente?.estado || "").toLowerCase().trim();
    if (
      !forceRestart &&
      firmaExistente?.url_firma &&
      ["pending", "in_progress", "en_firma", "started", "sent"].includes(firmaEstado)
    ) {
      return res.json({
        ok: true,
        reused: true,
        cuenta_id: String(cuenta.public_id || cuenta.id || ""),
        request_id: firmaExistente.request_id || null,
        contract_id: firmaExistente.contract_id || null,
        url_firma: firmaExistente.url_firma
      });
    }

    const pdfBuffer = await generateCuentaCobroPdfBuffer(cuenta, detalles);
    const cuentaPublicId = String(cuenta.public_id || "");
    const requestId = `CC-${cuentaPublicId || cuenta.id}-${Date.now()}`;
    const contractId = `CC-${String(cuentaPublicId || cuenta.id || "").split("-")[0]}`;
    const fileName = sanitizePdfFileName(
      `CuentaCobro_${cuentaPublicId || cuenta.id}.pdf`,
      `CuentaCobro_${cuenta.id}.pdf`
    );
    const signatoryExternalId = String(cuenta.created_by || "");

    const signaturePayload = {
      request: "START_SIGNATURE",
      request_id: requestId,
      user: CLICKSIGN_USER,
      signature: {
        config_id: CLICKSIGN_CONFIG_ID,
        contract_id: contractId,
        level: [
          {
            level_order: 0,
            required_signatories_to_complete_level: 1,
            signatories: [
              {
                email: cuenta.email,
                name: cuenta.nombre_usuario || cuenta.email,
                external_id: signatoryExternalId
              }
            ]
          }
        ],
        file: [
  {
    filename: fileName,
    content: pdfBuffer.toString("base64"),
    sign_on_landing: "Y",
    signature_position: [
      {
        signatory_external_id: signatoryExternalId,
        page: "last",
        x: 140,
        y: 240,
        width: 84,
        height: 36,
        rotation: 0
      }
    ]
  }
]
      }
    };
    const fallbackWebhookBase = getRequestPublicBaseUrl(req);
    const fallbackSignatureCbUrl = fallbackWebhookBase
      ? `${fallbackWebhookBase}/webhooks/clicksign/signature${CLICKSIGN_WEBHOOK_TOKEN
        ? `?token=${encodeURIComponent(CLICKSIGN_WEBHOOK_TOKEN)}`
        : ""
      }`
      : "";
    const signatureCbUrl = CLICKSIGN_SIGNATURE_CB_URL || fallbackSignatureCbUrl;
    const signatoryCbUrl = CLICKSIGN_SIGNATORY_CB_URL || signatureCbUrl;
    const signatoryEmailCbUrl = CLICKSIGN_SIGNATORY_EMAIL_CB_URL || signatureCbUrl;
    if (signatureCbUrl) {
      signaturePayload.signature.signature_cb_url = signatureCbUrl;
    }
    if (signatoryCbUrl) {
      signaturePayload.signature.signatory_cb_url = signatoryCbUrl;
    }
    if (signatoryEmailCbUrl) {
      signaturePayload.signature.signatory_email_cb_url = signatoryEmailCbUrl;
    }
    const clickSignRes = await jsonRequest({
      method: "POST",
      url: buildClickSignUrl("start_signature"),
      headers: buildClickSignAuthHeaders(),
      body: signaturePayload
    });
    const signatureId = extractClickSignSignatureId(clickSignRes.data);
    const urlFirma = getClickSignLandingUrl(clickSignRes.data);
    if (!urlFirma) {
      return res.status(502).json({
        error: "Click&Sign no devolvio URL de firma.",
        detalle: clickSignRes.data
      });
    }

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
      ? cuenta.datos_adjuntos
      : {};
    const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object"
      ? prevAdjuntos.firma
      : {};
    const ahoraIso = new Date().toISOString();
    const firma = {
      ...prevFirma,
      proveedor: "clicksign",
      estado: "pending",
      request_id: requestId,
      contract_id: contractId,
      signature_id: signatureId || null,
      url_firma: urlFirma,
      iniciado_en: ahoraIso,
      actualizado_en: ahoraIso,
      ultimo_evento: "START_SIGNATURE"
    };
    const adjuntos = {
      ...prevAdjuntos,
      firma
    };
    const estadoEnFirma = await getCuentaCobroEstadoEnFirma();
    await pool.query(
      `
      UPDATE cuenta_cobro
      SET datos_adjuntos = $1::jsonb,
          estado = $2::tipo_estado_reporte,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      `,
      [JSON.stringify(adjuntos), estadoEnFirma, cuentaInternalId]
    );

    return res.json({
      ok: true,
      cuenta_id: cuentaPublicId || String(cuenta.id || ""),
      request_id: requestId,
      contract_id: contractId,
      signature_id: signatureId || null,
      url_firma: urlFirma
    });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }
    if (err?.code === "ACCESS_DENIED") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (Number(err?.status || 0) > 0) {
      return res.status(502).json({
        error: "Error al iniciar firma en Click&Sign",
        detalle: err.response || err.message
      });
    }
    console.error("Error iniciando firma digital:", err);
    return res.status(500).json({ error: "Error al iniciar proceso de firma" });
  }
});

app.post("/cuentas-cobro/:id/firma/reconciliar", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"], tipos: ["Asociado"] }), async (req, res) => {
  const { id } = req.params;
  if (!isClickSignConfigured()) {
    return res.status(503).json({
      error: "Click&Sign no esta configurado. Falta CLICKSIGN_API_KEY, CLICKSIGN_USER o CLICKSIGN_CONFIG_ID."
    });
  }

  try {
    const cuentaInternalId = await resolveInternalId(pool, ID_TABLES.cuentaCobro, id, { required: true });
    await assertCuentaCobroOwnerAccess(cuentaInternalId, req);

    const cuentaResult = await pool.query(
      `
      SELECT
        cc.id,
        cc.public_id,
        cc.created_by,
        cc.fecha_correspondiente,
        cc.created_at,
        cc.datos_adjuntos,
        u.nombre_usuario,
        u.email
      FROM cuenta_cobro cc
      LEFT JOIN usuarios u ON u.id = cc.created_by
      WHERE cc.id = $1
      LIMIT 1
      `,
      [cuentaInternalId]
    );

    const cuenta = cuentaResult.rows[0] || null;
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
      ? cuenta.datos_adjuntos
      : {};
    const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object"
      ? prevAdjuntos.firma
      : {};
    const prevDocumentoFirmado = prevFirma.documento_firmado && typeof prevFirma.documento_firmado === "object"
      ? prevFirma.documento_firmado
      : null;

    const requestId = String(req.body?.request_id || prevFirma.request_id || "").trim();
    const contractId = String(req.body?.contract_id || prevFirma.contract_id || `CC-${cuenta.public_id || cuenta.id}`).trim();
    const signatureId = String(req.body?.signature_id || prevFirma.signature_id || "").trim();

    if (!requestId && !contractId) {
      return res.status(400).json({
        error: "La cuenta no tiene request_id/contract_id para reconciliar."
      });
    }

    const snapshot = await fetchClickSignSignatureSnapshot({ requestId, contractId, signatureId });
    const event = snapshot.event && typeof snapshot.event === "object" ? snapshot.event : {};
    const signatureIdFromSnapshot = String(extractClickSignSignatureId(event) || "").trim();
    const effectiveSignatureId = signatureId || signatureIdFromSnapshot;
    const rawStatusFromRequest = String(req.body?.status || "").trim();
    const rawStatus = rawStatusFromRequest || snapshot.rawStatus || prevFirma.ultimo_evento || prevFirma.estado || "pending";
    let status = normalizeClickSignStatus(rawStatus);
    const nowIso = new Date().toISOString();

    const eventosPrev = Array.isArray(prevFirma.eventos) ? prevFirma.eventos.slice(-19) : [];
    const eventoResumen = {
      recibido_en: nowIso,
      status: rawStatus || status || "",
      request_id: requestId || null,
      contract_id: contractId || null,
      origen: "reconciliacion"
    };

    let documentoFirmado = prevDocumentoFirmado;
    let documentoFirmadoError = "";
    let documentosAdjuntosCorreo = [];

    let uploadedExtras = [];
    let catalogSource = null;
    if (status === "signed" || !status || status === "pending") {
      const artifacts = await resolveClickSignArtifacts({
        event,
        requestId,
        contractId,
        publicId: String(cuenta.public_id || ""),
        signatureId: effectiveSignatureId
      });
      catalogSource = artifacts?.catalogSource || null;
      const resolvedPdf = artifacts?.signedPdf || null;

      if (resolvedPdf && isPdfBuffer(resolvedPdf.buffer)) {
        documentosAdjuntosCorreo = buildCuentaCobroEmailAttachments({
          cuenta,
          signedPdf: {
            buffer: resolvedPdf.buffer,
            fileName: resolvedPdf.fileName || ""
          },
          extraFiles: artifacts?.extraFiles || []
        });
        try {
          const uploadResult = await uploadSignedPdfToOneDrive(
            cuenta,
            resolvedPdf.buffer,
            resolvedPdf.fileName
          );
          documentoFirmado = {
            ...uploadResult.archivo,
            carpeta: uploadResult.carpeta,
            origen: resolvedPdf.source || "clicksign",
            actualizado_en: nowIso
          };
          status = "signed";
          try {
            const extrasResult = await uploadClickSignExtraFilesToOneDrive(
              cuenta,
              artifacts?.extraFiles || [],
              uploadResult.carpeta || ""
            );
            uploadedExtras = extrasResult.uploaded || [];
          } catch (extraErr) {
            console.warn("No se pudieron subir adjuntos extra de Click&Sign (reconciliacion):", extraErr?.message || extraErr);
          }
        } catch (uploadErr) {
          documentoFirmadoError = `Error almacenando firmado en OneDrive: ${uploadErr.message || "desconocido"}`;
        }
      } else if (status === "signed") {
        documentoFirmadoError = "No se encontró PDF firmado en API de Click&Sign.";
      }
    }

    const firma = {
      ...prevFirma,
      estado: status || prevFirma.estado || "pending",
      request_id: requestId || prevFirma.request_id || null,
      contract_id: contractId || prevFirma.contract_id || null,
      signature_id: effectiveSignatureId || prevFirma.signature_id || null,
      actualizado_en: nowIso,
      ultimo_evento: rawStatus || status || "reconciliacion",
      eventos: [...eventosPrev, eventoResumen]
    };
    if (documentoFirmado && documentoFirmado.url) {
      firma.documento_firmado = documentoFirmado;
    }
    if (documentoFirmadoError) {
      firma.documento_firmado_error = documentoFirmadoError;
    } else if (status === "signed" && prevFirma.documento_firmado_error) {
      firma.documento_firmado_error = null;
    }
    if (status === "signed" && documentoFirmado?.url) {
      const prevNotificacionProveedores =
        prevFirma.notificacion_proveedores && typeof prevFirma.notificacion_proveedores === "object"
          ? prevFirma.notificacion_proveedores
          : {};
      const notificacion = await notifyCuentaCobroFirmadaToProveedores({
        cuenta,
        documentoFirmado,
        attachments: documentosAdjuntosCorreo,
        prevNotification: prevNotificacionProveedores,
        nowIso,
        graphContext: getGraphContext(req)
      });
      if (notificacion) {
        firma.notificacion_proveedores = notificacion;
      }
    }
    const adjuntos = {
      ...prevAdjuntos,
      firma
    };
    if (documentoFirmado && documentoFirmado.url) {
      const prevSoportes = prevAdjuntos.soportes && typeof prevAdjuntos.soportes === "object"
        ? prevAdjuntos.soportes
        : {};
      const nuevoSoporteCuentaFirmada = {
        id: documentoFirmado.id || prevSoportes?.cuenta_cobro_firmada?.id || prevSoportes?.cuenta_cobro?.id || null,
        nombre: documentoFirmado.nombre || prevSoportes?.cuenta_cobro_firmada?.nombre || prevSoportes?.cuenta_cobro?.nombre || "CuentaCobroFirmada.pdf",
        url: documentoFirmado.url || prevSoportes?.cuenta_cobro_firmada?.url || prevSoportes?.cuenta_cobro?.url || ""
      };
      adjuntos.soportes = {
        ...prevSoportes,
        carpeta: documentoFirmado.carpeta || prevSoportes.carpeta || "",
        actualizado_en: nowIso,
        cuenta_cobro_firmada: nuevoSoporteCuentaFirmada
      };
      const extraSeguridad = uploadedExtras.find((item) => item.kind === "seguridad_social_firma" && item.url);
      const extraEvidencia = uploadedExtras.find((item) => item.kind === "evidencia_firma" && item.url);
      const extraAnexo = uploadedExtras.find((item) => item.kind === "anexo_firma" && item.url);
      const cuentaFirmadaUrl = nuevoSoporteCuentaFirmada.url || "";
      if (extraSeguridad && !sameResourceUrl(extraSeguridad.url, cuentaFirmadaUrl)) {
        adjuntos.soportes.seguridad_social_firma = {
          id: extraSeguridad.id || null,
          nombre: extraSeguridad.nombre || "SeguridadSocial.pdf",
          url: extraSeguridad.url || ""
        };
        if (!adjuntos.soportes.seguridad_social?.url) {
          adjuntos.soportes.seguridad_social = { ...adjuntos.soportes.seguridad_social_firma };
        }
      }
      if (extraEvidencia && !sameResourceUrl(extraEvidencia.url, cuentaFirmadaUrl)) {
        adjuntos.soportes.evidencia_firma = {
          id: extraEvidencia.id || null,
          nombre: extraEvidencia.nombre || "EvidenciaFirma.pdf",
          url: extraEvidencia.url || ""
        };
      }
      if (extraAnexo && !sameResourceUrl(extraAnexo.url, cuentaFirmadaUrl)) {
        adjuntos.soportes.anexo_firma = {
          id: extraAnexo.id || null,
          nombre: extraAnexo.nombre || "AnexoFirma.pdf",
          url: extraAnexo.url || ""
        };
      }
    }

    let estadoDestino = null;
    if (status === "signed") {
      const estadoAprobado = await getCuentaCobroEstadoAprobado();
      estadoDestino = (documentoFirmado && documentoFirmado.url)
        ? estadoAprobado
        : await getCuentaCobroEstadoEnFirma();
    } else if (status === "rejected") {
      estadoDestino = "Rechazado";
    } else if (status === "pending") {
      estadoDestino = await getCuentaCobroEstadoEnFirma();
    }

    if (estadoDestino) {
      await pool.query(
        `
        UPDATE cuenta_cobro
        SET datos_adjuntos = $1::jsonb,
            estado = $2::tipo_estado_reporte,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        `,
        [JSON.stringify(adjuntos), estadoDestino, cuenta.id]
      );
    } else {
      await pool.query(
        `
        UPDATE cuenta_cobro
        SET datos_adjuntos = $1::jsonb,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        `,
        [JSON.stringify(adjuntos), cuenta.id]
      );
    }

    return res.json({
      ok: true,
      cuenta_id: String(cuenta.public_id || cuenta.id || ""),
      request_id: requestId || null,
      contract_id: contractId || null,
      estado_firma: firma.estado || null,
      estado_cuenta: estadoDestino || null,
      documento_firmado_url: firma?.documento_firmado?.url || null,
      documento_firmado_error: firma?.documento_firmado_error || null,
      origen_snapshot: snapshot.source || null,
      origen_catalogo: catalogSource,
      extras_subidos: uploadedExtras.map((item) => ({ kind: item.kind, nombre: item.nombre, url: item.url }))
    });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }
    if (err?.code === "ACCESS_DENIED") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (Number(err?.status || 0) > 0) {
      return res.status(502).json({
        error: "Error consultando firma en Click&Sign",
        detalle: err.response || err.message
      });
    }
    console.error("Error reconciliando firma digital:", err);
    return res.status(500).json({ error: "Error reconciliando firma digital" });
  }
});

app.post("/cuentas-cobro/:id/firma/adjuntar", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"], tipos: ["Asociado"] }), async (req, res) => {
  const { id } = req.params;
  const cuentaPdfBase64 = req.body?.cuenta_pdf_base64 || req.body?.archivo_base64 || req.body?.signed_pdf_base64 || "";
  const cuentaPdfNombre = req.body?.cuenta_pdf_nombre || req.body?.archivo_nombre || req.body?.signed_pdf_nombre || "";

  if (!ONEDRIVE_ENABLED) {
    return res.status(503).json({ error: "Servicio de carga no disponible temporalmente." });
  }
  if (!cuentaPdfBase64) {
    return res.status(400).json({ error: "Debe enviar el PDF firmado en base64." });
  }

  try {
    const cuentaInternalId = await resolveInternalId(pool, ID_TABLES.cuentaCobro, id, { required: true });
    await assertCuentaCobroOwnerAccess(cuentaInternalId, req);

    const cuentaResult = await pool.query(
      `
      SELECT
        cc.id,
        cc.public_id,
        cc.created_by,
        cc.fecha_correspondiente,
        cc.created_at,
        cc.datos_adjuntos,
        u.nombre_usuario,
        u.email
      FROM cuenta_cobro cc
      LEFT JOIN usuarios u ON u.id = cc.created_by
      WHERE cc.id = $1
      LIMIT 1
      `,
      [cuentaInternalId]
    );
    const cuenta = cuentaResult.rows[0] || null;
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });

    const pdfBuffer = parsePdfDataUrl(cuentaPdfBase64);
    if (!isPdfBuffer(pdfBuffer)) {
      return res.status(400).json({ error: "El archivo firmado debe ser un PDF válido." });
    }

    const defaultName = sanitizePdfFileName(
      `CuentaCobroFirmada_${String(cuenta.public_id || cuenta.id || "cuenta")}.pdf`,
      "CuentaCobroFirmada.pdf"
    );
    let uploadResult = null;
    const uploadName = sanitizePdfFileName(cuentaPdfNombre || defaultName, defaultName);
    try {
      uploadResult = await uploadSignedPdfToOneDrive(
        cuenta,
        pdfBuffer,
        uploadName
      );
    } catch (uploadErr) {
      const delegatedGraphToken = String(req?.headers?.["x-graph-access-token"] || "").trim();
      if (!delegatedGraphToken) throw uploadErr;
      uploadResult = await uploadSignedPdfToOneDrive(
        cuenta,
        pdfBuffer,
        uploadName,
        { accessToken: delegatedGraphToken }
      );
    }

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
      ? cuenta.datos_adjuntos
      : {};
    const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object"
      ? prevAdjuntos.firma
      : {};
    const prevSoportes = prevAdjuntos.soportes && typeof prevAdjuntos.soportes === "object"
      ? prevAdjuntos.soportes
      : {};
    const nowIso = new Date().toISOString();

    const documentoFirmado = {
      ...uploadResult.archivo,
      carpeta: uploadResult.carpeta,
      origen: "manual_upload",
      actualizado_en: nowIso
    };
    const documentosAdjuntosCorreo = buildCuentaCobroEmailAttachments({
      cuenta,
      signedPdf: {
        buffer: pdfBuffer,
        fileName: uploadName
      }
    });
    const firma = {
      ...prevFirma,
      estado: "signed",
      actualizado_en: nowIso,
      ultimo_evento: "MANUAL_UPLOAD",
      documento_firmado: documentoFirmado,
      documento_firmado_error: null
    };
    if (documentoFirmado?.url) {
      const prevNotificacionProveedores =
        prevFirma.notificacion_proveedores && typeof prevFirma.notificacion_proveedores === "object"
          ? prevFirma.notificacion_proveedores
          : {};
      const notificacion = await notifyCuentaCobroFirmadaToProveedores({
        cuenta,
        documentoFirmado,
        attachments: documentosAdjuntosCorreo,
        prevNotification: prevNotificacionProveedores,
        nowIso,
        graphContext: getGraphContext(req)
      });
      if (notificacion) {
        firma.notificacion_proveedores = notificacion;
      }
    }
    const adjuntos = {
      ...prevAdjuntos,
      firma,
      soportes: {
        ...prevSoportes,
        carpeta: uploadResult.carpeta || prevSoportes.carpeta || "",
        actualizado_en: nowIso,
        cuenta_cobro_firmada: {
          id: documentoFirmado.id || null,
          nombre: documentoFirmado.nombre || defaultName,
          url: documentoFirmado.url || ""
        }
      }
    };

    const estadoAprobado = await getCuentaCobroEstadoAprobado();
    await pool.query(
      `
      UPDATE cuenta_cobro
      SET datos_adjuntos = $1::jsonb,
          estado = $2::tipo_estado_reporte,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      `,
      [JSON.stringify(adjuntos), estadoAprobado, cuenta.id]
    );

    return res.json({
      ok: true,
      cuenta_id: String(cuenta.public_id || cuenta.id || ""),
      estado_cuenta: estadoAprobado,
      documento_firmado_url: documentoFirmado.url || null
    });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }
    if (err?.code === "ACCESS_DENIED") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (err?.code === "GRAPH_TOKEN_ERROR") {
      return res.status(502).json({
        error: "No se pudo autenticar OneDrive (Microsoft Graph). Verifica credenciales y permisos."
      });
    }
    const status = parseGraphErrorStatus(err?.message || "");
    if (status === 401 || status === 403) {
      return res.status(502).json({
        error: "Servicio de almacenamiento no autorizado. Verifica permisos de Graph/OneDrive."
      });
    }
    if (status === 404) {
      return res.status(502).json({
        error: "No se encontró el repositorio de OneDrive configurado."
      });
    }
    console.error("Error adjuntando PDF firmado manual:", err);
    return res.status(500).json({
      error: "Error adjuntando PDF firmado",
      codigo: err?.code || null,
      detalle: err?.message || null
    });
  }
});

app.post("/webhooks/clicksign/signature", async (req, res) => {
  try {
    if (CLICKSIGN_WEBHOOK_TOKEN) {
      const inboundToken = String(
        req.headers["x-clicksign-token"] ||
        req.headers["x-webhook-token"] ||
        req.query?.token ||
        ""
      ).trim();
      if (!inboundToken || inboundToken !== CLICKSIGN_WEBHOOK_TOKEN) {
        return res.status(401).json({ ok: false, error: "Webhook no autorizado" });
      }
    }

    const event = req.body && typeof req.body === "object" ? req.body : {};
    res.status(200).json({ ok: true });

    setImmediate(async () => {
      try {
        const requestId = pickStringByPaths(event, [
          "request_id",
          "signature.request_id",
          "signature.request.request_id",
          "signature.requestId",
          "data.request_id",
          "data.signature.request_id",
          "data.signature.request.request_id"
        ]);
        const contractId = pickStringByPaths(event, [
          "contract_id",
          "signature.contract_id",
          "signature.request.contract_id",
          "signature.contractId",
          "data.contract_id",
          "data.signature.contract_id",
          "data.signature.request.contract_id"
        ]);
        const signatureId = extractClickSignSignatureId(event);
        const rawStatus = pickStringByPaths(event, [
          "status",
          "signature_status",
          "signature.status",
          "event.status",
          "data.status"
        ]);
        const status = normalizeClickSignStatus(rawStatus);
        const publicIdFromEvent = extractPublicIdFromContract(contractId) || pickStringByPaths(event, [
          "public_id",
          "cuenta_public_id",
          "data.public_id"
        ]);

        let cuentaResult = null;
        if (publicIdFromEvent) {
          cuentaResult = await pool.query(
            `
            SELECT
              cc.id,
              cc.public_id,
              cc.created_by,
              cc.fecha_correspondiente,
              cc.created_at,
              cc.datos_adjuntos,
              u.nombre_usuario,
              u.email
            FROM cuenta_cobro cc
            LEFT JOIN usuarios u ON u.id = cc.created_by
            WHERE cc.public_id = $1
            LIMIT 1
            `,
            [publicIdFromEvent]
          );
        } else if (requestId) {
          cuentaResult = await pool.query(
            `
            SELECT
              cc.id,
              cc.public_id,
              cc.created_by,
              cc.fecha_correspondiente,
              cc.created_at,
              cc.datos_adjuntos,
              u.nombre_usuario,
              u.email
            FROM cuenta_cobro cc
            LEFT JOIN usuarios u ON u.id = cc.created_by
            WHERE cc.datos_adjuntos->'firma'->>'request_id' = $1
            ORDER BY cc.id DESC
            LIMIT 1
            `,
            [requestId]
          );
        }

        const cuenta = cuentaResult?.rows?.[0] || null;
        if (!cuenta) {
          console.warn("Webhook Click&Sign sin cuenta asociada:", { requestId, contractId, rawStatus });
          return;
        }

        const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
          ? cuenta.datos_adjuntos
          : {};
        const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object"
          ? prevAdjuntos.firma
          : {};
        const prevDocumentoFirmado = prevFirma.documento_firmado && typeof prevFirma.documento_firmado === "object"
          ? prevFirma.documento_firmado
          : null;

        const nowIso = new Date().toISOString();
        const eventosPrev = Array.isArray(prevFirma.eventos) ? prevFirma.eventos.slice(-19) : [];
        const eventoResumen = {
          recibido_en: nowIso,
          status: rawStatus || status || "",
          request_id: requestId || null,
          contract_id: contractId || null
        };

        let documentoFirmado = prevDocumentoFirmado;
        let documentoFirmadoError = "";
        let documentosAdjuntosCorreo = [];

        let uploadedExtras = [];
        if (status === "signed") {
          const artifacts = await resolveClickSignArtifacts({
            event,
            requestId,
            contractId,
            publicId: String(cuenta.public_id || ""),
            signatureId: signatureId || prevFirma.signature_id || ""
          });
          const resolvedPdf = artifacts?.signedPdf || null;

          if (resolvedPdf && isPdfBuffer(resolvedPdf.buffer)) {
            documentosAdjuntosCorreo = buildCuentaCobroEmailAttachments({
              cuenta,
              signedPdf: {
                buffer: resolvedPdf.buffer,
                fileName: resolvedPdf.fileName || ""
              },
              extraFiles: artifacts?.extraFiles || []
            });
            try {
              const uploadResult = await uploadSignedPdfToOneDrive(
                cuenta,
                resolvedPdf.buffer,
                resolvedPdf.fileName
              );
              documentoFirmado = {
                ...uploadResult.archivo,
                carpeta: uploadResult.carpeta,
                origen: resolvedPdf.source || "clicksign",
                actualizado_en: nowIso
              };
              try {
                const extrasResult = await uploadClickSignExtraFilesToOneDrive(
                  cuenta,
                  artifacts?.extraFiles || [],
                  uploadResult.carpeta || ""
                );
                uploadedExtras = extrasResult.uploaded || [];
              } catch (extraErr) {
                console.warn("No se pudieron subir adjuntos extra de Click&Sign:", extraErr?.message || extraErr);
              }
            } catch (uploadErr) {
              documentoFirmadoError = `Error almacenando firmado en OneDrive: ${uploadErr.message || "desconocido"}`;
              console.error("Error guardando firmado en OneDrive:", uploadErr?.message || uploadErr);
            }
          } else {
            documentoFirmadoError = "No se encontró PDF firmado en webhook/API de Click&Sign.";
            console.warn("No se pudo resolver PDF firmado de Click&Sign:", { requestId, contractId, cuentaId: cuenta.id });
          }
        }

        const firma = {
          ...prevFirma,
          estado: status || prevFirma.estado || "pending",
          request_id: requestId || prevFirma.request_id || null,
          contract_id: contractId || prevFirma.contract_id || null,
          signature_id: signatureId || prevFirma.signature_id || null,
          actualizado_en: nowIso,
          ultimo_evento: rawStatus || status || "webhook",
          eventos: [...eventosPrev, eventoResumen]
        };
        if (documentoFirmado && documentoFirmado.url) {
          firma.documento_firmado = documentoFirmado;
        }
        if (documentoFirmadoError) {
          firma.documento_firmado_error = documentoFirmadoError;
        } else if (status === "signed" && prevFirma.documento_firmado_error) {
          firma.documento_firmado_error = null;
        }
        if (status === "signed" && documentoFirmado?.url) {
          const prevNotificacionProveedores =
            prevFirma.notificacion_proveedores && typeof prevFirma.notificacion_proveedores === "object"
              ? prevFirma.notificacion_proveedores
              : {};
          const notificacion = await notifyCuentaCobroFirmadaToProveedores({
            cuenta,
            documentoFirmado,
            attachments: documentosAdjuntosCorreo,
            prevNotification: prevNotificacionProveedores,
            nowIso
          });
          if (notificacion) {
            firma.notificacion_proveedores = notificacion;
          }
        }

        const adjuntos = {
          ...prevAdjuntos,
          firma
        };
        if (documentoFirmado && documentoFirmado.url) {
          const prevSoportes = prevAdjuntos.soportes && typeof prevAdjuntos.soportes === "object"
            ? prevAdjuntos.soportes
            : {};
          const nuevoSoporteCuentaFirmada = {
            id: documentoFirmado.id || prevSoportes?.cuenta_cobro_firmada?.id || prevSoportes?.cuenta_cobro?.id || null,
            nombre: documentoFirmado.nombre || prevSoportes?.cuenta_cobro_firmada?.nombre || prevSoportes?.cuenta_cobro?.nombre || "CuentaCobroFirmada.pdf",
            url: documentoFirmado.url || prevSoportes?.cuenta_cobro_firmada?.url || prevSoportes?.cuenta_cobro?.url || ""
          };
          adjuntos.soportes = {
            ...prevSoportes,
            carpeta: documentoFirmado.carpeta || prevSoportes.carpeta || "",
            actualizado_en: nowIso,
            cuenta_cobro_firmada: nuevoSoporteCuentaFirmada
          };
          const extraSeguridad = uploadedExtras.find((item) => item.kind === "seguridad_social_firma" && item.url);
          const extraEvidencia = uploadedExtras.find((item) => item.kind === "evidencia_firma" && item.url);
          const extraAnexo = uploadedExtras.find((item) => item.kind === "anexo_firma" && item.url);
          const cuentaFirmadaUrl = nuevoSoporteCuentaFirmada.url || "";
          if (extraSeguridad && !sameResourceUrl(extraSeguridad.url, cuentaFirmadaUrl)) {
            adjuntos.soportes.seguridad_social_firma = {
              id: extraSeguridad.id || null,
              nombre: extraSeguridad.nombre || "SeguridadSocial.pdf",
              url: extraSeguridad.url || ""
            };
            if (!adjuntos.soportes.seguridad_social?.url) {
              adjuntos.soportes.seguridad_social = { ...adjuntos.soportes.seguridad_social_firma };
            }
          }
          if (extraEvidencia && !sameResourceUrl(extraEvidencia.url, cuentaFirmadaUrl)) {
            adjuntos.soportes.evidencia_firma = {
              id: extraEvidencia.id || null,
              nombre: extraEvidencia.nombre || "EvidenciaFirma.pdf",
              url: extraEvidencia.url || ""
            };
          }
          if (extraAnexo && !sameResourceUrl(extraAnexo.url, cuentaFirmadaUrl)) {
            adjuntos.soportes.anexo_firma = {
              id: extraAnexo.id || null,
              nombre: extraAnexo.nombre || "AnexoFirma.pdf",
              url: extraAnexo.url || ""
            };
          }
        }

        let estadoDestino = null;
        if (status === "signed") {
          const estadoAprobado = await getCuentaCobroEstadoAprobado();
          estadoDestino = (documentoFirmado && documentoFirmado.url)
            ? estadoAprobado
            : await getCuentaCobroEstadoEnFirma();
        } else if (status === "rejected") {
          estadoDestino = "Rechazado";
        } else if (status === "pending") {
          estadoDestino = await getCuentaCobroEstadoEnFirma();
        }

        if (estadoDestino) {
          await pool.query(
            `
            UPDATE cuenta_cobro
            SET datos_adjuntos = $1::jsonb,
                estado = $2::tipo_estado_reporte,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            `,
            [JSON.stringify(adjuntos), estadoDestino, cuenta.id]
          );
        } else {
          await pool.query(
            `
            UPDATE cuenta_cobro
            SET datos_adjuntos = $1::jsonb,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            `,
            [JSON.stringify(adjuntos), cuenta.id]
          );
        }
      } catch (innerErr) {
        console.error("Error procesando webhook Click&Sign:", innerErr);
      }
    });
  } catch (err) {
    console.error("Error webhook Click&Sign:", err);
    return res.status(500).json({ ok: false });
  }
});


// Reportes pendientes para coordinador
app.get("/aprobaciones/pendientes", requireAccess({ roles: ["Coordinador"] }), async (req, res) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(`
      SELECT
        rh.public_id AS id,
        rh.created_at AS fecha_reporte,
        rh.nro_caso_int_ext,
        rh.total_cobrar,
        rh.horas_reportadas,
        rh.cantidad_dias_reportados,
        c.titulo AS nombre_cliente,
        u.nombre_usuario AS nombre_consultor,
        u.email AS email_consultor,
        m.titulo AS nombre_modulo,
        ta.titulo AS nombre_tipo_asignacion
      FROM reporte_horas rh
        LEFT JOIN clientes c ON rh.cliente_id = c.id
        LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
        LEFT JOIN modulo m ON rh.modulo_id = m.id
        LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
      WHERE rh.estado_reporte = 'Pendiente'
        AND rh.coordinador_id = $1
      ORDER BY rh.created_at DESC
    `, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener reportes" });
  }
});

// Aprobar / Rechazar reporte
app.put("/aprobaciones/:id", requireAccess({ roles: ["Coordinador"] }), async (req, res) => {
  const { id } = req.params;
  const { estado, motivo } = req.body;

  try {
    const reporteId = await resolveInternalId(pool, ID_TABLES.reporteHoras, id, { required: true });
    if (!estado) {
      return res.status(400).json({ error: "Falta estado" });
    }
    const result = await pool.query(
      `UPDATE reporte_horas
       SET estado_reporte = $1,
           motivo_rechazo = $2
       WHERE id = $3
       RETURNING *`,
      [estado, motivo || null, reporteId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Reporte no encontrado" });
    }

    const registroId = result.rows[0]?.id_registro_asignacion || null;
    if (registroId) {
      try {
        const estados = await getEstadoAsignacionValues();
        let estadoAprobadoDestino = estados.proceso;
        const asignacionMeta = await pool.query(
          `SELECT
             con.id_tipo_asignacion,
             ta.titulo AS tipo_asignacion_titulo,
             ra.horas_asignadas,
             ra.cantidad_dias
           FROM registro_asignaciones ra
           JOIN consultorias con ON con.id = ra.id_consultoria
           LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
           WHERE ra.id = $1`,
          [registroId]
        );
        if (asignacionMeta.rows.length > 0) {
          const meta = asignacionMeta.rows[0];
          const scope = getMesaFabricaScope(meta.id_tipo_asignacion, meta.tipo_asignacion_titulo);
          if (scope) {
            // Mesa/Fabrica: se cierra la solicitud (reporte), pero la asignacion base sigue activa.
            estadoAprobadoDestino = estados.abierto || estados.proceso;
          } else {
            const tipoNorm = String(meta.tipo_asignacion_titulo || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toLowerCase()
              .trim();
            const esMensual = tipoNorm.includes("full") || tipoNorm.includes("part");
            const esHorasPorDemanda = tipoNorm.includes("horas por demanda");
            if (!esHorasPorDemanda) {
              const uso = await pool.query(
                `
                SELECT
                  COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN horas_reportadas ELSE 0 END), 0) AS horas_aprobadas,
                  COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN cantidad_dias_reportados ELSE 0 END), 0) AS dias_aprobados
                FROM reporte_horas
                WHERE id_registro_asignacion = $1
                `,
                [registroId]
              );
              const horasAsignadas = toNullableNumber(meta.horas_asignadas);
              const diasAsignados = toNullableNumber(meta.cantidad_dias);
              const horasAprobadas = Number(uso.rows[0]?.horas_aprobadas || 0);
              const diasAprobadas = Number(uso.rows[0]?.dias_aprobadas || 0);
              const agotadoPorHoras = !esMensual && horasAsignadas !== null && horasAprobadas >= horasAsignadas;
              const agotadoPorDias = esMensual && diasAsignados !== null && diasAprobadas >= diasAsignados;
              if (agotadoPorHoras || agotadoPorDias) {
                estadoAprobadoDestino = estados.cerrado || estados.proceso;
              }
            }
          }
        }
        // Actualizar aprobación y estado en la asignación asociada
        await pool.query(
          `UPDATE registro_asignaciones
           SET aprobar_coordinador = $1::tipo_aprobacion,
               estado = CASE
                 WHEN $1::tipo_aprobacion = 'Aprobado'::tipo_aprobacion THEN $3::tipo_estado_asignacion
                 WHEN $1::tipo_aprobacion = 'Rechazado'::tipo_aprobacion THEN $4::tipo_estado_asignacion
                 ELSE estado
               END
           WHERE id = $2`,
          [estado, registroId, estadoAprobadoDestino, estados.abierto]
        );
      } catch (innerErr) {
        console.error("Error actualizando registro_asignaciones:", innerErr);
      }
    }

    // Email al consultor con resultado de aprobación
    const detalle = await pool.query(
      `SELECT
         u.email AS consultor_email,
         u.nombre_usuario AS consultor_nombre,
         u.tipo_consultor AS consultor_tipo,
         c.titulo AS cliente,
         ta.titulo AS tipo_asignacion,
         rh.horas_reportadas,
         rh.cantidad_dias_reportados,
         rh.total_cobrar
       FROM reporte_horas rh
         LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
         LEFT JOIN clientes c ON rh.cliente_id = c.id
         LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
       WHERE rh.id = $1`,
      [reporteId]
    );
    const info = detalle.rows[0];
    if (info?.consultor_email) {
      const esConsultorAsociado = normalizeValue(info.consultor_tipo) === "asociado";
      const resumenData = esConsultorAsociado
        ? { ...info, total_cobrar: null }
        : info;
      const resumenReporte = buildReporteResumen(resumenData);
      const esAprobado = estado === "Aprobado";
      const tipoNorm = String(info.tipo_asignacion || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
      const esMesaOFabrica = ["mesa de servicio", "fabrica"].includes(tipoNorm);
      const portalUrl = buildPortalUrl(esMesaOFabrica ? "asignacion-fabrica-mesa-servicio" : "registro-horas-consultor");
      const titulo = esAprobado
        ? "✅ Horas aprobadas"
        : estado === "Rechazado"
          ? "⚠️ Acción requerida: corrección de reporte"
          : "Actualización de reporte";
      await sendEmailSafe({
        ...getGraphContext(req),
        to: info.consultor_email,
        subject: `${titulo} - ${info.cliente || "Cliente"}`,
        text:
          `Hola ${info.consultor_nombre || ""},\n` +
          `Tu reporte fue ${estado}.\n` +
          `Cliente: ${info.cliente || "N/A"}\n` +
          `Tipo: ${info.tipo_asignacion || "N/A"}\n` +
          `Detalle: ${resumenReporte}\n` +
          (estado === "Rechazado" && motivo ? `Motivo: ${motivo}\n` : "") +
          `Portal: ${portalUrl}\n`,
        html: buildEmailLayout({
          title: esAprobado ? "Reporte aprobado exitosamente" : "Reporte con corrección requerida",
          intro: esAprobado
            ? `Hola <strong>${info.consultor_nombre || "Consultor"}</strong>, tu reporte fue validado y aprobado.`
            : `Hola <strong>${info.consultor_nombre || "Consultor"}</strong>, tu reporte requiere ajustes antes de procesarse.`,
          blocks: [
            { label: "Cliente", value: info.cliente || "N/A" },
            { label: "Tipo de asignación", value: info.tipo_asignacion || "N/A" },
            { label: "Resumen", value: resumenReporte },
            ...(estado === "Rechazado" ? [{ label: "Motivo", value: motivo || "Sin detalle" }] : [])
          ],
          ctaLabel: esAprobado ? "Ver reporte" : "Corregir reporte",
          ctaUrl: portalUrl,
          closing: esAprobado
            ? "Gracias por tu gestión. Atentamente, Coordinación de Operaciones."
            : "Por favor realiza la corrección y envía nuevamente a aprobación."
        })
      });
    }

    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Reporte no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar reporte" });
  }
});

// Actualizar asignación (registro_asignaciones)
app.put("/registro-asignaciones/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;
  const {
    consultor_responsable_id,
    id_modulo,
    fecha_inicio,
    fecha_fin,
    cantidad_dias,
    valor_hora,
    valor_dia,
    nro_caso_interno,
    nro_caso_cliente,
    tipo_servicio,
    estado,
    observacion,
    total_pagar
  } = req.body;

  try {
    const cantidadDiasNum = toNullableInteger(cantidad_dias);
    const valorHoraNum = toNullableNumber(valor_hora);
    const valorDiaNum = toNullableNumber(valor_dia);
    const totalPagarNum = toNullableNumber(total_pagar);
    const asignacionId = await resolveInternalId(pool, ID_TABLES.registroAsignaciones, id, { required: true });
    const consultorId = await resolveInternalId(pool, ID_TABLES.usuarios, consultor_responsable_id, { required: false });
    const moduloId = await resolveInternalId(pool, ID_TABLES.modulo, id_modulo, { required: false });
    const estados = await getEstadoAsignacionValues();
    const estadoNormalizado = resolveEstadoAsignacionInput(estado, estados);
    if (estado && !estadoNormalizado) {
      return res.status(400).json({ error: "Estado de asignación inválido" });
    }
    const tipoServicioNormalizado = normalizeTipoServicioInput(tipo_servicio);
    if (tipo_servicio && !tipoServicioNormalizado) {
      return res.status(400).json({ error: "Tipo de servicio inválido" });
    }
    const result = await pool.query(
      `UPDATE registro_asignaciones
       SET consultor_responsable_id = $1,
           id_modulo = $2,
           fecha_inicio = $3,
           fecha_fin = $4,
           cantidad_dias = $5,
           valor_hora = $6,
           valor_dia = $7,
           nro_caso_interno = $8,
           nro_caso_cliente = $9,
           tipo_servicio = $10,
           estado = COALESCE($11::tipo_estado_asignacion, estado),
           observacion = $12,
        total_pagar = $13
       WHERE id = $14
       RETURNING *`,
      [
        consultorId || null,
        moduloId || null,
        fecha_inicio || null,
        fecha_fin || null,
        cantidadDiasNum,
        valorHoraNum,
        valorDiaNum,
        nro_caso_interno || null,
        nro_caso_cliente || null,
        tipoServicioNormalizado,
        estadoNormalizado,
        observacion || null,
        totalPagarNum,
        asignacionId
      ]
    );
    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Asignación o referencias no encontradas" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar asignación" });
  }
});

// Cerrar asignación (soft delete operativo)
app.delete("/registro-asignaciones/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;
  try {
    const asignacionId = await resolveInternalId(pool, ID_TABLES.registroAsignaciones, id, { required: true });
    const estados = await getEstadoAsignacionValues();
    const role = normalizeValue(req.user?.rol);
    const meta = await pool.query(
      `SELECT
         ra.id,
         con.coordinador_responsable_id,
         con.id_tipo_asignacion,
         ta.titulo AS tipo_asignacion_titulo
       FROM registro_asignaciones ra
       JOIN consultorias con ON con.id = ra.id_consultoria
       LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
       WHERE ra.id = $1`,
      [asignacionId]
    );
    if (!meta.rows.length) {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }
    const info = meta.rows[0];
    if (role === "coordinador" && String(info.coordinador_responsable_id || "") !== String(req.user?.id || "")) {
      return res.status(404).json({ error: "Asignación no encontrada o sin permisos para cerrarla" });
    }
    const scope = getMesaFabricaScope(info.id_tipo_asignacion, info.tipo_asignacion_titulo);
    if (!scope) {
      return res.status(400).json({ error: "Solo se pueden cerrar asignaciones de Mesa/Fábrica." });
    }
    const result = await pool.query(
      `UPDATE registro_asignaciones
       SET estado = $1::tipo_estado_asignacion,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [estados.cerrado, asignacionId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Asignación no encontrada o sin permisos para cerrarla" });
    }

    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al cerrar asignación" });
  }
});

// Crear asignación (registro_asignaciones)
app.post("/registro-asignaciones", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const {
    id_consultoria,
    id_modulo,
    consultor_responsable_id,
    fecha_inicio,
    fecha_fin,
    cantidad_dias,
    horas_asignadas,
    valor_hora,
    valor_dia,
    tipo_servicio,
    total_pagar
  } = req.body;

  try {
    const cantidadDiasNum = toNullableInteger(cantidad_dias);
    const horasAsignadasNum = toNullableNumber(horas_asignadas);
    const valorHoraInput = toNullableNumber(valor_hora);
    const valorDiaInput = toNullableNumber(valor_dia);
    const totalPagarInput = toNullableNumber(total_pagar);
    const estados = await getEstadoAsignacionValues();
    if (!id_consultoria || !consultor_responsable_id || !id_modulo) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }
    const consultoriaId = await resolveInternalId(pool, ID_TABLES.consultorias, id_consultoria, { required: true });
    const consultorId = await resolveInternalId(pool, ID_TABLES.usuarios, consultor_responsable_id, { required: true });
    const moduloId = await resolveInternalId(pool, ID_TABLES.modulo, id_modulo, { required: true });
    const tipoServicioNormalizado = normalizeTipoServicioInput(tipo_servicio || "Servicio");
    if (!tipoServicioNormalizado) {
      return res.status(400).json({ error: "Tipo de servicio inválido" });
    }

    const meta = await pool.query(
      `SELECT
         con.id_cliente,
         con.id_tipo_asignacion,
         ta.titulo AS tipo_asignacion_titulo
       FROM consultorias con
       LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
       WHERE con.id = $1
         AND con.activo = true`,
      [consultoriaId]
    );
    if (meta.rows.length === 0) {
      return res.status(400).json({ error: "Consultoría no válida" });
    }
    const clienteId = meta.rows[0].id_cliente;
    const tipoAsignacionId = meta.rows[0].id_tipo_asignacion;

    const dup = await pool.query(
      `SELECT ra.id
       FROM registro_asignaciones ra
       JOIN consultorias con ON ra.id_consultoria = con.id
         WHERE ra.consultor_responsable_id = $1
           AND ra.id_modulo = $2
           AND con.id_cliente = $3
           AND con.id_tipo_asignacion = $4
           AND ra.estado IN ($5::tipo_estado_asignacion, $6::tipo_estado_asignacion)
         LIMIT 1`,
      [consultorId, moduloId, clienteId, tipoAsignacionId, estados.abierto, estados.proceso]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe asignación para este consultor, cliente y módulo" });
    }

    const tipoAsigNorm = String(meta.rows[0]?.tipo_asignacion_titulo || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
    const esMesaOFabrica =
      [5, 6].includes(Number(tipoAsignacionId || 0)) ||
      ["mesa de servicio", "fabrica"].includes(tipoAsigNorm);
    const esMensual = tipoAsigNorm.includes("full") || tipoAsigNorm.includes("part");
    const esHorasPorDemanda = tipoAsigNorm.includes("horas por demanda");

    let valorHoraFinal = valorHoraInput;
    let valorDiaFinal = valorDiaInput;
    let totalPagarFinal = totalPagarInput;
    let horasAsignadasFinal = horasAsignadasNum;
    let cantidadDiasFinal = cantidadDiasNum;

    if (esMesaOFabrica) {
      const tarifaRes = await pool.query(
        `SELECT obtener_tarifa_consultor($1, $2, $3, $4) AS valor_tarifa`,
        [consultorId, clienteId, moduloId || null, tipoAsignacionId || null]
      );
      const tarifaVigente = Number(tarifaRes.rows[0]?.valor_tarifa || 0);
      if (!(tarifaVigente > 0)) {
        return res.status(400).json({
          error: "No existe una tarifa vigente para este consultor, cliente, módulo y tipo de asignación."
        });
      }
      valorHoraFinal = tarifaVigente;
      valorDiaFinal = null;
      totalPagarFinal =
        totalPagarInput !== null
          ? totalPagarInput
          : (horasAsignadasNum !== null ? horasAsignadasNum * tarifaVigente : null);
    }

    if (esHorasPorDemanda) {
      horasAsignadasFinal = null;
      cantidadDiasFinal = null;
      totalPagarFinal = 0;
    } else if (!esMensual && totalPagarFinal === null && valorHoraFinal !== null && horasAsignadasFinal !== null) {
      totalPagarFinal = valorHoraFinal * horasAsignadasFinal;
    }

    const result = await pool.query(
      `INSERT INTO registro_asignaciones
        (id_consultoria, id_modulo, consultor_responsable_id, fecha_inicio, fecha_fin,
         cantidad_dias, horas_asignadas, valor_hora, valor_dia, tipo_servicio, total_pagar, estado, aprobar_coordinador)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::tipo_estado_asignacion,'Pendiente')
       RETURNING *`,
      [
        consultoriaId,
        moduloId,
        consultorId,
        fecha_inicio || null,
        fecha_fin || null,
        cantidadDiasFinal,
        horasAsignadasFinal,
        valorHoraFinal,
        valorDiaFinal,
        tipoServicioNormalizado,
        totalPagarFinal,
        estados.abierto
      ]
    );
    const created = result.rows[0];

    // Email al consultor asignado
    const mailInfo = await pool.query(
      `SELECT
         uc.email AS consultor_email,
         uc.nombre_usuario AS consultor_nombre,
         cli.titulo AS cliente,
         ta.titulo AS tipo_asignacion,
         m.titulo AS modulo,
         ucoord.nombre_usuario AS coordinador_nombre
       FROM consultorias con
         JOIN clientes cli ON cli.id = con.id_cliente
         LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
         LEFT JOIN modulo m ON m.id = $2
         LEFT JOIN usuarios ucoord ON ucoord.id = con.coordinador_responsable_id
         JOIN usuarios uc ON uc.id = $1
        WHERE con.id = $3`,
      [consultorId, moduloId, consultoriaId]
    );
    const row = mailInfo.rows[0];
    if (row?.consultor_email) {
      const portalUrl = buildPortalUrl("mis-asignaciones-consultor");
      await sendEmailSafe({
        ...getGraphContext(req),
        to: row.consultor_email,
        subject: `🚀 Nueva asignación: ${row.modulo || "Proyecto"} - ${row.cliente}`,
        text:
          `Hola ${row.consultor_nombre || ""},\n` +
          `Tienes una nueva asignación.\n` +
          `Cliente: ${row.cliente}\n` +
          `Tipo: ${row.tipo_asignacion || "N/A"}\n` +
          `Módulo: ${row.modulo || "N/A"}\n` +
          `Coordinador: ${row.coordinador_nombre || "N/A"}\n` +
          `Ingresa al portal: ${portalUrl}\n`,
        html: buildEmailLayout({
          title: "Nueva asignación de actividad",
          intro: `Hola <strong>${row.consultor_nombre || "Consultor"}</strong>, has sido asignado a una nueva actividad de consultoría.`,
          blocks: [
            { label: "Cliente", value: row.cliente },
            { label: "Módulo/Tecnología", value: row.modulo || "N/A" },
            { label: "Tipo de asignación", value: row.tipo_asignacion || "N/A" },
            { label: "Coordinador", value: row.coordinador_nombre || "N/A" }
          ],
          ctaLabel: "Ver asignación en el portal",
          ctaUrl: portalUrl
        })
      });
    }

    res.json(withPublicId(created));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(400).json({ error: "Consultoría, consultor o módulo no válido" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al crear asignación" });
  }
});


// Ruta Default para SPA (Siempre al final)
app.get("/", (req, res) => {
  //res.json({ ok: true, message: "API activo. Abre el frontend en http://localhost:3000" });
  res.send("API activo. Abre el frontend en http://localhost:3000");
});

/*const PORT = process.env.BACK_PORT || 4000;
app.listen(PORT, () => {
  console.log(`[OK] Backend listo en http://localhost:${PORT}`);
});
*/

/* ===============================
   SERVIDOR (CAMBIO CRÁTICO PARA AZURE)
=============================== */

// 1. Usar process.env.PORT (Obligatorio para Azure)
// 2. Mantener 4000 como fallback para tu entorno local
const port = process.env.PORT || process.env.BACK_PORT || 4000;

// 3. Añadir "0.0.0.0" asegura que el contenedor acepte conexiones externas
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[shutdown] Señal recibida: ${signal}. Cerrando API...`);

  const forceExitTimeout = setTimeout(() => {
    console.error("[shutdown] Timeout agotado. Forzando cierre.");
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  server.close(async () => {
    try {
      await pool.end();
      console.log("[shutdown] Pool de PostgreSQL cerrado.");
      process.exit(0);
    } catch (err) {
      console.error("[shutdown] Error cerrando pool:", err?.message || err);
      process.exit(1);
    }
  });
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

