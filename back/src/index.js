const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const envFile =
  process.env.NODE_ENV === "production" ? ".env_produccion" : ".env";
require("dotenv").config({ path: path.resolve(process.cwd(), envFile) });
const express = require("express");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const http = require("http");
const https = require("https");
const PDFDocument = require("pdfkit");
let PizZip = null;
let Docxtemplater = null;
try {
  PizZip = require("pizzip");
} catch (err) {
  console.error("[startup] No se pudo cargar 'pizzip'. Ejecuta npm install en el backend.", err?.message || err);
}
try {
  Docxtemplater = require("docxtemplater");
} catch (err) {
  console.error("[startup] No se pudo cargar 'docxtemplater'. Ejecuta npm install en el backend.", err?.message || err);
}
const { NumerosALetras } = require("numero-a-letras");
const { sendEmail, getGraphAccessToken } = require("./email");
const { pool, getPoolStats, isTransientDbError } = require("./db");
const { env } = require("./config/env");
const { requireAccess, requireAuthenticated, hasAccess } = require("./middlewares/access");
const registerPreregistroRoutes = require("./preregistro-routes");
const registerContratacionesRoutes = require("./contrataciones-routes");


const app = express();
const JWT_SECRET = env.JWT_SECRET;

if (process.env.NODE_ENV === "production" && !JWT_SECRET) {
  throw new Error("JWT_SECRET no está configurado en producción.");
}

/* ===============================
   CONFIGURACIÓN
=============================== */
app.use(helmet({
  contentSecurityPolicy: false
}));
app.set("trust proxy", 1);

/**
 * Normaliza el valor del origen (origin) de CORS, extrayendo el protocolo y dominio de una URL.
 */
function normalizeCorsOriginValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch (_) {
    return raw.replace(/\/+$/, "");
  }
}

/**
 * Extrae el origen a partir de una URL pública (utilizado en la configuración CORS).
 */
function extractOriginFromPublicUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch (_) {
    return null;
  }
}

/**
 * Verifica si un origen corresponde a la infraestructura de Azure Static Web Apps.
 */
function isAzureStaticWebAppsOrigin(origin) {
  const raw = normalizeCorsOriginValue(origin);
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return (
      parsed.protocol === "https:" &&
      /^([a-z0-9-]+)(\.\d+)?\.azurestaticapps\.net$/i.test(parsed.hostname)
    );
  } catch (_) {
    return false;
  }
}

const explicitCorsOrigins = new Set(
  [
    "http://localhost:3000",
    "http://localhost:4000",
    ...(env.CORS_ORIGINS || "").split(","),
    env.FRONT_PORTAL_BASE || "",
    env.CONTRATOS_BASE_URL || ""
  ]
    .map((value) => {
      const direct = normalizeCorsOriginValue(value);
      if (direct && /^https?:\/\//i.test(String(value || "").trim())) return direct;
      return extractOriginFromPublicUrl(value) || direct;
    })
    .filter(Boolean)
);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const normalizedOrigin = normalizeCorsOriginValue(origin);
    if (
      explicitCorsOrigins.has(normalizedOrigin) ||
      isAzureStaticWebAppsOrigin(normalizedOrigin)
    ) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Graph-Access-Token",
    "Cache-Control",
    "Pragma",
    "Expires"
  ],
  exposedHeaders: ["Authorization"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "35mb" }));
app.use(express.urlencoded({ extended: true, limit: "35mb" }));
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos, intenta más tarde" }
});
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/auth", authLimiter);
app.use("/auth", require("./routes/auth.routes"));
app.use("/webhooks", webhookLimiter);
app.use("/webhooks", require("./routes/webhook.routes"));
app.use("/clientes", require("./routes/clientes.routes"));
app.use(require("./routes/consultores.routes"));
app.use(require("./routes/catalogos.routes"));
app.use(require("./routes/usuarios.routes"));
app.use("/consultorias", require("./routes/consultorias.routes"));
app.use("/registro-asignaciones", require("./routes/registro-asignaciones.routes"));
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

/**
 * Limpia y reinicia las cachés en memoria que almacenan los estados de asignación, mesas y fábricas.
 */
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

/**
 * Normaliza etiquetas de texto (remueve tildes, espacios y convierte a minúsculas) para comparaciones de estados.
 */
function normalizeEnumLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Obtiene y cachea los valores del enum 'tipo_estado_asignacion' desde la base de datos.
 */
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

/**
 * Resuelve y mapea un estado de entrada con los estados válidos de asignación, soportando alias comunes.
 */
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

/**
 * Determina si una asignación está en un estado que permite el reporte de horas (ej. Abierto o En Proceso).
 */
function isAsignacionReportableEstado(estado, estados) {
  const rawNorm = normalizeEnumLabel(estado);
  if (!rawNorm) return false;
  const abiertoNorm = normalizeEnumLabel(estados?.abierto);
  const procesoNorm = normalizeEnumLabel(estados?.proceso);
  return rawNorm === abiertoNorm || rawNorm === procesoNorm;
}

/**
 * Normaliza el nombre del tipo de servicio (ej. Requerimiento, Incidente) manteniendo retrocompatibilidad.
 */
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

/**
 * Normaliza el input del perfil de fábrica asignado (ej. ABAP, FIORI).
 */
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

/**
 * Convierte un valor de fecha a formato YYYY-MM-DD, ignorando horas.
 */
function normalizeDateOnlyInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match?.[1]) return match[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Consulta la base de datos para obtener el último perfil de fábrica reportado en una asignación.
 */
async function getAssignedPerfilFabrica(db, registroAsignacionId, reporteId = null) {
  const reporteInternalId = Number(reporteId || 0);
  if (reporteInternalId > 0) {
    const specific = await db.query(
      `SELECT perfil_fabrica
       FROM reporte_horas
       WHERE id = $1
         AND id_registro_asignacion = $2
       LIMIT 1`,
      [reporteInternalId, registroAsignacionId]
    );
    const specificPerfil = normalizePerfilFabricaInput(specific.rows[0]?.perfil_fabrica);
    if (specificPerfil) return specificPerfil;
  }
  const latest = await db.query(
    `SELECT perfil_fabrica
     FROM reporte_horas
     WHERE id_registro_asignacion = $1
       AND NULLIF(BTRIM(perfil_fabrica), '') IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [registroAsignacionId]
  );
  return normalizePerfilFabricaInput(latest.rows[0]?.perfil_fabrica);
}

/**
 * Normaliza el estado de una mesa de servicio (ej. Cerrado, En proceso, Transferido).
 */
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

/**
 * Normaliza el estado de fábrica (ej. En desarrollo, Finalizado).
 */
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

/**
 * Consulta la base de datos genéricamente para obtener las etiquetas de un tipo Enum.
 */
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

function normalizeScopeInput(value) {
  const norm = normalizeEnumLabel(value);
  if (norm === "mesa") return "mesa";
  if (norm === "fabrica") return "fabrica";
  return null;
}

function normalizeTipoAsignacionTitulo(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compactTipoAsignacionTitulo(value) {
  return normalizeTipoAsignacionTitulo(value).replace(/\s+/g, "");
}

function isTipoAsignacionMensual(value) {
  const norm = normalizeTipoAsignacionTitulo(value);
  const compact = compactTipoAsignacionTitulo(value);
  return (
    norm.includes("full") ||
    norm.includes("part") ||
    norm.includes("mensual") ||
    compact.includes("mensual") ||
    norm.includes("tiempo completo") ||
    compact.includes("tiempocompleto") ||
    norm.includes("medio tiempo") ||
    compact.includes("mediotiempo")
  );
}

function isTipoAsignacionTiempoCostoFijo(value) {
  const norm = normalizeTipoAsignacionTitulo(value);
  const compact = compactTipoAsignacionTitulo(value);
  return norm.includes("tiempo y costo fijo") || compact.includes("tiempoycostofijo");
}

function isTipoAsignacionHorasPorDemanda(value) {
  const norm = normalizeTipoAsignacionTitulo(value);
  const compact = compactTipoAsignacionTitulo(value);
  return norm.includes("horas por demanda") || compact.includes("horaspordemanda");
}

function isTipoAsignacionMesa(value) {
  const norm = normalizeTipoAsignacionTitulo(value);
  const compact = compactTipoAsignacionTitulo(value);
  return (
    norm.includes("mesa") ||
    norm.includes("service desk") ||
    compact.includes("servicedesk")
  );
}

function isTipoAsignacionFabrica(value) {
  const norm = normalizeTipoAsignacionTitulo(value);
  return norm.includes("fabrica");
}

function isTipoAsignacionMesaOFabrica(value) {
  return isTipoAsignacionMesa(value) || isTipoAsignacionFabrica(value);
}

function getMesaFabricaScope(tipoAsignacionId, tipoAsignacionTitulo, hints = {}, preferredScope = null) {
  const explicitScope =
    normalizeScopeInput(preferredScope) ||
    normalizeScopeInput(hints?.scope) ||
    normalizeScopeInput(hints?.scope_mesa_fabrica);
  if (explicitScope) return explicitScope;

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
  if (hasFabricaHints && !hasMesaHints) return "fabrica";
  if (hasMesaHints && !hasFabricaHints) return "mesa";

  const hasMesaByTitle = isTipoAsignacionMesa(tituloNorm);
  const hasFabricaByTitle = isTipoAsignacionFabrica(tituloNorm);

  const tipoAsignacionNumeric = Number(tipoAsignacionId || 0);
  if (hasFabricaByTitle && !hasMesaByTitle) return "fabrica";
  if (hasMesaByTitle && !hasFabricaByTitle) return "mesa";
  // Compatibilidad con instalaciones que usan ids clásicos 5/6.
  if (tipoAsignacionNumeric === 6) return "fabrica";
  if (tipoAsignacionNumeric === 5) return "mesa";
  if (hasFabricaHints) return "fabrica";
  if (hasMesaHints) return "mesa";
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
  const graphAccessToken = String(req?.headers?.["x-graph-access-token"] || "").trim();
  const graphUserEmail = String(req?.user?.email || "").trim().toLowerCase();
  return {
    graphAccessToken: graphAccessToken || null,
    graphUserEmail: graphUserEmail || null
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
  env.FRONT_PORTAL_BASE ||
  "https://icy-ground-03832ec1e.1.azurestaticapps.net/index.html";
const readEnvSecret = (value) => String(value || "").trim().replace(/^['"]+|['"]+$/g, "");
const ONEDRIVE_ENABLED = String(process.env.ONEDRIVE_ENABLED || "true").toLowerCase() === "true";
const ONEDRIVE_TARGET_USER = process.env.ONEDRIVE_TARGET_USER || "admin.apps@silverconsulting.com.co";
const ONEDRIVE_ROOT_FOLDER = process.env.ONEDRIVE_ROOT_FOLDER || "AdjuntosCuentasCobro";
const CONTRATOS_ONEDRIVE_FOLDER = process.env.CONTRATOS_ONEDRIVE_FOLDER || "ContratosFirmados";
const ANEXO_INDIVIDUAL_ONEDRIVE_FOLDER = "AnexoTecnicoIndividual";
const CONTRATOS_TOKEN_EXPIRY_HOURS = Math.max(1, Number(process.env.CONTRATOS_TOKEN_EXPIRY_HOURS || 72));
const CONTRATOS_BASE_URL = String(env.CONTRATOS_BASE_URL || "").trim().replace(/\/+$/, "");
const CONTRATOS_FIRMA_COMPLETADA_NOTIFY_TO = String(process.env.CONTRATOS_FIRMA_COMPLETADA_NOTIFY_TO || "").trim();
const CONTRATOS_FIRMA_COMPLETADA_FALLBACK_NOTIFY = "ana.garcia@silverconsulting.com.co";
const ANEXO_INDIVIDUAL_FALLBACK_NOTIFY_EMAIL = String(
  process.env.ANEXO_INDIVIDUAL_NOTIFY_EMAIL || CONTRATOS_FIRMA_COMPLETADA_FALLBACK_NOTIFY
).trim();
const CONTRATOS_FIRMA_COMPLETADA_SENDER = String(
  process.env.CONTRATOS_FIRMA_COMPLETADA_SENDER || "admin.apps@silverconsulting.com.co"
).trim();
const CLICKSIGN_API_BASE = String(process.env.CLICKSIGN_API_BASE || "https://api.lleida.net/cs/v1").trim().replace(/\/+$/, "");
const CLICKSIGN_API_KEY = String(process.env.CLICKSIGN_API_KEY || "").trim();
const CLICKSIGN_USER = String(process.env.CLICKSIGN_USER || "").trim();
const CLICKSIGN_CONFIG_ID = Number(process.env.CLICKSIGN_CONFIG_ID || 0);
const CLICKSIGN_CONTRATOS_CONFIG_ID = Number(process.env.CLICKSIGN_CONTRATOS_CONFIG_ID || 0) || CLICKSIGN_CONFIG_ID;
const CLICKSIGN_SIGNATURE_CB_URL = String(process.env.CLICKSIGN_SIGNATURE_CB_URL || "").trim();
const CLICKSIGN_SIGNATORY_CB_URL = String(process.env.CLICKSIGN_SIGNATORY_CB_URL || "").trim();
const CLICKSIGN_SIGNATORY_EMAIL_CB_URL = String(process.env.CLICKSIGN_SIGNATORY_EMAIL_CB_URL || "").trim();
const CLICKSIGN_WEBHOOK_TOKEN = String(env.CLICKSIGN_WEBHOOK_TOKEN || "").trim();
const CLICKSIGN_SIGNED_FILE_URL_TEMPLATE = String(process.env.CLICKSIGN_SIGNED_FILE_URL_TEMPLATE || "").trim();
const CLICKSIGN_SIGNED_NOTIFY_ENABLED = String(process.env.CLICKSIGN_SIGNED_NOTIFY_ENABLED || "true").toLowerCase() === "true";
const CLICKSIGN_SIGNED_NOTIFY_TO = String(process.env.CLICKSIGN_SIGNED_NOTIFY_TO || "proveedores@silverconsulting.com.co").trim();
const CLICKSIGN_SIGNED_NOTIFY_CC = String(process.env.CLICKSIGN_SIGNED_NOTIFY_CC || "").trim();
const CLICKSIGN_SIGNED_NOTIFY_BCC = String(process.env.CLICKSIGN_SIGNED_NOTIFY_BCC || "").trim();
const DEBUG_CLICKSIGN_TOKEN = String(env.DEBUG_CLICKSIGN_TOKEN || "").trim();
const ADOBE_PDF_CREDENTIALS_JSON = readEnvSecret(process.env.ADOBE_PDF_CREDENTIALS_JSON || process.env.ADOBE_PDF_CREDENTIALS || "");
const ADOBE_PDF_CREDENTIALS_OBJECT = parseJsonObject(ADOBE_PDF_CREDENTIALS_JSON || "{}");
const ADOBE_PDF_CLIENT_ID = readEnvSecret(
  process.env.ADOBE_PDF_CLIENT_ID ||
  ADOBE_PDF_CREDENTIALS_OBJECT?.client_credentials?.client_id ||
  ""
);
const ADOBE_PDF_CLIENT_SECRET = readEnvSecret(
  process.env.ADOBE_PDF_CLIENT_SECRET ||
  ADOBE_PDF_CREDENTIALS_OBJECT?.client_credentials?.client_secret ||
  ""
);
const ADOBE_PDF_ORGANIZATION_ID = readEnvSecret(
  process.env.ADOBE_PDF_ORGANIZATION_ID ||
  ADOBE_PDF_CREDENTIALS_OBJECT?.service_principal_credentials?.organization_id ||
  ""
);
const ADOBE_PDF_API_BASE = String(process.env.ADOBE_PDF_API_BASE || "https://pdf-services.adobe.io").trim().replace(/\/+$/, "");
const ADOBE_PDF_TOKEN_URL = String(process.env.ADOBE_PDF_TOKEN_URL || `${ADOBE_PDF_API_BASE}/token`).trim();
const ADOBE_PDF_SCOPE = String(process.env.ADOBE_PDF_SCOPE || "").trim();
const ADOBE_PDF_TIMEOUT_MS = Math.max(15000, Number(process.env.ADOBE_PDF_TIMEOUT_MS || 60000));
const ADOBE_PDF_POLL_INTERVAL_MS = Math.max(800, Number(process.env.ADOBE_PDF_POLL_INTERVAL_MS || 1500));
const ADOBE_PDF_POLL_TIMEOUT_MS = Math.max(10000, Number(process.env.ADOBE_PDF_POLL_TIMEOUT_MS || 120000));
const ADOBE_PDF_RETRY_COUNT = Math.max(0, Math.min(3, Number(process.env.ADOBE_PDF_RETRY_COUNT || 1)));
const CONTRATOS_REPRESENTANTE_LEGAL = String(process.env.CONTRATOS_REPRESENTANTE_LEGAL || "DANIELA BELTRAN GOMEZ").trim();
const CONTRATOS_CEDULA_REPRESENTANTE = String(process.env.CONTRATOS_CEDULA_REPRESENTANTE || "1128472903").trim();
const CONTRATOS_NIT_SILVER = String(process.env.CONTRATOS_NIT_SILVER || "901149190-0").trim();
const CONTRATOS_CIUDAD_SILVER = String(process.env.CONTRATOS_CIUDAD_SILVER || "Medellin").trim();
const CONTRATOS_SILVER_RAZON_SOCIAL = String(process.env.CONTRATOS_SILVER_RAZON_SOCIAL || "SILVER CONSULTING S.A.S.").trim();
const CONTRATOS_SILVER_DOMICILIO = String(process.env.CONTRATOS_SILVER_DOMICILIO || "Medellín – Antioquia").trim();
const CONTRATOS_CAPITAL_RAZON_SOCIAL = String(process.env.CONTRATOS_CAPITAL_RAZON_SOCIAL || "CAPITALINK S.A.S.").trim();
const CONTRATOS_CAPITAL_REPRESENTANTE_LEGAL = String(process.env.CONTRATOS_CAPITAL_REPRESENTANTE_LEGAL || "CINDY CATALINA LOAIZA CARDONA").trim();
const CONTRATOS_CAPITAL_CEDULA_REPRESENTANTE = String(process.env.CONTRATOS_CAPITAL_CEDULA_REPRESENTANTE || "1036629658").trim();
const CONTRATOS_CAPITAL_NIT = String(process.env.CONTRATOS_CAPITAL_NIT || "901473416-8").trim();
const CONTRATOS_CAPITAL_CIUDAD = String(process.env.CONTRATOS_CAPITAL_CIUDAD || "Medellin").trim();
const CONTRATOS_CAPITAL_DOMICILIO = String(process.env.CONTRATOS_CAPITAL_DOMICILIO || "Medellín – Antioquia").trim();
const CONTRATOS_DOCX_DIR = path.join(__dirname, "static", "contratos");
function resolveEmpresaContratoConfig(facturaEnColombia) {
  if (facturaEnColombia === false) {
    return {
      key: "capital",
      razonSocial: CONTRATOS_CAPITAL_RAZON_SOCIAL,
      representanteLegal: CONTRATOS_CAPITAL_REPRESENTANTE_LEGAL,
      cedulaRepresentante: CONTRATOS_CAPITAL_CEDULA_REPRESENTANTE,
      nit: CONTRATOS_CAPITAL_NIT,
      ciudad: CONTRATOS_CAPITAL_CIUDAD,
      domicilio: CONTRATOS_CAPITAL_DOMICILIO
    };
  }
  return {
    key: "silver",
    razonSocial: CONTRATOS_SILVER_RAZON_SOCIAL,
    representanteLegal: CONTRATOS_REPRESENTANTE_LEGAL,
    cedulaRepresentante: CONTRATOS_CEDULA_REPRESENTANTE,
    nit: CONTRATOS_NIT_SILVER,
    ciudad: CONTRATOS_CIUDAD_SILVER,
    domicilio: CONTRATOS_SILVER_DOMICILIO
  };
}

function defineContratoDoc(docKey, titulo, templateFiles) {
  const files = Object.freeze({ ...templateFiles });
  return Object.freeze({
    doc_key: docKey,
    titulo,
    template_file: files.silver,
    template_files: files
  });
}

const CONTRATO_DOC_DEFINITIONS_FULL = Object.freeze([
  defineContratoDoc("contrato_prestacion_servicios", "Contrato Prestacion de Servicios", {
    silver: "Contrato Prestación de Servicios .docx",
    capital: "ContratoPrestacionServicioCapital.docx"
  }),
  defineContratoDoc("acuerdo_confidencialidad", "Acuerdo de Confidencialidad", {
    silver: "Acuerdo de Confidencialidad .docx",
    capital: "AcuerdoConfidencialdiadCapital.docx"
  }),
  defineContratoDoc("politica_garantia", "Politica de Garantia", {
    silver: "Política de Garantía.docx",
    capital: "PoliticaGarantiaCapital.docx"
  }),
  defineContratoDoc("autorizacion_datos_personales", "Autorizacion de Tratamiento de Datos Personales", {
    silver: "AUTORIZACIÓN EXPRESA PARA EL TRATAMIENTO DE DATOS PERSONALES.docx",
    capital: "AutorizacionTratamientoDatosCapital.docx"
  }),
  defineContratoDoc("anexo_tecnico", "Anexo Tecnico", {
    silver: "Anexo Técnico.docx",
    capital: "AnexoTecnicoCapital.docx"
  })
]);
const CONTRATO_DOC_DEFINITIONS_ANEXO_ONLY = Object.freeze(
  CONTRATO_DOC_DEFINITIONS_FULL.filter((d) => d.doc_key === "anexo_tecnico")
);
const CONTRATO_DOC_DEFINITIONS_BY_KEY = new Map(
  CONTRATO_DOC_DEFINITIONS_FULL.map((d) => [d.doc_key, d])
);
const LEGACY_DOC_INDEX_TO_KEY = new Map([
  [1, "contrato_prestacion_servicios"],
  [2, "anexo_tecnico"]
]);
const ANEXO_TIPO_LABELS = Object.freeze({
  full_time: "Full time",
  medio_tiempo: "Medio tiempo",
  horas: "Horas",
  capacitacion: "Capacitacion",
  proyecto: "Proyecto"
});
const docxTemplateCache = new Map();
const docxToPdfQueue = [];
let docxToPdfBusy = false;
let adobePdfTokenCache = {
  accessToken: "",
  expiresAtMs: 0
};
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
    .map((b) => `
      <tr>
        <td style="padding:0 0 8px 0;font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.45;color:#20272f;">
          <strong>${b.label}:</strong> ${b.value || "N/A"}
        </td>
      </tr>
    `)
    .join("");

  const ctaHtml = ctaLabel && ctaUrl
    ? `
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:14px;">
        <tr>
          <td bgcolor="#189fa9" style="border-radius:10px;">
            <a href="${ctaUrl}" style="display:inline-block;padding:10px 16px;font-family:Segoe UI,Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">
              ${ctaLabel}
            </a>
          </td>
        </tr>
      </table>
    `
    : "";

  return `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${title || "Notificación"}</title>
      </head>
      <body style="margin:0;padding:0;background:#f3f6fb;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f6fb;padding:20px 10px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid #dfe6f2;border-radius:14px;overflow:hidden;">
                <tr>
                  <td style="padding:20px 22px;font-family:Segoe UI,Arial,sans-serif;color:#20272f;">
                    <h2 style="margin:0 0 12px 0;font-size:22px;line-height:1.25;color:#1f2a37;">${title}</h2>
                    <p style="margin:0 0 14px 0;font-size:14px;line-height:1.5;">${intro}</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f8fb;border:1px solid #e6ebf2;border-radius:12px;padding:14px 16px;">
                      ${blockHtml}
                    </table>
                    ${ctaHtml}
                    <p style="margin:16px 0 0 0;font-size:13px;line-height:1.45;color:#5b6678;">${closing || "Atentamente, Silver Consulting."}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
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
  // Soft check rápido (no es race-safe, pero evita el roundtrip a DB si ya sabemos que se envió)
  if (prev.enviada) return prev;

  // Candado atómico en DB: solo el primer proceso que ejecute este UPDATE procede a enviar.
  // Si otro proceso ya marcó enviada=true (o está en proceso), rowCount=0 y abortamos.
  const cuentaPublicId = cuenta?.public_id;
  if (cuentaPublicId) {
    const claim = await pool.query(
      `UPDATE cuenta_cobro
       SET datos_adjuntos = jsonb_set(
         datos_adjuntos,
         '{firma,notificacion_proveedores,enviada}',
         'true'::jsonb,
         true
       )
       WHERE public_id = $1
         AND COALESCE((datos_adjuntos->'firma'->'notificacion_proveedores'->>'enviada')::boolean, false) = false
       RETURNING id`,
      [cuentaPublicId]
    );
    if (claim.rowCount === 0) {
      // Otro proceso ya reclamó el envío
      return { ...prev, enviada: true };
    }
  }

  const cuentaRef = resolveCuentaCobroReference(cuenta);
  const cuentaNumero = String(cuenta.id || "");
  const consultorNombre = resolveCuentaCobroConsultorNombre(cuenta);
  const subject = `Cuenta de cobro firmada | ${consultorNombre} | N° ${cuentaNumero}`;
  const senderEmail = String(cuenta?.email || graphContext?.graphUserEmail || "").trim();
  const notificationLockKey = String(cuenta?.public_id || cuenta?.id || cuentaRef || "").trim();
  if (notificationLockKey) providerNotificationInFlight.add(notificationLockKey);
  try {
    const textoPlano =
      `Se completó la firma digital de una cuenta de cobro.\n` +
      `Consultor: ${consultorNombre}\n` +
      `Cuenta de cobro: N° ${cuentaNumero}\n` +
      `Documento firmado: ${documentoFirmado.url}\n`;
    const html = buildEmailLayout({
      title: "Cuenta de cobro firmada",
      intro: `Se completó la firma digital de la cuenta de cobro <strong>N° ${cuentaNumero}</strong>.`,
      blocks: [
        { label: "Consultor", value: consultorNombre },
        { label: "Cuenta de cobro", value: `N° ${cuentaNumero}` },
        { label: "Documento firmado", value: documentoFirmado.url }
      ],
      ctaLabel: "Abrir documento firmado",
      ctaUrl: documentoFirmado.url,
      closing: "Notificación automática del sistema de cuentas de cobro."
    });

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
  return ["Reclutamiento", "Entrevista", "Entrevistas", "Contratado", "Cerrado", "Cancelado"].includes(String(estado || "").trim());
}

function buildRrhhEstadoEmailContent({
  estado,
  perfil,
  cliente,
  modulo,
  coordinadorNombre,
  observaciones,
  portalUrl,
  senderName
}) {
  const base = {
    toName: coordinadorNombre || "Coordinador",
    perfil: perfil || "Perfil",
    cliente: cliente || "N/A",
    modulo: modulo || "N/A",
    nota: observaciones || "Sin nota registrada",
    url: portalUrl || buildPortalUrl("solicitudesCoord"),
    senderName: senderName || "Silver Consulting"
  };
  base.closing = `Atentamente, ${base.senderName}.`;

  if (estado === "Reclutamiento") {
    return {
      subject: `🔍 Actualización: Tu solicitud para ${base.perfil} ya está en Reclutamiento`,
      text:
        `Hola ${base.toName},\n\n` +
        `Te informamos que hemos iniciado la búsqueda activa de candidatos para tu solicitud de ${base.perfil} para el cliente ${base.cliente}.\n` +
        `Estamos filtrando hojas de vida que cumplan con los requisitos del módulo ${base.modulo}.\n\n` +
        `Ver solicitud en el sistema: ${base.url}\n\n` +
        `${base.closing}\n`,
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
        ctaUrl: base.url,
        closing: base.closing
      })
    };
  }

  if (estado === "Entrevista" || estado === "Entrevistas") {
    return {
      subject: `🤝 Actualización: Iniciamos fase de entrevistas para ${base.perfil}`,
      text:
        `Hola ${base.toName},\n\n` +
        `?Buenas noticias! Ya tenemos candidatos pre-seleccionados para la vacante de ${base.perfil}.\n` +
        `En los próximos días estaremos coordinando las agendas para las entrevistas técnicas/administrativas.\n\n` +
        `Ver solicitud en el sistema: ${base.url}\n\n` +
        `${base.closing}\n`,
      html: buildEmailLayout({
        title: "Solicitud en fase de entrevistas",
        intro: `Hola <strong>${base.toName}</strong>, ya contamos con candidatos pre-seleccionados.`,
        blocks: [
          { label: "Perfil", value: base.perfil },
          { label: "Cliente", value: base.cliente },
          { label: "Estado", value: "Entrevistas" }
        ],
        ctaLabel: "Ver solicitud en el sistema",
        ctaUrl: base.url,
        closing: base.closing
      })
    };
  }

  if (estado === "Contratado") {
    return {
      subject: `? ?Misión Cumplida! Vacante cubierta para ${base.perfil}`,
      text:
        `Hola ${base.toName},\n\n` +
        `Nos alegra informarte que el proceso para ${base.perfil} ha finalizado con éxito.\n` +
        `El candidato ha sido seleccionado y el proceso de contratación está en marcha.\n` +
        `La solicitud se marca como completada.\n\n` +
        `Ver solicitud en el sistema: ${base.url}\n\n` +
        `${base.closing}\n`,
      html: buildEmailLayout({
        title: "Solicitud completada",
        intro: `Hola <strong>${base.toName}</strong>, la vacante fue cubierta exitosamente.`,
        blocks: [
          { label: "Perfil", value: base.perfil },
          { label: "Cliente", value: base.cliente },
          { label: "Estado", value: "Contratado" }
        ],
        ctaLabel: "Ver solicitud en el sistema",
        ctaUrl: base.url,
        closing: base.closing
      })
    };
  }

  if (estado === "Cerrado" || estado === "Cancelado") {
    return {
      subject: `🚫 Notificación: Solicitud Cerrada - ${base.perfil}`,
      text:
        `Hola ${base.toName},\n\n` +
        `Se ha registrado el cierre de la solicitud para ${base.perfil}.\n` +
        `Motivo/Nota: ${base.nota}\n\n` +
        `Por favor, revisa los detalles y comienza el proceso correspondiente.\n\n` +
        `Ver solicitud en el sistema: ${base.url}\n\n` +
        `${base.closing}\n`,
      html: buildEmailLayout({
        title: "Solicitud cerrada",
        intro: `Hola <strong>${base.toName}</strong>, se registró el cierre de la solicitud.`,
        blocks: [
          { label: "Perfil", value: base.perfil },
          { label: "Cliente", value: base.cliente },
          { label: "Estado", value: "Cerrado" },
          { label: "Motivo/Nota", value: base.nota }
        ],
        ctaLabel: "Ver solicitud en el sistema",
        ctaUrl: base.url,
        closing: base.closing
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
  personas: "personas",
  consultorias: "consultorias",
  tarifaConsultor: "tarifa_consultor",
  registroAsignaciones: "registro_asignaciones",
  cuentaCobro: "cuenta_cobro",
  reporteHoras: "reporte_horas",
  solicitudesRrhh: "solicitudes_rrhh",
  preregistroPersonas: "preregistro_personas",
  solicitudesContratacion: "solicitudes_contratacion"
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

async function resolveInternalIdFromPublicIdOrId(db, tableName, value) {
  if (value === undefined || value === null || value === "") return null;
  if (!ALLOWED_PUBLIC_ID_TABLES.has(tableName)) {
    throw new Error(`Tabla no permitida para resolver id: ${tableName}`);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  if (isNumericId(raw)) {
    const numeric = Number(raw);
    if (Number.isInteger(numeric) && numeric > 0) {
      const res = await db.query(`SELECT id FROM ${tableName} WHERE id = $1`, [numeric]);
      return res.rows[0]?.id || null;
    }
  }

  if (isGuid(raw)) {
    const res = await db.query(`SELECT id FROM ${tableName} WHERE public_id = $1`, [raw]);
    return res.rows[0]?.id || null;
  }

  return null;
}

function toNullableTrimmedString(value) {
  const raw = String(value ?? "").trim();
  return raw || null;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) { }
  }
  return {};
}

function normalizeTextKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeAnexoTipoInput(value) {
  const key = normalizeTextKey(value);
  if (!key) return null;
  if (["fulltime", "tiempocompleto", "completo"].includes(key)) return "full_time";
  if (["mediotiempo", "parttime", "part", "medio"].includes(key)) return "medio_tiempo";
  if (["horas", "porhoras", "hora", "hourly"].includes(key)) return "horas";
  if (["capacitacion", "capacitaciones", "training"].includes(key)) return "capacitacion";
  if (["proyecto", "proyectos"].includes(key)) return "proyecto";
  return null;
}

function normalizeMonedaContrato(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  if (["COP", "USD", "EUR"].includes(raw)) return raw;
  return null;
}

function computeYearEndDate(value) {
  const ymd = normalizeDateOnlyInput(value);
  if (!ymd) return null;
  const year = Number(ymd.slice(0, 4));
  if (!Number.isInteger(year) || year < 1900) return null;
  return `${year}-12-31`;
}

function formatDateForTemplate(value) {
  const ymd = normalizeDateOnlyInput(value);
  if (!ymd) return "";
  const [year, month, day] = ymd.split("-");
  return `${day}/${month}/${year}`;
}

function formatMonthNameEs(value) {
  const ymd = normalizeDateOnlyInput(value) || new Date().toISOString().slice(0, 10);
  const [year, month, day] = ymd.split("-").map((p) => Number(p));
  if (!year || !month || !day) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("es-CO", { month: "long", timeZone: "UTC" })
    .format(date)
    .toLowerCase();
}

function formatCurrencyForTemplate(value, moneda = "COP") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  try {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: normalizeMonedaContrato(moneda) || "COP",
      maximumFractionDigits: 2
    }).format(amount);
  } catch (_) {
    return `${amount}`;
  }
}

function normalizeDocStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["signed", "firmado", "completado", "approved", "done"].includes(raw)) return "signed";
  if (["rejected", "rechazado", "declined", "cancelled", "canceled"].includes(raw)) return "rejected";
  return "pending";
}

function isDocxTemplateFailureMessage(messageRaw) {
  const msg = String(messageRaw || "").toLowerCase();
  return msg.includes("compilando plantilla") || msg.includes("renderizando plantilla") || msg.includes("template") || msg.includes("docxtemplater");
}

function isDocxInfraFailureMessage(messageRaw) {
  const msg = String(messageRaw || "").toLowerCase();
  return (
    msg.includes("libreoffice") ||
    msg.includes("soffice") ||
    msg.includes("no genero el pdf") ||
    msg.includes("timeout") ||
    msg.includes("codigo") ||
    msg.includes("dependencias docx") ||
    msg.includes("pizzip") ||
    msg.includes("docxtemplater") ||
    msg.includes("adobe") ||
    msg.includes("pdf-services.adobe.io") ||
    msg.includes("createpdf") ||
    msg.includes("assetid") ||
    msg.includes("uploaduri")
  );
}

function sanitizeDocxTagName(tag) {
  return String(tag || "")
    .replace(/\s+/g, "")
    .trim();
}

function createDocxtemplaterParser(tag) {
  const rawTag = sanitizeDocxTagName(tag);
  const tagName = rawTag.replace(/^[#/^]/, "");
  const segments = tagName.split(".").filter(Boolean);
  return {
    get(scope) {
      if (!segments.length) return "";
      let cursor = scope;
      for (const segment of segments) {
        if (cursor === undefined || cursor === null) return "";
        cursor = cursor[segment];
      }
      if (cursor === undefined || cursor === null) return "";
      return cursor;
    }
  };
}

function getContratoEmpresaKey(facturaEnColombia) {
  return resolveEmpresaContratoConfig(facturaEnColombia).key;
}

function hydrateContratoDocDefinitionForEmpresa(def, facturaEnColombia = null) {
  if (!def) return null;
  const empresaKey = getContratoEmpresaKey(facturaEnColombia);
  const templateFile =
    def.template_files?.[empresaKey] ||
    def.template_file ||
    def.template_files?.silver ||
    null;
  return {
    ...def,
    empresa_key: empresaKey,
    template_file: templateFile
  };
}

function getEmpresaKeyFromContratoTemplate(def, templateFile, fallbackKey = null) {
  const safeTemplate = toNullableTrimmedString(templateFile);
  if (!def?.template_files || !safeTemplate) return fallbackKey;
  const normalizedTemplate = normalizeTemplateFileName(safeTemplate);
  const match = Object.entries(def.template_files).find(([, fileName]) => (
    normalizeTemplateFileName(fileName) === normalizedTemplate
  ));
  return match?.[0] || fallbackKey;
}

function getContratoDocDefinition(docKey, facturaEnColombia = null) {
  if (!docKey) return null;
  return hydrateContratoDocDefinitionForEmpresa(
    CONTRATO_DOC_DEFINITIONS_BY_KEY.get(String(docKey)) || null,
    facturaEnColombia
  );
}

function isDocFirmaDefinitionLocked(doc) {
  if (!doc || typeof doc !== "object") return false;
  if (normalizeDocStatus(doc.estado) === "signed") return true;
  return Boolean(
    toNullableTrimmedString(doc.request_id) ||
    toNullableTrimmedString(doc.contract_id) ||
    toNullableTrimmedString(doc.signature_id) ||
    toNullableTrimmedString(doc.url_firma)
  );
}

function resolveContratoDocDefinitionForFirma(docKey, { facturaEnColombia = null, doc = null } = {}) {
  const def = getContratoDocDefinition(docKey, facturaEnColombia);
  if (!def) return null;
  const lockedTemplate = isDocFirmaDefinitionLocked(doc)
    ? toNullableTrimmedString(doc?.template_file)
    : null;
  const empresaKey = lockedTemplate
    ? getEmpresaKeyFromContratoTemplate(def, lockedTemplate, def.empresa_key)
    : def.empresa_key;
  return {
    ...def,
    empresa_key: empresaKey,
    titulo: toNullableTrimmedString(doc?.titulo) || def.titulo,
    template_file: lockedTemplate || def.template_file
  };
}

function buildDocsFirmaPlan({ hasContratoBase = false, facturaEnColombia = null } = {}) {
  const baseDefs = hasContratoBase ? CONTRATO_DOC_DEFINITIONS_ANEXO_ONLY : CONTRATO_DOC_DEFINITIONS_FULL;
  const defs = baseDefs.map((def) => hydrateContratoDocDefinitionForEmpresa(def, facturaEnColombia));
  return defs.map((def, index) => ({
    doc_index: index + 1,
    doc_key: def.doc_key,
    titulo: def.titulo,
    template_file: def.template_file,
    empresa_key: def.empresa_key,
    estado: "pending",
    request_id: null,
    contract_id: null,
    url_firma: null,
    onedrive_url: null,
    onedrive_carpeta: null,
    onedrive_carpeta_url: null
  }));
}

function normalizeDocsFirmaList(docsRaw, options = {}) {
  const hasFacturaContext = Object.prototype.hasOwnProperty.call(options || {}, "facturaEnColombia");
  const facturaEnColombia = hasFacturaContext ? options.facturaEnColombia : null;
  const docs = Array.isArray(docsRaw) ? docsRaw : [];
  const normalized = docs
    .map((doc, index) => {
      if (!doc || typeof doc !== "object") return null;
      const rawIndex = Number(doc.doc_index);
      const docIndex = Number.isInteger(rawIndex) && rawIndex > 0 ? rawIndex : index + 1;
      const legacyDocKey = LEGACY_DOC_INDEX_TO_KEY.get(docIndex) || null;
      const docKey = toNullableTrimmedString(doc.doc_key) || legacyDocKey;
      const def = resolveContratoDocDefinitionForFirma(docKey, { facturaEnColombia, doc });
      const locked = isDocFirmaDefinitionLocked(doc);
      const existingTemplateFile = toNullableTrimmedString(doc.template_file);
      const resolvedTemplateFile = locked || !hasFacturaContext
        ? (existingTemplateFile || def?.template_file || null)
        : (def?.template_file || existingTemplateFile || null);
      const resolvedEmpresaKey = locked || !hasFacturaContext
        ? (
          toNullableTrimmedString(doc.empresa_key) ||
          getEmpresaKeyFromContratoTemplate(def, resolvedTemplateFile, def?.empresa_key || null)
        )
        : (def?.empresa_key || toNullableTrimmedString(doc.empresa_key) || null);
      return {
        ...doc,
        doc_index: docIndex,
        doc_key: docKey,
        titulo: toNullableTrimmedString(doc.titulo) || def?.titulo || `Documento ${docIndex}`,
        template_file: resolvedTemplateFile,
        empresa_key: resolvedEmpresaKey,
        estado: normalizeDocStatus(doc.estado)
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.doc_index || 0) - Number(b.doc_index || 0));
  return normalized;
}

function normalizeDocsFirmaListCompat(docsRaw, options = {}) {
  if (typeof normalizeDocsFirmaList === "function") {
    try {
      return normalizeDocsFirmaList(docsRaw, options);
    } catch (err) {
      console.warn("No se pudo normalizar docs_firma con funcion principal:", err?.message || err);
    }
  }
  const docs = Array.isArray(docsRaw) ? docsRaw : [];
  return docs
    .map((doc, index) => {
      if (!doc || typeof doc !== "object") return null;
      const rawIndex = Number(doc.doc_index);
      const docIndex = Number.isInteger(rawIndex) && rawIndex > 0 ? rawIndex : index + 1;
      return {
        ...doc,
        doc_index: docIndex,
        estado: normalizeDocStatus(doc.estado)
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.doc_index || 0) - Number(b.doc_index || 0));
}

function refreshDocsFirmaDefinitionsForContext(docsRaw, { facturaEnColombia = null } = {}) {
  return normalizeDocsFirmaListCompat(docsRaw, { facturaEnColombia }).map((doc) => {
    const docKey = toNullableTrimmedString(doc.doc_key) || LEGACY_DOC_INDEX_TO_KEY.get(Number(doc.doc_index)) || null;
    const def = getContratoDocDefinition(docKey, facturaEnColombia);
    if (!def) return doc;
    if (isDocFirmaDefinitionLocked(doc)) {
      return {
        ...doc,
        doc_key: def.doc_key,
        titulo: toNullableTrimmedString(doc.titulo) || def.titulo,
        template_file: toNullableTrimmedString(doc.template_file) || def.template_file,
        empresa_key:
          toNullableTrimmedString(doc.empresa_key) ||
          getEmpresaKeyFromContratoTemplate(def, doc.template_file, def.empresa_key)
      };
    }
    return {
      ...doc,
      doc_key: def.doc_key,
      titulo: def.titulo,
      template_file: def.template_file,
      empresa_key: def.empresa_key
    };
  });
}

function upsertDocFirmaEntry(docsRaw, entry, options = {}) {
  const docs = normalizeDocsFirmaListCompat(docsRaw, options);
  const targetIndex = Number(entry?.doc_index || 0);
  const filtered = docs.filter((doc) => Number(doc.doc_index || 0) !== targetIndex);
  return [...filtered, entry].sort((a, b) => Number(a.doc_index || 0) - Number(b.doc_index || 0));
}

async function hasContratoBaseFirmado({ correoPersonal = null, numeroDocumento = null } = {}) {
  const correo = toNullableTrimmedString(correoPersonal);
  const documento = toNullableTrimmedString(numeroDocumento);
  if (!correo && !documento) return false;

  if (documento) {
    const byDocumento = await pool.query(
      `
      SELECT 1
      FROM tokens_firma_contrato tf
      LEFT JOIN solicitudes_contratacion sc ON sc.id = tf.solicitud_id
      LEFT JOIN preregistro_personas pp ON pp.id = tf.preregistro_id
      WHERE tf.estado = 'completado'
        AND COALESCE(sc.estado, 'Completado') <> 'Cancelado'
        AND COALESCE(pp.estado, 'Completado') <> 'Anulado'
        AND (
          COALESCE(sc.numero_documento, '') = $1
          OR COALESCE(pp.numero_documento, '') = $1
        )
      LIMIT 1
      `,
      [documento]
    );
    if (byDocumento.rowCount > 0) return true;
  }

  if (!correo) return false;
  const byCorreo = await pool.query(
    `
    SELECT 1
    FROM tokens_firma_contrato tf
    LEFT JOIN solicitudes_contratacion sc ON sc.id = tf.solicitud_id
    LEFT JOIN preregistro_personas pp ON pp.id = tf.preregistro_id
    WHERE tf.estado = 'completado'
      AND COALESCE(sc.estado, 'Completado') <> 'Cancelado'
      AND COALESCE(pp.estado, 'Completado') <> 'Anulado'
      AND LOWER(tf.correo_personal) = LOWER($1)
    LIMIT 1
    `,
    [correo]
  );
  return byCorreo.rowCount > 0;
}

async function ensureTokenDocsFirmaPlan(tokenRow) {
  const personaContext = await resolveContratoPersonaContext(tokenRow || {});
  const facturaEnColombia = personaContext?.facturaEnColombia ?? null;
  const docsStored = normalizeDocsFirmaListCompat(tokenRow?.docs_firma);
  if (docsStored.length > 0) {
    const refreshed = refreshDocsFirmaDefinitionsForContext(docsStored, { facturaEnColombia });
    if (tokenRow?.id && JSON.stringify(docsStored) !== JSON.stringify(refreshed)) {
      await pool.query(
        `UPDATE tokens_firma_contrato
         SET docs_firma = $1::jsonb,
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(refreshed), tokenRow.id]
      );
    }
    return refreshed;
  }
  const hasBase = await hasContratoBaseFirmado({
    correoPersonal: personaContext?.correoPersonal || tokenRow?.correo_personal || null,
    numeroDocumento: personaContext?.numeroDocumento || null
  });
  const planned = buildDocsFirmaPlan({ hasContratoBase: hasBase, facturaEnColombia });
  if (tokenRow?.id) {
    await pool.query(
      `UPDATE tokens_firma_contrato
       SET docs_firma = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(planned), tokenRow.id]
    );
  }
  return planned;
}


const MAX_TICKETS_POR_ASIGNACION = 200;

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

function toBooleanInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "si", "sí", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  return fallback;
}

function normalizeNullableBooleanInput(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "si", "sí", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  return null;
}

function inferAnexoTipoFromContext(ctx) {
  const extra = parseJsonObject(ctx?.datos_extra);
  const candidates = [
    extra.tipo_asignacion,
    extra.tipo_contrato,
    extra.modalidad_contrato,
    extra.modalidad,
    ctx?.modalidad_contrato
  ];
  for (const candidate of candidates) {
    const normalized = normalizeAnexoTipoInput(candidate);
    if (normalized) return normalized;
  }
  if (Number(ctx?.tarifa_capacitacion || 0) > 0 && Number(ctx?.tarifa_hora || 0) <= 0) return "capacitacion";
  if (Number(ctx?.tarifa_hora || 0) > 0 && Number(ctx?.tarifa_mes || 0) <= 0) return "horas";
  return "full_time";
}

function inferAnexoTarifaFromContext(ctx, tipoAsignacion) {
  const extra = parseJsonObject(ctx?.datos_extra);
  const proyectoValues = [extra.valor_proyecto, extra.tarifa_proyecto, extra.valor_tarifa_proyecto];
  if (tipoAsignacion === "horas") return toNullableNumber(ctx?.tarifa_hora);
  if (tipoAsignacion === "medio_tiempo") return toNullableNumber(ctx?.tarifa_medio_tiempo ?? ctx?.tarifa_mes);
  if (tipoAsignacion === "capacitacion") return toNullableNumber(ctx?.tarifa_capacitacion ?? ctx?.tarifa_hora ?? ctx?.tarifa_mes);
  if (tipoAsignacion === "proyecto") {
    for (const value of proyectoValues) {
      const parsed = toNullableNumber(value);
      if (parsed !== null) return parsed;
    }
    return toNullableNumber(ctx?.tarifa_mes ?? ctx?.tarifa_hora);
  }
  return toNullableNumber(ctx?.tarifa_mes ?? ctx?.tarifa_medio_tiempo ?? ctx?.tarifa_hora);
}

function inferAnexoDatesFromContext(ctx, tipoAsignacion) {
  const fechaInicio =
    normalizeDateOnlyInput(ctx?.fecha_extension_desde) ||
    normalizeDateOnlyInput(ctx?.fecha_inicio) ||
    normalizeDateOnlyInput(ctx?.created_at) ||
    new Date().toISOString().slice(0, 10);

  const isCorteAnual = tipoAsignacion === "horas" || tipoAsignacion === "capacitacion";
  if (isCorteAnual) {
    return {
      fecha_inicio: fechaInicio,
      fecha_fin: computeYearEndDate(fechaInicio),
      fecha_fin_calculada: true
    };
  }

  const fechaFin =
    normalizeDateOnlyInput(ctx?.fecha_extension_hasta) ||
    normalizeDateOnlyInput(ctx?.fecha_fin) ||
    normalizeDateOnlyInput(ctx?.fecha_retiro) ||
    null;
  const fechaFinFallback = fechaFin || computeYearEndDate(fechaInicio) || fechaInicio;

  return {
    fecha_inicio: fechaInicio,
    fecha_fin: fechaFinFallback,
    fecha_fin_calculada: !fechaFin
  };
}

async function getSolicitudContratacionDetalleById(internalId) {
  if (!internalId) return null;
  const r = await pool.query(
    `
    SELECT
      sc.id,
      sc.public_id,
      sc.tipo_solicitud,
      sc.origen_flujo,
      sc.modalidad_contrato,
      sc.persona_usuario_id,
      sc.coordinador_solicitante_id,
      sc.nombre,
      sc.apellidos,
      sc.numero_documento,
      sc.correo_personal,
      sc.telefono,
      sc.ubicacion,
      sc.preregistro_id,
      sc.tipo_documento_id,
      sc.cliente_id,
      c.public_id AS cliente_public_id,
      c.titulo AS cliente_nombre,
      CASE
        WHEN LOWER(BTRIM(sc.datos_extra->>'factura_en_colombia')) IN ('true', 't', '1', 'yes', 'y', 'on', 'si', 'sí') THEN true
        WHEN LOWER(BTRIM(sc.datos_extra->>'factura_en_colombia')) IN ('false', 'f', '0', 'no', 'n', 'off') THEN false
        ELSE NULL
      END AS factura_en_colombia,
      sc.datos_extra->>'tipo_persona' AS tipo_persona,
      sc.moneda,
      sc.tarifa_hora,
      sc.tarifa_mes,
      sc.tarifa_medio_tiempo,
      sc.tarifa_capacitacion,
      sc.fecha_inicio,
      sc.fecha_fin,
      sc.fecha_extension_desde,
      sc.fecha_extension_hasta,
      sc.fecha_retiro,
      sc.datos_extra,
      sc.created_at,
      di.public_id AS tipo_documento_public_id,
      di.titulo AS tipo_documento_titulo,
      di.codigo AS tipo_documento_codigo
    FROM solicitudes_contratacion sc
    LEFT JOIN clientes c ON c.id = sc.cliente_id
    LEFT JOIN documento_identidad di ON di.id = sc.tipo_documento_id
    WHERE sc.id = $1
    LIMIT 1
    `,
    [internalId]
  );
  return r.rows[0] || null;
}

async function getPreregistroDetalleById(internalId) {
  if (!internalId) return null;
  const r = await pool.query(
    `
    SELECT
      pp.id,
      pp.public_id,
      pp.id_usuario_creado,
      pp.nombre,
      pp.apellidos,
      pp.tipo_documento_id,
      pp.numero_documento,
      pp.correo_personal,
      pp.telefono,
      pp.ciudad,
      pp.pais_ubicacion,
      pp.direccion,
      pp.moneda,
      pp.tarifa_hora,
      pp.tarifa_mes,
      pp.tarifa_medio_tiempo,
      pp.tarifa_capacitacion,
      pp.fecha_fin,
      pp.created_at,
      pp.id_solicitud_rrhh,
      pp.factura_en_colombia,
      pp.tipo_persona,
      pp.razon_social,
      pp.nit_empresa,
      pp.representante_legal,
      pp.tipo_documento_representante,
      pp.numero_documento_representante,
      sr.modulo_id,
      m.public_id AS modulo_public_id,
      m.titulo AS modulo_titulo,
      sr.public_id AS rrhh_public_id,
      sr.cliente_id,
      c.public_id AS cliente_public_id,
      c.titulo AS cliente_nombre,
      di.public_id AS tipo_documento_public_id,
      di.titulo AS tipo_documento_titulo,
      di.codigo AS tipo_documento_codigo
    FROM preregistro_personas pp
    LEFT JOIN solicitudes_rrhh sr ON sr.id = pp.id_solicitud_rrhh
    LEFT JOIN modulo m ON m.id = sr.modulo_id
    LEFT JOIN clientes c ON c.id = sr.cliente_id
    LEFT JOIN documento_identidad di ON di.id = pp.tipo_documento_id
    WHERE pp.id = $1
    LIMIT 1
    `,
    [internalId]
  );
  return r.rows[0] || null;
}

async function resolvePreregistroFromSolicitudDatosExtra(solicitudRow) {
  if (solicitudRow?.preregistro_id) {
    return solicitudRow.preregistro_id;
  }
  const extra = parseJsonObject(solicitudRow?.datos_extra);
  const preregistroPublicId = toNullableTrimmedString(extra?.preregistro_id);
  if (!preregistroPublicId || !isGuid(preregistroPublicId)) return null;
  const r = await pool.query(
    `SELECT id
     FROM preregistro_personas
     WHERE public_id = $1
     LIMIT 1`,
    [preregistroPublicId]
  );
  return r.rows[0]?.id || null;
}

async function resolveFacturaEnColombiaFallback({ personaUsuarioId = null, numeroDocumento = null, correoPersonal = null } = {}) {
  const personaId = toNullableInteger(personaUsuarioId);
  const documento = toNullableTrimmedString(numeroDocumento);
  const correo = toNullableTrimmedString(correoPersonal);
  if (!personaId && !documento && !correo) return null;

  const r = await pool.query(
    `
    WITH usuario_base AS (
      SELECT u.*
      FROM usuarios u
      WHERE
        ($1::int IS NOT NULL AND u.id = $1)
        OR ($2::text IS NOT NULL AND NULLIF(BTRIM(u.cedula), '') = $2)
        OR ($3::text IS NOT NULL AND LOWER(NULLIF(BTRIM(u.email), '')) = LOWER($3))
      ORDER BY
        CASE WHEN $1::int IS NOT NULL AND u.id = $1 THEN 0 ELSE 1 END,
        u.id DESC
      LIMIT 1
    ),
    persona_base AS (
      SELECT p.*
      FROM personas p
      LEFT JOIN usuario_base u ON TRUE
      WHERE
        (u.persona_id IS NOT NULL AND p.id = u.persona_id)
        OR ($2::text IS NOT NULL AND NULLIF(BTRIM(p.numero_documento), '') = $2)
        OR ($3::text IS NOT NULL AND LOWER(NULLIF(BTRIM(p.correo_electronico), '')) = LOWER($3))
        OR (u.cedula IS NOT NULL AND NULLIF(BTRIM(p.numero_documento), '') = NULLIF(BTRIM(u.cedula), ''))
      ORDER BY
        CASE WHEN p.id = (SELECT persona_id FROM usuario_base LIMIT 1) THEN 0 ELSE 1 END,
        p.updated_at DESC NULLS LAST,
        p.id DESC
      LIMIT 1
    )
    SELECT COALESCE(p.factura_en_colombia, u.factura_en_colombia) AS factura_en_colombia
    FROM usuario_base u
    FULL JOIN persona_base p ON TRUE
    LIMIT 1
    `,
    [personaId || null, documento || null, correo || null]
  );
  return normalizeNullableBooleanInput(r.rows[0]?.factura_en_colombia);
}

async function resolveContratoPersonaContext(proceso) {
  const solicitud = await getSolicitudContratacionDetalleById(proceso?.solicitud_id || null);
  let preregistro = await getPreregistroDetalleById(proceso?.preregistro_id || null);

  if (!preregistro && solicitud) {
    const linkedPreregistroId = await resolvePreregistroFromSolicitudDatosExtra(solicitud);
    if (linkedPreregistroId) {
      preregistro = await getPreregistroDetalleById(linkedPreregistroId);
    }
  }

  const canonical = solicitud || preregistro || null;
  const nombreBase =
    toNullableTrimmedString(canonical?.nombre) ||
    toNullableTrimmedString(solicitud?.nombre) ||
    toNullableTrimmedString(preregistro?.nombre) ||
    toNullableTrimmedString(proceso?.nombre_persona) ||
    "";
  const apellidosBase =
    toNullableTrimmedString(canonical?.apellidos) ||
    toNullableTrimmedString(solicitud?.apellidos) ||
    toNullableTrimmedString(preregistro?.apellidos) ||
    "";
  const tipoDocumentoCodigoBase =
    toNullableTrimmedString(canonical?.tipo_documento_codigo) ||
    toNullableTrimmedString(solicitud?.tipo_documento_codigo) ||
    toNullableTrimmedString(preregistro?.tipo_documento_codigo) ||
    "";
  const tipoDocumentoTituloBase =
    toNullableTrimmedString(canonical?.tipo_documento_titulo) ||
    toNullableTrimmedString(solicitud?.tipo_documento_titulo) ||
    toNullableTrimmedString(preregistro?.tipo_documento_titulo) ||
    "";
  const tipoDocumentoPublicIdBase =
    toNullableTrimmedString(canonical?.tipo_documento_public_id) ||
    toNullableTrimmedString(solicitud?.tipo_documento_public_id) ||
    toNullableTrimmedString(preregistro?.tipo_documento_public_id) ||
    "";
  const tipoDocumentoIdBase =
    toNullableInteger(canonical?.tipo_documento_id) ||
    toNullableInteger(solicitud?.tipo_documento_id) ||
    toNullableInteger(preregistro?.tipo_documento_id) ||
    null;
  const numeroDocumentoBase =
    toNullableTrimmedString(canonical?.numero_documento) ||
    toNullableTrimmedString(solicitud?.numero_documento) ||
    toNullableTrimmedString(preregistro?.numero_documento) ||
    null;
  const correoPersonalBase =
    toNullableTrimmedString(canonical?.correo_personal) ||
    toNullableTrimmedString(solicitud?.correo_personal) ||
    toNullableTrimmedString(preregistro?.correo_personal) ||
    toNullableTrimmedString(proceso?.correo_personal) ||
    null;
  const usuarioContextId = solicitud?.persona_usuario_id || preregistro?.id_usuario_creado || null;
  const preregistroContextId = preregistro?.id || solicitud?.preregistro_id || null;
  const personaBase = await getContratoPersonaBaseRecord(pool, {
    usuarioId: usuarioContextId,
    numeroDocumento: numeroDocumentoBase,
    correoPersonal: correoPersonalBase,
    preregistroId: preregistroContextId
  });

  const nombre =
    toNullableTrimmedString(personaBase?.persona_nombre) ||
    nombreBase;
  const apellidos =
    toNullableTrimmedString(personaBase?.persona_apellidos) ||
    apellidosBase;
  const nombreCompleto = `${nombre} ${apellidos}`.trim() || toNullableTrimmedString(proceso?.nombre_persona) || "";
  const tipoDocumentoCodigo =
    toNullableTrimmedString(personaBase?.tipo_documento_codigo) ||
    toNullableTrimmedString(personaBase?.usuario_tipo_documento_codigo) ||
    tipoDocumentoCodigoBase;
  const tipoDocumentoTitulo =
    toNullableTrimmedString(personaBase?.tipo_documento_titulo) ||
    toNullableTrimmedString(personaBase?.usuario_tipo_documento_titulo) ||
    tipoDocumentoTituloBase;
  const tipoDocumentoPublicId =
    toNullableTrimmedString(personaBase?.tipo_documento_public_id) ||
    toNullableTrimmedString(personaBase?.usuario_tipo_documento_public_id) ||
    tipoDocumentoPublicIdBase;
  const tipoDocumentoId =
    toNullableInteger(personaBase?.tipo_documento_id) ||
    tipoDocumentoIdBase;
  const tipoDocumento = tipoDocumentoCodigo || tipoDocumentoTitulo || "";
  const numeroDocumento =
    toNullableTrimmedString(personaBase?.numero_documento) ||
    numeroDocumentoBase ||
    toNullableTrimmedString(personaBase?.usuario_cedula) ||
    null;
  const correoPersonal =
    toNullableTrimmedString(personaBase?.correo_electronico) ||
    correoPersonalBase ||
    toNullableTrimmedString(personaBase?.usuario_email) ||
    null;
  const telefono =
    toNullableTrimmedString(personaBase?.numero_contacto) ||
    toNullableTrimmedString(canonical?.telefono) ||
    toNullableTrimmedString(solicitud?.telefono) ||
    toNullableTrimmedString(preregistro?.telefono) ||
    toNullableTrimmedString(personaBase?.usuario_telefono) ||
    "";
  const direccion =
    toNullableTrimmedString(personaBase?.direccion_residencia) ||
    toNullableTrimmedString(preregistro?.direccion) ||
    toNullableTrimmedString(parseJsonObject(solicitud?.datos_extra)?.direccion) ||
    toNullableTrimmedString(personaBase?.usuario_direccion) ||
    "";
  const ciudad =
    toNullableTrimmedString(personaBase?.ciudad_residencia) ||
    toNullableTrimmedString(preregistro?.ciudad) ||
    toNullableTrimmedString(solicitud?.ubicacion) ||
    toNullableTrimmedString(personaBase?.usuario_ciudad) ||
    CONTRATOS_CIUDAD_SILVER;

  // personas/usuarios tienen prioridad aqui porque el formulario publico permite corregir datos antes de firmar.
  const facturaEnColombiaRaw =
    personaBase?.factura_en_colombia ??
    personaBase?.usuario_factura_en_colombia ??
    preregistro?.factura_en_colombia ??
    solicitud?.factura_en_colombia ??
    null;
  const facturaEnColombiaDirecta = normalizeNullableBooleanInput(facturaEnColombiaRaw);
  const facturaEnColombia = facturaEnColombiaDirecta !== null
    ? facturaEnColombiaDirecta
    : await resolveFacturaEnColombiaFallback({
      personaUsuarioId: solicitud?.persona_usuario_id || preregistro?.id_usuario_creado || null,
      numeroDocumento,
      correoPersonal
    });

  const tipoPersona =
    toNullableTrimmedString(personaBase?.tipo_persona) ||
    toNullableTrimmedString(personaBase?.usuario_tipo_persona) ||
    toNullableTrimmedString(preregistro?.tipo_persona) ||
    toNullableTrimmedString(solicitud?.tipo_persona) ||
    null;

  const razonSocial =
    toNullableTrimmedString(preregistro?.razon_social) ||
    null;
  const nitEmpresa =
    toNullableTrimmedString(preregistro?.nit_empresa) ||
    null;
  const representanteLegalContratista =
    toNullableTrimmedString(preregistro?.representante_legal) ||
    null;
  const tipoDocumentoRepresentante =
    toNullableTrimmedString(preregistro?.tipo_documento_representante) ||
    null;
  const numeroDocumentoRepresentante =
    toNullableTrimmedString(preregistro?.numero_documento_representante) ||
    null;

  return {
    solicitud,
    preregistro,
    fuente_principal: solicitud ? "solicitud" : (preregistro ? "preregistro" : "token"),
    usuario_id: usuarioContextId || personaBase?.usuario_id || null,
    persona_id: personaBase?.persona_id || null,
    persona_public_id: personaBase?.persona_public_id || null,
    solicitud_id: solicitud?.id || null,
    preregistro_id: preregistroContextId || null,
    nombre,
    apellidos,
    nombreCompleto,
    tipoDocumentoId,
    tipoDocumentoPublicId,
    tipoDocumento,
    numeroDocumento,
    correoPersonal,
    telefono,
    direccion,
    ciudad,
    paisUbicacion:
      toNullableTrimmedString(personaBase?.pais_residencia) ||
      toNullableTrimmedString(preregistro?.pais_ubicacion) ||
      null,
    facturaEnColombia,
    tipoPersona,
    razonSocial,
    nitEmpresa,
    representanteLegalContratista,
    tipoDocumentoRepresentante,
    numeroDocumentoRepresentante,
    clienteId: solicitud?.cliente_id || preregistro?.cliente_id || null,
    clienteNombre: solicitud?.cliente_nombre || preregistro?.cliente_nombre || "",
    moneda: normalizeMonedaContrato(solicitud?.moneda || preregistro?.moneda || "COP") || "COP",
    datos_extra: parseJsonObject(solicitud?.datos_extra || {}),
    modulo_id:
      toNullableInteger(personaBase?.modulo_id) ||
      toNullableInteger(parseJsonObject(solicitud?.datos_extra || {})?.modulo_id) ||
      preregistro?.modulo_id ||
      null,
    modulo_nombre:
      toNullableTrimmedString(personaBase?.modulo_titulo) ||
      toNullableTrimmedString(personaBase?.modulo_otro) ||
      toNullableTrimmedString(parseJsonObject(solicitud?.datos_extra || {})?.modulo_nombre) ||
      toNullableTrimmedString(parseJsonObject(solicitud?.datos_extra || {})?.modulo) ||
      preregistro?.modulo_titulo ||
      "",
    modalidad_contrato: solicitud?.modalidad_contrato || null,
    tipo_solicitud: solicitud?.tipo_solicitud || null,
    tarifa_hora: toNullableNumber(solicitud?.tarifa_hora ?? preregistro?.tarifa_hora),
    tarifa_mes: toNullableNumber(solicitud?.tarifa_mes ?? preregistro?.tarifa_mes),
    tarifa_medio_tiempo: toNullableNumber(solicitud?.tarifa_medio_tiempo ?? preregistro?.tarifa_medio_tiempo),
    tarifa_capacitacion: toNullableNumber(solicitud?.tarifa_capacitacion ?? preregistro?.tarifa_capacitacion),
    fecha_inicio: solicitud?.fecha_inicio || null,
    fecha_fin: solicitud?.fecha_fin || preregistro?.fecha_fin || null,
    fecha_extension_desde: solicitud?.fecha_extension_desde || null,
    fecha_extension_hasta: solicitud?.fecha_extension_hasta || null,
    fecha_retiro: solicitud?.fecha_retiro || null,
    created_at: solicitud?.created_at || preregistro?.created_at || null
  };
}

function addDaysToDateYmd(value, deltaDays) {
  const ymd = normalizeDateOnlyInput(value);
  if (!ymd || !Number.isFinite(Number(deltaDays))) return null;
  const date = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + Number(deltaDays));
  return date.toISOString().slice(0, 10);
}

async function listActiveAnexoItemsForPersonaContext(personaContext, { lockRows = false } = {}) {
  const userId = toNullableInteger(personaContext?.usuario_id);
  const numeroDocumento = toNullableTrimmedString(personaContext?.numeroDocumento);
  const correoPersonal = toNullableTrimmedString(personaContext?.correoPersonal);

  if (!userId && !numeroDocumento && !correoPersonal) return [];

  const client = lockRows ? await pool.connect() : pool;
  try {
    const result = await client.query(
      `
      SELECT
        ati.id,
        ati.public_id,
        ati.solicitud_contratacion_id,
        ati.preregistro_id,
        ati.usuario_id,
        ati.nombre_persona,
        ati.numero_documento,
        ati.correo_personal,
        ati.tipo_asignacion,
        ati.cliente_id,
        COALESCE(c.titulo, ati.cliente_nombre) AS cliente_nombre,
        ati.modulo_id,
        m.titulo AS modulo_titulo,
        ati.moneda,
        ati.valor_tarifa,
        ati.fecha_inicio,
        ati.fecha_fin,
        ati.fecha_fin_calculada,
        ati.origen,
        ati.estado,
        ati.estado_firma,
        ati.created_at,
        ati.updated_at
      FROM anexo_tecnico_items ati
      LEFT JOIN clientes c ON c.id = ati.cliente_id
      LEFT JOIN modulo m ON m.id = ati.modulo_id
      WHERE ati.estado = 'activo'
        AND (
          ($1::int IS NOT NULL AND ati.usuario_id = $1)
          OR ($2::text IS NOT NULL AND ati.numero_documento = $2)
          OR (
            $3::text IS NOT NULL
            AND COALESCE(BTRIM(ati.numero_documento), '') = ''
            AND LOWER(COALESCE(ati.correo_personal, '')) = LOWER($3)
          )
        )
      ORDER BY
        CASE WHEN ati.usuario_id = $1 THEN 0 ELSE 1 END,
        ati.fecha_inicio DESC NULLS LAST,
        ati.updated_at DESC NULLS LAST,
        ati.created_at DESC
      ${lockRows ? "FOR UPDATE OF ati" : ""}
      `,
      [userId, numeroDocumento, correoPersonal]
    );
    return result.rows || [];
  } finally {
    if (lockRows) client.release();
  }
}

function anexoAssignmentMatchesPayload(item, payload) {
  if (!item || !payload) return false;
  return (
    normalizeAnexoTipoInput(item.tipo_asignacion) === normalizeAnexoTipoInput(payload.tipo_asignacion) &&
    (toNullableInteger(item.cliente_id) || null) === (toNullableInteger(payload.cliente_id) || null) &&
    (toNullableInteger(item.modulo_id) || null) === (toNullableInteger(payload.modulo_id) || null)
  );
}

function selectActiveAnexoForPayload(existingItems, payload) {
  const items = Array.isArray(existingItems) ? existingItems : [];
  return items.find((item) => anexoAssignmentMatchesPayload(item, payload)) || null;
}

async function syncExtensionAnexoFromContext({ proceso, personaContext, createdBy = null, strict = false }) {
  if (!proceso || !personaContext) return null;

  const existingItems = await listActiveAnexoItemsForPersonaContext(personaContext);
  const baseItem = existingItems[0] || null;
  const tipoBase =
    normalizeAnexoTipoInput(personaContext?.datos_extra?.tipo_asignacion) ||
    normalizeAnexoTipoInput(baseItem?.tipo_asignacion) ||
    inferAnexoTipoFromContext(personaContext);
  const valorTarifa = inferAnexoTarifaFromContext(personaContext, tipoBase);
  const fechaInicioTarget =
    normalizeDateOnlyInput(personaContext?.fecha_extension_desde) ||
    normalizeDateOnlyInput(personaContext?.fecha_inicio) ||
    normalizeDateOnlyInput(baseItem?.fecha_inicio) ||
    normalizeDateOnlyInput(personaContext?.created_at) ||
    new Date().toISOString().slice(0, 10);

  let fechaFinTarget = null;
  let fechaFinCalculadaTarget = false;
  if (tipoBase === "horas" || tipoBase === "capacitacion") {
    fechaFinTarget = computeYearEndDate(fechaInicioTarget);
    fechaFinCalculadaTarget = true;
  } else {
    fechaFinTarget =
      normalizeDateOnlyInput(personaContext?.fecha_extension_hasta) ||
      normalizeDateOnlyInput(personaContext?.fecha_fin) ||
      normalizeDateOnlyInput(baseItem?.fecha_fin) ||
      computeYearEndDate(fechaInicioTarget) ||
      fechaInicioTarget;
    fechaFinCalculadaTarget = !normalizeDateOnlyInput(personaContext?.fecha_extension_hasta);
  }

  if (valorTarifa === null || !fechaInicioTarget || !fechaFinTarget) {
    if (strict) {
      throw buildAnexoPersistenciaError(
        personaContext,
        "La extension no tiene suficientes datos para sincronizar el anexo tecnico."
      );
    }
    return baseItem;
  }

  // Resolver solicitante desde la solicitud de contratación origen
  const solicitanteIdExt = personaContext.solicitud?.coordinador_solicitante_id || null;
  let rolSolicitanteExt = null;
  if (solicitanteIdExt) {
    try {
      const rolRes = await pool.query(
        `SELECT r.titulo FROM usuarios u JOIN roles r ON r.id = u.rol_usuario_id WHERE u.id = $1 LIMIT 1`,
        [solicitanteIdExt]
      );
      rolSolicitanteExt = rolRes.rows[0]?.titulo || null;
    } catch (_) { }
  }

  const payload = buildAnexoInsertPayload({
    input: {
      tipo_asignacion: tipoBase,
      valor_tarifa: valorTarifa,
      fecha_inicio: fechaInicioTarget,
      fecha_fin: fechaFinTarget,
      fecha_fin_calculada: fechaFinCalculadaTarget,
      moneda: personaContext?.moneda,
      modulo_id: personaContext?.modulo_id || baseItem?.modulo_id || null,
      nombre_persona: personaContext?.nombreCompleto,
      numero_documento: personaContext?.numeroDocumento,
      correo_personal: personaContext?.correoPersonal
    },
    personaContext,
    solicitudId: proceso.solicitud_id || null,
    preregistroId: proceso.preregistro_id || null,
    clienteId: personaContext?.clienteId || baseItem?.cliente_id || null,
    clienteNombre: personaContext?.clienteNombre || baseItem?.cliente_nombre || "",
    creadoPor: createdBy || null,
    origen: "automatico",
    solicitanteId: solicitanteIdExt,
    rolSolicitante: rolSolicitanteExt
  });

  // Si el usuario seleccionó un item específico, usarlo como target directo
  const directAnexoPublicId = toNullableTrimmedString(personaContext?.datos_extra?.anexo_item_id);
  let currentItem = null;
  if (directAnexoPublicId) {
    currentItem = existingItems.find(item => String(item.public_id) === directAnexoPublicId) || null;
  }
  if (!currentItem) {
    currentItem = selectActiveAnexoForPayload(existingItems, payload);
  }

  if (!currentItem) {
    const created = await insertAnexoTecnicoItem(payload);
    return created.row;
  }

  const sameSource =
    (proceso?.solicitud_id && Number(currentItem.solicitud_contratacion_id) === Number(proceso.solicitud_id)) ||
    (proceso?.preregistro_id && Number(currentItem.preregistro_id) === Number(proceso.preregistro_id));
  const currentFechaInicio = normalizeDateOnlyInput(currentItem.fecha_inicio);
  const shouldSplitHistory =
    !sameSource &&
    payload.fecha_inicio &&
    currentFechaInicio &&
    payload.fecha_inicio > currentFechaInicio;

  if (shouldSplitHistory) {
    const cierreAnterior = addDaysToDateYmd(payload.fecha_inicio, -1);
    const fechaFinAnterior =
      cierreAnterior && currentFechaInicio && cierreAnterior >= currentFechaInicio
        ? cierreAnterior
        : currentItem.fecha_fin;

    // horas/capacitacion: constraint check2 exige fecha_fin = 31-dic; no cambiar
    const isCurrentCorteAnual =
      currentItem.tipo_asignacion === "horas" || currentItem.tipo_asignacion === "capacitacion";
    const fechaFinParaSplit = isCurrentCorteAnual ? null : fechaFinAnterior;

    await pool.query(
      `
      UPDATE anexo_tecnico_items
      SET
        estado = 'finalizado',
        fecha_fin = COALESCE($2, fecha_fin),
        fecha_fin_calculada = false,
        updated_by = $3,
        updated_at = NOW()
      WHERE id = $1
      `,
      [currentItem.id, fechaFinParaSplit, createdBy || null]
    );

    const inserted = await insertAnexoTecnicoItem({
      ...payload,
      estado_firma: currentItem.estado_firma === "firmado" ? "pendiente" : (currentItem.estado_firma || "pendiente"),
      updated_by: createdBy || null
    });
    return inserted.row;
  }

  const updated = await pool.query(
    `
    UPDATE anexo_tecnico_items
    SET
      solicitud_contratacion_id = COALESCE($1, solicitud_contratacion_id),
      preregistro_id = COALESCE($2, preregistro_id),
      usuario_id = COALESCE($3, usuario_id),
      nombre_persona = $4,
      numero_documento = $5,
      correo_personal = $6,
      tipo_asignacion = $7,
      cliente_id = $8,
      cliente_nombre = $9,
      modulo_id = $10,
      moneda = $11,
      valor_tarifa = $12,
      fecha_inicio = $13,
      fecha_fin = $14,
      fecha_fin_calculada = $15,
      origen = $16,
      estado = 'activo',
      estado_firma = $17,
      updated_by = $18,
      solicitante_id = COALESCE($19, solicitante_id),
      rol_solicitante = COALESCE($20, rol_solicitante),
      updated_at = NOW()
    WHERE id = $21
    RETURNING *
    `,
    [
      payload.solicitud_contratacion_id,
      payload.preregistro_id,
      payload.usuario_id,
      payload.nombre_persona,
      payload.numero_documento,
      payload.correo_personal,
      payload.tipo_asignacion,
      payload.cliente_id,
      payload.cliente_nombre,
      payload.modulo_id,
      payload.moneda,
      payload.valor_tarifa,
      payload.fecha_inicio,
      payload.fecha_fin,
      payload.fecha_fin_calculada,
      payload.origen,
      currentItem.estado_firma === "firmado" ? "pendiente" : (currentItem.estado_firma || "pendiente"),
      createdBy || null,
      payload.solicitante_id || null,
      payload.rol_solicitante || null,
      currentItem.id
    ]
  );
  return updated.rows[0] || currentItem;
}

function buildAnexoItemForTemplateRow(item) {
  const tipo = normalizeAnexoTipoInput(item?.tipo_asignacion) || "full_time";
  const moneda = normalizeMonedaContrato(item?.moneda) || "COP";
  let valorTarifa = formatCurrencyForTemplate(item?.valor_tarifa, moneda);
  if (tipo === "horas") valorTarifa = valorTarifa ? `${valorTarifa} / hora` : "";
  if (tipo === "full_time" || tipo === "medio_tiempo") valorTarifa = valorTarifa ? `${valorTarifa} / mes` : "";
  if (tipo === "proyecto") valorTarifa = valorTarifa ? `${valorTarifa} (proyecto)` : "";
  return {
    tipo: ANEXO_TIPO_LABELS[tipo] || ANEXO_TIPO_LABELS.full_time,
    cliente: toNullableTrimmedString(item?.cliente_nombre) || "",
    modulo:
      toNullableTrimmedString(item?.modulo_titulo) ||
      toNullableTrimmedString(item?.modulo_nombre) ||
      "",
    valorTarifa,
    fechaInicio: formatDateForTemplate(item?.fecha_inicio),
    fechaFin: formatDateForTemplate(item?.fecha_fin)
  };
}

async function listAnexoTecnicoItems({ solicitudId = null, preregistroId = null, numeroDocumento = null, correoPersonal = null } = {}) {
  const clauses = [];
  const values = [];
  let idx = 1;

  // Identificadores estructurados (IDs de proceso) tienen prioridad absoluta.
  // Si alguno esta presente NO se agrega numero_documento ni correo_personal al
  // WHERE para evitar devolver filas de otros contratos del mismo colaborador
  // (recontrataciones) que comparten cedula o correo pero son procesos distintos.
  if (solicitudId) {
    clauses.push(`ati.solicitud_contratacion_id = $${idx++}`);
    values.push(solicitudId);
  }
  if (preregistroId) {
    clauses.push(`ati.preregistro_id = $${idx++}`);
    values.push(preregistroId);
  }

  // Solo usar identificadores personales cuando NO hay IDs de proceso:
  // evita el OR contaminado que cruza recontrataciones.
  if (!solicitudId && !preregistroId) {
    if (numeroDocumento) {
      clauses.push(`ati.numero_documento = $${idx++}`);
      values.push(numeroDocumento);
    } else if (correoPersonal) {
      // correoPersonal es el ultimo recurso: no es identificador unico por contrato.
      clauses.push(`LOWER(ati.correo_personal) = LOWER($${idx++})`);
      values.push(correoPersonal);
    }
  }

  if (!clauses.length) return [];

  const r = await pool.query(
    `
    SELECT
      ati.id,
      ati.public_id,
      ati.solicitud_contratacion_id,
      sc.public_id AS solicitud_public_id,
      ati.preregistro_id,
      pp.public_id AS preregistro_public_id,
      ati.usuario_id,
      u.public_id AS usuario_public_id,
      ati.nombre_persona,
      ati.numero_documento,
      ati.correo_personal,
      ati.tipo_asignacion,
      ati.cliente_id,
      c.public_id AS cliente_public_id,
      COALESCE(c.titulo, ati.cliente_nombre) AS cliente_nombre,
      ati.modulo_id,
      m.public_id AS modulo_public_id,
      m.titulo AS modulo_titulo,
      ati.moneda,
      ati.valor_tarifa,
      ati.fecha_inicio,
      ati.fecha_fin,
      ati.fecha_fin_calculada,
      ati.origen,
      ati.estado,
      ati.estado_firma,
      ati.updated_by,
      uu.nombre_usuario AS updated_by_nombre,
      ati.created_at,
      ati.updated_at
    FROM anexo_tecnico_items ati
    LEFT JOIN solicitudes_contratacion sc ON sc.id = ati.solicitud_contratacion_id
    LEFT JOIN preregistro_personas pp ON pp.id = ati.preregistro_id
    LEFT JOIN usuarios u ON u.id = ati.usuario_id
    LEFT JOIN usuarios uu ON uu.id = ati.updated_by
    LEFT JOIN clientes c ON c.id = ati.cliente_id
    LEFT JOIN modulo m ON m.id = ati.modulo_id
    WHERE ati.estado <> 'cancelado'
      AND (${clauses.join(" OR ")})
    ORDER BY ati.fecha_inicio ASC, ati.created_at ASC
    `,
    values
  );
  return r.rows || [];
}

async function getAnexoTecnicoItemByInternalId(internalId) {
  if (!internalId) return null;
  const r = await pool.query(
    `
    SELECT
      ati.id,
      ati.public_id,
      ati.solicitud_contratacion_id,
      sc.public_id AS solicitud_public_id,
      ati.preregistro_id,
      pp.public_id AS preregistro_public_id,
      ati.usuario_id,
      u.public_id AS usuario_public_id,
      ati.nombre_persona,
      ati.numero_documento,
      ati.correo_personal,
      ati.tipo_asignacion,
      ati.cliente_id,
      c.public_id AS cliente_public_id,
      COALESCE(c.titulo, ati.cliente_nombre) AS cliente_nombre,
      ati.modulo_id,
      m.public_id AS modulo_public_id,
      m.titulo AS modulo_titulo,
      ati.moneda,
      ati.valor_tarifa,
      ati.fecha_inicio,
      ati.fecha_fin,
      ati.fecha_fin_calculada,
      ati.origen,
      ati.estado,
      ati.estado_firma,
      ati.updated_by,
      uu.nombre_usuario AS updated_by_nombre,
      ati.created_at,
      ati.updated_at
    FROM anexo_tecnico_items ati
    LEFT JOIN solicitudes_contratacion sc ON sc.id = ati.solicitud_contratacion_id
    LEFT JOIN preregistro_personas pp ON pp.id = ati.preregistro_id
    LEFT JOIN usuarios u ON u.id = ati.usuario_id
    LEFT JOIN usuarios uu ON uu.id = ati.updated_by
    LEFT JOIN clientes c ON c.id = ati.cliente_id
    LEFT JOIN modulo m ON m.id = ati.modulo_id
    WHERE ati.id = $1
    LIMIT 1
    `,
    [internalId]
  );
  return r.rows[0] || null;
}

function buildAnexoInsertPayload({
  input,
  personaContext,
  solicitudId = null,
  preregistroId = null,
  clienteId = null,
  clienteNombre = null,
  creadoPor = null,
  origen = "manual",
  solicitanteId = null,
  rolSolicitante = null
}) {
  const tipoAsignacion = normalizeAnexoTipoInput(input?.tipo_asignacion || input?.tipo);
  if (!tipoAsignacion) {
    const err = new Error("tipo_asignacion invalido");
    err.status = 400;
    throw err;
  }

  const fechaInicio = normalizeDateOnlyInput(input?.fecha_inicio);
  if (!fechaInicio) {
    const err = new Error("fecha_inicio invalida");
    err.status = 400;
    throw err;
  }

  const valorTarifa = toNullableNumber(input?.valor_tarifa ?? input?.tarifa ?? input?.valor);
  if (valorTarifa === null || valorTarifa < 0) {
    const err = new Error("valor_tarifa es obligatorio y debe ser >= 0");
    err.status = 400;
    throw err;
  }

  const isCorteAnual = tipoAsignacion === "horas" || tipoAsignacion === "capacitacion";
  let fechaFin = null;
  let fechaFinCalculada = false;
  if (isCorteAnual) {
    fechaFin = computeYearEndDate(fechaInicio);
    fechaFinCalculada = true;
  } else {
    fechaFin = normalizeDateOnlyInput(input?.fecha_fin);
    if (!fechaFin) {
      const err = new Error("fecha_fin es obligatoria para el tipo seleccionado");
      err.status = 400;
      throw err;
    }
    fechaFinCalculada = toBooleanInput(input?.fecha_fin_calculada, false);
    if (fechaFin < fechaInicio) {
      const err = new Error("fecha_fin no puede ser menor que fecha_inicio");
      err.status = 400;
      throw err;
    }
  }

  let resolvedClienteId = clienteId;
  let resolvedClienteNombre = toNullableTrimmedString(clienteNombre);
  if (tipoAsignacion === "full_time" || tipoAsignacion === "medio_tiempo" || tipoAsignacion === "proyecto") {
    if (!resolvedClienteId) {
      const err = new Error("cliente_id es obligatorio para full_time, medio_tiempo y proyecto");
      err.status = 400;
      throw err;
    }
  }

  const nombrePersona =
    toNullableTrimmedString(input?.nombre_persona) ||
    toNullableTrimmedString(personaContext?.nombreCompleto) ||
    "";
  if (!nombrePersona) {
    const err = new Error("No se pudo resolver nombre_persona para el anexo");
    err.status = 400;
    throw err;
  }

  return {
    solicitud_contratacion_id: solicitudId || null,
    preregistro_id: preregistroId || null,
    usuario_id: personaContext?.usuario_id || null,
    nombre_persona: nombrePersona,
    numero_documento: toNullableTrimmedString(input?.numero_documento) || toNullableTrimmedString(personaContext?.numeroDocumento),
    correo_personal: toNullableTrimmedString(input?.correo_personal) || toNullableTrimmedString(personaContext?.correoPersonal),
    tipo_asignacion: tipoAsignacion,
    cliente_id: resolvedClienteId || null,
    cliente_nombre: resolvedClienteNombre || "",
    modulo_id: toNullableInteger(input?.modulo_id) || personaContext?.modulo_id || null,
    moneda: normalizeMonedaContrato(input?.moneda || personaContext?.moneda || "COP") || "COP",
    valor_tarifa: valorTarifa,
    fecha_inicio: fechaInicio,
    fecha_fin: fechaFin,
    fecha_fin_calculada: fechaFinCalculada,
    origen: origen === "automatico" ? "automatico" : "manual",
    estado: "activo",
    estado_firma: "pendiente",
    creado_por: creadoPor || null,
    updated_by: null,
    solicitante_id: solicitanteId || null,
    rol_solicitante: rolSolicitante || null
  };
}

async function findActiveAnexoBySource(payload) {
  if (!payload?.solicitud_contratacion_id && !payload?.preregistro_id) return null;
  const r = await pool.query(
    `
    SELECT *
    FROM anexo_tecnico_items
    WHERE estado <> 'cancelado'
      AND (
        ($1::int IS NOT NULL AND solicitud_contratacion_id = $1)
        OR ($2::int IS NOT NULL AND preregistro_id = $2)
      )
    ORDER BY updated_at DESC NULLS LAST, id DESC
    LIMIT 1
    `,
    [
      payload.solicitud_contratacion_id || null,
      payload.preregistro_id || null
    ]
  );
  return r.rows[0] || null;
}

async function findAnexoDuplicate(payload) {
  const r = await pool.query(
    `
    SELECT id
    FROM anexo_tecnico_items
    WHERE estado <> 'cancelado'
      AND COALESCE(solicitud_contratacion_id, 0) = COALESCE($1, 0)
      AND COALESCE(preregistro_id, 0) = COALESCE($2, 0)
      AND COALESCE(numero_documento, '') = COALESCE($3, '')
      AND COALESCE(LOWER(correo_personal), '') = COALESCE(LOWER($4), '')
      AND tipo_asignacion = $5
      AND COALESCE(cliente_id, 0) = COALESCE($6, 0)
      AND COALESCE(modulo_id, 0) = COALESCE($7, 0)
      AND COALESCE(moneda, 'COP') = COALESCE($8, 'COP')
      AND valor_tarifa = $9
      AND fecha_inicio = $10
      AND fecha_fin = $11
    LIMIT 1
    `,
    [
      payload.solicitud_contratacion_id || null,
      payload.preregistro_id || null,
      payload.numero_documento || null,
      payload.correo_personal || null,
      payload.tipo_asignacion,
      payload.cliente_id || null,
      payload.modulo_id || null,
      payload.moneda || null,
      payload.valor_tarifa,
      payload.fecha_inicio,
      payload.fecha_fin
    ]
  );
  return r.rows[0]?.id || null;
}

async function insertAnexoTecnicoItem(payload) {
  const existingBySource = await findActiveAnexoBySource(payload);
  if (existingBySource?.id) {
    const update = await pool.query(
      `
      UPDATE anexo_tecnico_items
      SET
        solicitud_contratacion_id = $1,
        preregistro_id = $2,
        usuario_id = $3,
        nombre_persona = $4,
        numero_documento = $5,
        correo_personal = $6,
        tipo_asignacion = $7,
        cliente_id = $8,
        cliente_nombre = $9,
        modulo_id = $10,
        moneda = $11,
        valor_tarifa = $12,
        fecha_inicio = $13,
        fecha_fin = $14,
        fecha_fin_calculada = $15,
        origen = $16,
        estado = $17,
        estado_firma = COALESCE($18, estado_firma, 'pendiente'),
        creado_por = COALESCE($19, creado_por),
        updated_by = COALESCE($20, updated_by),
        solicitante_id = COALESCE($22, solicitante_id),
        rol_solicitante = COALESCE($23, rol_solicitante),
        updated_at = NOW()
      WHERE id = $21
      RETURNING *
      `,
      [
        payload.solicitud_contratacion_id,
        payload.preregistro_id,
        payload.usuario_id,
        payload.nombre_persona,
        payload.numero_documento,
        payload.correo_personal,
        payload.tipo_asignacion,
        payload.cliente_id,
        payload.cliente_nombre,
        payload.modulo_id,
        payload.moneda,
        payload.valor_tarifa,
        payload.fecha_inicio,
        payload.fecha_fin,
        payload.fecha_fin_calculada,
        payload.origen,
        payload.estado,
        payload.estado_firma || "pendiente",
        payload.creado_por,
        payload.updated_by,
        existingBySource.id,
        payload.solicitante_id || null,
        payload.rol_solicitante || null
      ]
    );
    return { row: update.rows[0] || null, duplicated: false, updated: true };
  }

  const duplicateId = await findAnexoDuplicate(payload);
  if (duplicateId) {
    const existing = await pool.query(`SELECT * FROM anexo_tecnico_items WHERE id = $1 LIMIT 1`, [duplicateId]);
    return { row: existing.rows[0] || null, duplicated: true };
  }

  const insert = await pool.query(
    `
    INSERT INTO anexo_tecnico_items (
      solicitud_contratacion_id,
      preregistro_id,
      usuario_id,
      nombre_persona,
      numero_documento,
      correo_personal,
      tipo_asignacion,
      cliente_id,
      cliente_nombre,
      modulo_id,
      moneda,
      valor_tarifa,
      fecha_inicio,
      fecha_fin,
      fecha_fin_calculada,
      origen,
      estado,
      estado_firma,
      creado_por,
      updated_by,
      solicitante_id,
      rol_solicitante
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21, $22
    )
    RETURNING *
    `,
    [
      payload.solicitud_contratacion_id,
      payload.preregistro_id,
      payload.usuario_id,
      payload.nombre_persona,
      payload.numero_documento,
      payload.correo_personal,
      payload.tipo_asignacion,
      payload.cliente_id,
      payload.cliente_nombre,
      payload.modulo_id,
      payload.moneda,
      payload.valor_tarifa,
      payload.fecha_inicio,
      payload.fecha_fin,
      payload.fecha_fin_calculada,
      payload.origen,
      payload.estado,
      payload.estado_firma || "pendiente",
      payload.creado_por,
      payload.updated_by,
      payload.solicitante_id || null,
      payload.rol_solicitante || null
    ]
  );

  return { row: insert.rows[0] || null, duplicated: false };
}

function buildAnexoPersistenciaError(personaContext, detalle = "") {
  const nombre = toNullableTrimmedString(personaContext?.nombreCompleto) || "la persona";
  const suffix = detalle ? ` Detalle: ${detalle}` : "";
  const err = new Error(
    `No existe un anexo técnico persistido para ${nombre}. Completa y sincroniza la solicitud antes de enviar a firma.${suffix}`
  );
  err.status = 422;
  return err;
}

async function ensureAutomaticAnexoFromContext({ proceso, personaContext, createdBy = null, strict = false }) {
  if (!proceso || !personaContext) return null;
  if (String(personaContext?.tipo_solicitud || "").trim() === "Extension") {
    return syncExtensionAnexoFromContext({ proceso, personaContext, createdBy, strict });
  }
  const tipo = inferAnexoTipoFromContext(personaContext);
  const valorTarifa = inferAnexoTarifaFromContext(personaContext, tipo);
  const fechas = inferAnexoDatesFromContext(personaContext, tipo);
  if (valorTarifa === null || !fechas.fecha_inicio || !fechas.fecha_fin) {
    if (strict) {
      throw buildAnexoPersistenciaError(
        personaContext,
        "Faltan tipo de asignación, tarifa o fechas requeridas para persistir el anexo."
      );
    }
    return null;
  }

  // Resolver solicitante (coordinador o comercial que originó la solicitud)
  const solicitanteInternalId = personaContext.solicitud?.coordinador_solicitante_id || null;
  let rolSolicitante = null;
  if (solicitanteInternalId) {
    try {
      const rolRes = await pool.query(
        `SELECT r.titulo FROM usuarios u JOIN roles r ON r.id = u.rol_usuario_id WHERE u.id = $1 LIMIT 1`,
        [solicitanteInternalId]
      );
      rolSolicitante = rolRes.rows[0]?.titulo || null;
    } catch (_) { }
  }

  const input = {
    tipo_asignacion: tipo,
    valor_tarifa: valorTarifa,
    fecha_inicio: fechas.fecha_inicio,
    fecha_fin: fechas.fecha_fin,
    moneda: personaContext.moneda,
    nombre_persona: personaContext.nombreCompleto,
    numero_documento: personaContext.numeroDocumento,
    correo_personal: personaContext.correoPersonal
  };

  let payload;
  try {
    payload = buildAnexoInsertPayload({
      input,
      personaContext,
      solicitudId: proceso.solicitud_id || null,
      preregistroId: proceso.preregistro_id || null,
      clienteId: personaContext.clienteId || null,
      clienteNombre: personaContext.clienteNombre || "",
      creadoPor: createdBy || null,
      origen: "automatico",
      solicitanteId: solicitanteInternalId,
      rolSolicitante
    });
  } catch (err) {
    if (strict) {
      throw buildAnexoPersistenciaError(personaContext, err?.message || "No fue posible construir el payload del anexo.");
    }
    return null;
  }

  const result = await insertAnexoTecnicoItem(payload);
  return result.row;
}

async function ensurePersistedAnexoFromProceso({ solicitudId = null, preregistroId = null, createdBy = null, strict = false } = {}) {
  const proceso = {
    solicitud_id: solicitudId || null,
    preregistro_id: preregistroId || null
  };
  const personaContext = await resolveContratoPersonaContext(proceso);
  if (!personaContext) {
    if (strict) {
      throw buildAnexoPersistenciaError(null, "No fue posible resolver la persona del proceso.");
    }
    return null;
  }
  return ensureAutomaticAnexoFromContext({ proceso, personaContext, createdBy, strict });
}

async function requirePersistedAnexoFromProceso(proceso, personaContext = null) {
  const resolvedContext = personaContext || await resolveContratoPersonaContext(proceso);
  const items = await listAnexoTecnicoItems({
    solicitudId: proceso?.solicitud_id || null,
    preregistroId: proceso?.preregistro_id || null,
    numeroDocumento: resolvedContext?.numeroDocumento || null,
    correoPersonal: resolvedContext?.correoPersonal || null
  });
  if (!items.length) {
    throw buildAnexoPersistenciaError(
      resolvedContext,
      "El PDF del anexo solo se genera con filas persistidas en base de datos."
    );
  }
  return items;
}

function toAnexoApiRow(row) {
  if (!row) return null;
  return {
    id: row.public_id || row.id,
    solicitud_id: row.solicitud_public_id || null,
    preregistro_id: row.preregistro_public_id || null,
    usuario_id: row.usuario_public_id || null,
    nombre_persona: row.nombre_persona || "",
    numero_documento: row.numero_documento || null,
    correo_personal: row.correo_personal || null,
    tipo_asignacion: row.tipo_asignacion,
    tipo_asignacion_label: ANEXO_TIPO_LABELS[normalizeAnexoTipoInput(row.tipo_asignacion)] || row.tipo_asignacion,
    cliente_id: row.cliente_public_id || null,
    cliente_nombre: row.cliente_nombre || "",
    modulo_id: row.modulo_public_id || null,
    modulo_nombre: row.modulo_titulo || "",
    moneda: row.moneda || "COP",
    valor_tarifa: row.valor_tarifa === null ? null : Number(row.valor_tarifa),
    fecha_inicio: row.fecha_inicio || null,
    fecha_fin: row.fecha_fin || null,
    fecha_fin_calculada: Boolean(row.fecha_fin_calculada),
    origen: row.origen || "manual",
    estado: row.estado || "activo",
    estado_firma: row.estado_firma || "pendiente",
    updated_by_nombre: row.updated_by_nombre || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function anexoTipoRequiereCliente(tipoAsignacion) {
  const tipo = normalizeAnexoTipoInput(tipoAsignacion);
  return tipo === "full_time" || tipo === "medio_tiempo" || tipo === "proyecto";
}

function mapAnexoIndividualTokenRow(row) {
  if (!row) return null;
  return {
    id: row.public_id || row.id,
    usuario_id: row.usuario_public_id || null,
    estado: row.estado || "enviado",
    correo_firmante: row.correo_firmante || null,
    nombre_persona: row.nombre_persona || "",
    request_id: row.request_id || null,
    contract_id: row.contract_id || null,
    signature_id: row.signature_id || null,
    url_firma: row.url_firma || null,
    onedrive_url: row.onedrive_url || null,
    onedrive_carpeta: row.onedrive_carpeta || null,
    onedrive_carpeta_url: row.onedrive_carpeta_url || null,
    firmado_at: row.firmado_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

async function getUsuarioAnexoIndividualById(userInput) {
  const internalId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.usuarios, userInput);
  if (!internalId) return null;
  const r = await pool.query(
    `
    SELECT
      u.id,
      u.public_id,
      u.nombre_usuario,
      u.email,
      COALESCE(p.numero_documento, u.cedula)       AS cedula,
      COALESCE(p.numero_contacto, u.telefono)      AS telefono,
      COALESCE(p.direccion_residencia, u.direccion) AS direccion,
      COALESCE(p.ciudad_residencia, u.ciudad)       AS ciudad,
      u.moneda_cobro,
      u.tipo_consultor,
      COALESCE(di_p.titulo, di_u.titulo) AS tipo_documento_titulo,
      COALESCE(di_p.codigo, di_u.codigo) AS tipo_documento_codigo
    FROM usuarios u
    LEFT JOIN personas p               ON u.persona_id        = p.id
    LEFT JOIN documento_identidad di_p ON di_p.id = p.tipo_documento_id
    LEFT JOIN documento_identidad di_u ON di_u.id = u.tipo_documento_id
    WHERE u.id = $1
      AND u.activo = true
    LIMIT 1
    `,
    [internalId]
  );
  return r.rows[0] || null;
}

async function resolveSuggestedAnexoFirmanteEmailForUser(userRow) {
  if (!userRow?.id) return null;

  const fromToken = await pool.query(
    `
    SELECT correo_firmante AS email
    FROM tokens_firma_anexo_individual
    WHERE usuario_id = $1
      AND correo_firmante IS NOT NULL
      AND TRIM(correo_firmante) <> ''
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [userRow.id]
  );
  if (fromToken.rowCount > 0) return toNullableTrimmedString(fromToken.rows[0]?.email);

  const fromItems = await pool.query(
    `
    SELECT correo_personal AS email
    FROM anexo_tecnico_items
    WHERE (
        usuario_id = $1
        OR ($2::text IS NOT NULL AND numero_documento = $2)
      )
      AND correo_personal IS NOT NULL
      AND TRIM(correo_personal) <> ''
    ORDER BY updated_at DESC NULLS LAST, created_at DESC
    LIMIT 1
    `,
    [userRow.id, toNullableTrimmedString(userRow.cedula)]
  );
  if (fromItems.rowCount > 0) return toNullableTrimmedString(fromItems.rows[0]?.email);

  const fromSolicitudes = await pool.query(
    `
    SELECT correo_personal AS email
    FROM solicitudes_contratacion
    WHERE (
        persona_usuario_id = $1
        OR ($2::text IS NOT NULL AND numero_documento = $2)
      )
      AND correo_personal IS NOT NULL
      AND TRIM(correo_personal) <> ''
    ORDER BY updated_at DESC NULLS LAST, created_at DESC
    LIMIT 1
    `,
    [userRow.id, toNullableTrimmedString(userRow.cedula)]
  );
  if (fromSolicitudes.rowCount > 0) return toNullableTrimmedString(fromSolicitudes.rows[0]?.email);

  const fromPreregistros = await pool.query(
    `
    SELECT correo_personal AS email
    FROM preregistro_personas
    WHERE (
        id_usuario_creado = $1
        OR ($2::text IS NOT NULL AND numero_documento = $2)
      )
      AND correo_personal IS NOT NULL
      AND TRIM(correo_personal) <> ''
    ORDER BY updated_at DESC NULLS LAST, created_at DESC
    LIMIT 1
    `,
    [userRow.id, toNullableTrimmedString(userRow.cedula)]
  );
  if (fromPreregistros.rowCount > 0) return toNullableTrimmedString(fromPreregistros.rows[0]?.email);

  return toNullableTrimmedString(userRow.email);
}

async function listAnexoItemsForUsuario(userRow, { includeFinalizados = false, correoPersonalFallback = null } = {}) {
  if (!userRow?.id) return [];
  const numeroDocumento = toNullableTrimmedString(userRow.cedula);
  const correoFallback = toNullableTrimmedString(correoPersonalFallback);
  const r = await pool.query(
    `
    SELECT
      ati.id,
      ati.public_id,
      ati.solicitud_contratacion_id,
      sc.public_id AS solicitud_public_id,
      ati.preregistro_id,
      pp.public_id AS preregistro_public_id,
      ati.usuario_id,
      u.public_id AS usuario_public_id,
      ati.nombre_persona,
      ati.numero_documento,
      ati.correo_personal,
      ati.tipo_asignacion,
      ati.cliente_id,
      c.public_id AS cliente_public_id,
      COALESCE(c.titulo, ati.cliente_nombre) AS cliente_nombre,
      ati.modulo_id,
      m.public_id AS modulo_public_id,
      m.titulo AS modulo_titulo,
      ati.moneda,
      ati.valor_tarifa,
      ati.fecha_inicio,
      ati.fecha_fin,
      ati.fecha_fin_calculada,
      ati.origen,
      ati.estado,
      ati.estado_firma,
      ati.creado_por,
      ati.updated_by,
      uu.nombre_usuario AS updated_by_nombre,
      ati.created_at,
      ati.updated_at
    FROM anexo_tecnico_items ati
    LEFT JOIN solicitudes_contratacion sc ON sc.id = ati.solicitud_contratacion_id
    LEFT JOIN preregistro_personas pp ON pp.id = ati.preregistro_id
    LEFT JOIN usuarios u ON u.id = ati.usuario_id
    LEFT JOIN usuarios uu ON uu.id = ati.updated_by
    LEFT JOIN clientes c ON c.id = ati.cliente_id
    LEFT JOIN modulo m ON m.id = ati.modulo_id
    WHERE ati.estado <> 'cancelado'
      AND (
        ati.usuario_id = $1
        OR ($2::text IS NOT NULL AND ati.usuario_id IS NULL AND ati.numero_documento = $2)
        OR (
          $3::text IS NOT NULL
          AND ati.usuario_id IS NULL
          AND COALESCE(BTRIM(ati.numero_documento), '') = ''
          AND LOWER(COALESCE(ati.correo_personal, '')) = LOWER($3)
        )
      )
      AND ($4::boolean OR ati.estado = 'activo')
    ORDER BY
      CASE WHEN ati.estado = 'activo' THEN 0 ELSE 1 END,
      ati.fecha_inicio DESC NULLS LAST,
      ati.created_at DESC
    `,
    [userRow.id, numeroDocumento, correoFallback, Boolean(includeFinalizados)]
  );
  return r.rows || [];
}

async function getAnexoIndividualItemByInput(itemInput) {
  const raw = String(itemInput || "").trim();
  if (!raw) return null;
  let whereClause = "";
  let param = raw;
  if (isNumericId(raw)) {
    whereClause = "ati.id = $1";
    param = Number(raw);
  } else if (isGuid(raw)) {
    whereClause = "ati.public_id = $1";
  } else {
    return null;
  }

  const r = await pool.query(
    `
    SELECT
      ati.id,
      ati.public_id,
      ati.solicitud_contratacion_id,
      sc.public_id AS solicitud_public_id,
      ati.preregistro_id,
      pp.public_id AS preregistro_public_id,
      ati.usuario_id,
      u.public_id AS usuario_public_id,
      ati.nombre_persona,
      ati.numero_documento,
      ati.correo_personal,
      ati.tipo_asignacion,
      ati.cliente_id,
      c.public_id AS cliente_public_id,
      COALESCE(c.titulo, ati.cliente_nombre) AS cliente_nombre,
      ati.modulo_id,
      m.public_id AS modulo_public_id,
      m.titulo AS modulo_titulo,
      ati.moneda,
      ati.valor_tarifa,
      ati.fecha_inicio,
      ati.fecha_fin,
      ati.fecha_fin_calculada,
      ati.origen,
      ati.estado,
      ati.estado_firma,
      ati.creado_por,
      ati.updated_by,
      uu.nombre_usuario AS updated_by_nombre,
      ati.created_at,
      ati.updated_at
    FROM anexo_tecnico_items ati
    LEFT JOIN solicitudes_contratacion sc ON sc.id = ati.solicitud_contratacion_id
    LEFT JOIN preregistro_personas pp ON pp.id = ati.preregistro_id
    LEFT JOIN usuarios u ON u.id = ati.usuario_id
    LEFT JOIN usuarios uu ON uu.id = ati.updated_by
    LEFT JOIN clientes c ON c.id = ati.cliente_id
    LEFT JOIN modulo m ON m.id = ati.modulo_id
    WHERE ${whereClause}
    LIMIT 1
    `,
    [param]
  );
  return r.rows[0] || null;
}

async function buildAnexoIndividualItemPayload({ input, userRow, existingRow = null, actorUserId = null }) {
  if (!userRow?.id) {
    const err = new Error("Usuario no encontrado");
    err.status = 404;
    throw err;
  }

  const tipoAsignacion = normalizeAnexoTipoInput(input?.tipo_asignacion || existingRow?.tipo_asignacion);
  if (!tipoAsignacion) {
    const err = new Error("tipo_asignacion invalido");
    err.status = 400;
    throw err;
  }

  const moduloInput = input?.modulo_id || existingRow?.modulo_public_id || existingRow?.modulo_id || null;
  const moduloId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.modulo, moduloInput);
  if (!moduloId) {
    const err = new Error("modulo_id es obligatorio");
    err.status = 400;
    throw err;
  }
  const moduloRes = await pool.query(
    "SELECT id, public_id, titulo FROM modulo WHERE id = $1 AND activo = true LIMIT 1",
    [moduloId]
  );
  if (moduloRes.rowCount === 0) {
    const err = new Error("Modulo no encontrado");
    err.status = 404;
    throw err;
  }

  let clienteId = null;
  let clienteNombre = "";
  const clienteInput = input?.cliente_id || existingRow?.cliente_public_id || existingRow?.cliente_id || null;
  if (clienteInput || anexoTipoRequiereCliente(tipoAsignacion)) {
    clienteId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.clientes, clienteInput);
    if (!clienteId) {
      const err = new Error(
        anexoTipoRequiereCliente(tipoAsignacion)
          ? "cliente_id es obligatorio para el tipo seleccionado"
          : "cliente_id no encontrado"
      );
      err.status = 400;
      throw err;
    }
    const clienteRes = await pool.query(
      "SELECT id, public_id, titulo FROM clientes WHERE id = $1 AND activo = true LIMIT 1",
      [clienteId]
    );
    if (clienteRes.rowCount === 0) {
      const err = new Error("Cliente no encontrado");
      err.status = 404;
      throw err;
    }
    clienteNombre = clienteRes.rows[0]?.titulo || "";
  }

  const suggestedEmail =
    toNullableTrimmedString(input?.correo_personal) ||
    toNullableTrimmedString(existingRow?.correo_personal) ||
    await resolveSuggestedAnexoFirmanteEmailForUser(userRow) ||
    null;

  const personaContext = {
    usuario_id: userRow.id,
    nombreCompleto: userRow.nombre_usuario,
    numeroDocumento: userRow.cedula,
    correoPersonal: suggestedEmail,
    moneda: userRow.moneda_cobro || existingRow?.moneda || "COP",
    modulo_id: moduloId,
    modulo_nombre: moduloRes.rows[0]?.titulo || ""
  };

  const payload = buildAnexoInsertPayload({
    input: {
      ...input,
      tipo_asignacion: tipoAsignacion,
      correo_personal: suggestedEmail,
      modulo_id: moduloId
    },
    personaContext,
    solicitudId: existingRow?.solicitud_contratacion_id || null,
    preregistroId: existingRow?.preregistro_id || null,
    clienteId,
    clienteNombre,
    creadoPor: existingRow?.creado_por || actorUserId || null,
    origen: existingRow?.origen || "manual"
  });

  return {
    ...payload,
    usuario_id: userRow.id,
    modulo_id: moduloId,
    estado_firma:
      existingRow?.estado_firma === "firmado"
        ? "pendiente"
        : (existingRow?.estado_firma || "pendiente"),
    updated_by: existingRow ? actorUserId || null : null
  };
}

async function getActiveAnexoIndividualTokenByUser(userId) {
  if (!userId) return null;
  const r = await pool.query(
    `
    SELECT
      t.*,
      u.public_id AS usuario_public_id
    FROM tokens_firma_anexo_individual t
    LEFT JOIN usuarios u ON u.id = t.usuario_id
    WHERE t.usuario_id = $1
      AND t.estado = 'enviado'
    ORDER BY t.created_at DESC
    LIMIT 1
    `,
    [userId]
  );
  return r.rows[0] || null;
}

async function getLastSignedAnexoIndividualTokenByUser(userId) {
  if (!userId) return null;
  const r = await pool.query(
    `
    SELECT
      t.*,
      u.public_id AS usuario_public_id
    FROM tokens_firma_anexo_individual t
    LEFT JOIN usuarios u ON u.id = t.usuario_id
    WHERE t.usuario_id = $1
      AND t.estado = 'firmado'
    ORDER BY t.firmado_at DESC NULLS LAST, t.created_at DESC
    LIMIT 1
    `,
    [userId]
  );
  return r.rows[0] || null;
}

async function buildAnexoIndividualDashboardPayload(userRow, { includeFinalizados = false } = {}) {
  const correoFirmanteSugerido = await resolveSuggestedAnexoFirmanteEmailForUser(userRow);
  const items = await listAnexoItemsForUsuario(userRow, {
    includeFinalizados,
    correoPersonalFallback: correoFirmanteSugerido
  });
  const activos = items.filter((item) => item.estado === "activo");
  const finalizados = items.filter((item) => item.estado === "finalizado");
  const tokenActivo = await getActiveAnexoIndividualTokenByUser(userRow.id);
  const ultimoFirmado = await getLastSignedAnexoIndividualTokenByUser(userRow.id);
  const firmadoAt = ultimoFirmado?.firmado_at ? new Date(ultimoFirmado.firmado_at).getTime() : 0;
  const tieneCambiosDesdeUltimaFirma = Boolean(
    firmadoAt &&
    activos.some((item) => {
      const updatedAt = new Date(item.updated_at || item.created_at || 0).getTime();
      return Number.isFinite(updatedAt) && updatedAt > firmadoAt;
    })
  );

  return {
    usuario: {
      id: userRow.public_id,
      nombre: userRow.nombre_usuario,
      email: userRow.email,
      cedula: userRow.cedula || null,
      tipo_consultor: userRow.tipo_consultor || null,
      tipo_documento: userRow.tipo_documento_codigo || userRow.tipo_documento_titulo || null
    },
    correo_firmante_sugerido: correoFirmanteSugerido,
    token_activo: mapAnexoIndividualTokenRow(tokenActivo),
    ultimo_token_firmado: mapAnexoIndividualTokenRow(ultimoFirmado),
    tiene_cambios_desde_ultima_firma: tieneCambiosDesdeUltimaFirma,
    items_activos: activos.map(toAnexoApiRow),
    items_finalizados: includeFinalizados ? finalizados.map(toAnexoApiRow) : []
  };
}

async function uploadAnexoIndividualFirmadoToOneDrive(proceso, pdfBuffer, fileName) {
  const token = await getGraphAccessToken();
  const encodedUser = encodeURIComponent(ONEDRIVE_TARGET_USER);
  await graphGet(`/v1.0/users/${encodedUser}/drive`, token);

  const fechaStr = new Date().toISOString().slice(0, 10);
  const shortPublicId = String(proceso?.public_id || "").replace(/-/g, "").slice(0, 8) || "anexo";
  const folderName = sanitizePathSegment(
    `${proceso.nombre_persona} - ${fechaStr} - ${shortPublicId}`,
    `AnexoTecnico_${fechaStr}_${shortPublicId}`
  );

  let targetPath = sanitizePathSegment(ANEXO_INDIVIDUAL_ONEDRIVE_FOLDER, "AnexoTecnicoIndividual");
  targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, "", targetPath);
  targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, folderName);

  let folderWebUrl = "";
  try {
    const folderMeta = await graphGet(
      `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(targetPath)}`,
      token
    );
    folderWebUrl = String(folderMeta?.webUrl || "").trim();
  } catch (folderErr) {
    console.warn("No se pudo resolver URL de carpeta OneDrive para anexo individual:", folderErr?.message || folderErr);
  }

  const safeName = sanitizePdfFileName(
    fileName || `AnexoTecnico_${proceso?.nombre_persona || "Persona"}_${fechaStr}.pdf`,
    "AnexoTecnico.pdf"
  );
  const uploadPath = `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(`${targetPath}/${safeName}`)}:/content`;
  const uploaded = await graphPutBinaryWithRetry(uploadPath, token, pdfBuffer, "application/pdf");

  return {
    carpeta: targetPath,
    carpeta_url: folderWebUrl || null,
    archivo: {
      id: uploaded.id || "",
      nombre: uploaded.name || safeName,
      url: uploaded.webUrl || ""
    }
  };
}

function buildAnexoIndividualFirmaCompletadaEmail({ proceso }) {
  const fechaFirma = proceso?.firmado_at
    ? new Date(proceso.firmado_at).toLocaleString("es-CO", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    })
    : new Date().toLocaleString("es-CO");
  const url = String(proceso?.onedrive_url || "").trim();

  return {
    subject: `${proceso?.nombre_persona || "Persona"} ha firmado su anexo tecnico`,
    text:
      `Se completo la firma del anexo tecnico individual.\n` +
      `Persona: ${proceso?.nombre_persona || "N/A"}\n` +
      `Fecha de firma: ${fechaFirma}\n` +
      `Archivo: ${url || "Pendiente de enlace en OneDrive"}\n`,
    html: buildEmailLayout({
      title: "Anexo tecnico firmado",
      intro: `Se completo la firma del anexo tecnico individual de <strong>${proceso?.nombre_persona || "N/A"}</strong>.`,
      blocks: [
        { label: "Persona", value: proceso?.nombre_persona || "N/A" },
        { label: "Fecha de firma", value: fechaFirma },
        { label: "Archivo", value: url || "Pendiente de enlace en OneDrive" }
      ],
      ctaLabel: url ? "Abrir archivo firmado" : null,
      ctaUrl: url || null,
      closing: "Notificacion automatica del modulo de anexo tecnico individual."
    })
  };
}

async function notifyAnexoIndividualFirmaCompletada(tokenId) {
  const recipients = await resolveTalentoHumanoNotificationRecipients({
    fallback: ANEXO_INDIVIDUAL_FALLBACK_NOTIFY_EMAIL
  });
  if (!tokenId || recipients.length === 0) {
    return { ok: false, skipped: "config_missing" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
      SELECT *
      FROM tokens_firma_anexo_individual
      WHERE id = $1
      FOR UPDATE
      `,
      [tokenId]
    );
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, skipped: "not_found" };
    }

    const proceso = result.rows[0];
    if (proceso.estado !== "firmado") {
      await client.query("ROLLBACK");
      return { ok: false, skipped: "not_signed" };
    }
    if (proceso.firma_notificada_at) {
      await client.query("ROLLBACK");
      return { ok: true, skipped: "already_notified" };
    }
    if (!String(proceso.onedrive_url || "").trim()) {
      await client.query("ROLLBACK");
      return { ok: false, skipped: "pending_onedrive_upload" };
    }

    const mail = buildAnexoIndividualFirmaCompletadaEmail({ proceso });
    const sendResult = await sendEmailSafe({
      graphUserEmail: CONTRATOS_FIRMA_COMPLETADA_SENDER || ONEDRIVE_TARGET_USER,
      to: recipients,
      subject: mail.subject,
      text: mail.text,
      html: mail.html
    });
    if (!sendResult?.ok) {
      await client.query("ROLLBACK");
      return { ok: false, skipped: "send_failed", error: sendResult.error || null };
    }

    await client.query(
      `
      UPDATE tokens_firma_anexo_individual
      SET firma_notificada_at = NOW(),
          firma_notificada_a = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [tokenId, recipients.join(", ")]
    );
    await client.query("COMMIT");
    return { ok: true, notified_to: recipients };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch { }
    throw err;
  } finally {
    client.release();
  }
}

async function handleClickSignAnexoIndividualWebhook({ event, requestId, contractId, status, rawStatus }) {
  if (status !== "signed" && status !== "rejected") return false;

  let proceso = null;
  if (requestId) {
    const byRequest = await pool.query(
      `
      SELECT *
      FROM tokens_firma_anexo_individual
      WHERE request_id = $1
        AND estado = 'enviado'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [requestId]
    );
    proceso = byRequest.rows[0] || null;
  }

  if (!proceso && contractId) {
    const byContract = await pool.query(
      `
      SELECT *
      FROM tokens_firma_anexo_individual
      WHERE contract_id = $1
        AND estado = 'enviado'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [contractId]
    );
    proceso = byContract.rows[0] || null;
  }

  if (!proceso) return false;

  try {
    if (status === "rejected") {
      await pool.query(
        `
        UPDATE tokens_firma_anexo_individual
        SET estado = 'rechazado',
            updated_at = NOW()
        WHERE id = $1
        `,
        [proceso.id]
      );
      await pool.query(
        `
        UPDATE anexo_tecnico_items
        SET estado_firma = 'pendiente',
            updated_at = NOW()
        WHERE id = ANY($1::int[])
        `,
        [proceso.anexo_item_ids || []]
      );
      return true;
    }

    const signatureId = String(extractClickSignSignatureId(event) || proceso.signature_id || "").trim();
    let oneDriveInfo = null;

    try {
      const artifacts = await resolveClickSignArtifacts({
        event,
        requestId,
        contractId,
        publicId: String(proceso.public_id || ""),
        signatureId
      });
      const resolvedPdf = artifacts?.signedPdf || null;
      if (resolvedPdf && isPdfBuffer(resolvedPdf.buffer)) {
        oneDriveInfo = await uploadAnexoIndividualFirmadoToOneDrive(
          proceso,
          resolvedPdf.buffer,
          resolvedPdf.fileName || `AnexoTecnico_${sanitizePathSegment(proceso.nombre_persona, "Persona")}.pdf`
        );
      }
    } catch (artifactErr) {
      console.error("Error resolviendo firmado de anexo individual:", artifactErr?.message || artifactErr);
    }

    await pool.query(
      `
      UPDATE tokens_firma_anexo_individual
      SET estado = 'firmado',
          firmado_at = COALESCE(firmado_at, NOW()),
          signature_id = COALESCE($2, signature_id),
          onedrive_url = COALESCE($3, onedrive_url),
          onedrive_carpeta = COALESCE($4, onedrive_carpeta),
          onedrive_carpeta_url = COALESCE($5, onedrive_carpeta_url),
          updated_at = NOW()
      WHERE id = $1
      `,
      [
        proceso.id,
        signatureId || null,
        oneDriveInfo?.archivo?.url || null,
        oneDriveInfo?.carpeta || null,
        oneDriveInfo?.carpeta_url || null
      ]
    );

    await pool.query(
      `
      UPDATE anexo_tecnico_items
      SET estado_firma = 'firmado',
          updated_at = NOW()
      WHERE id = ANY($1::int[])
      `,
      [proceso.anexo_item_ids || []]
    );

    try {
      await notifyAnexoIndividualFirmaCompletada(proceso.id);
    } catch (notifyErr) {
      console.error("Error notificando firma de anexo individual:", notifyErr?.message || notifyErr);
    }

    return true;
  } catch (err) {
    console.error("Error procesando webhook de anexo individual:", err?.message || err);
    return true;
  }
}

function normalizeTemplateFileName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getDocxTemplateBinary(templateFile) {
  const safeTemplate = toNullableTrimmedString(templateFile);
  if (!safeTemplate) {
    throw new Error("template_file no definido para documento de contrato");
  }

  const directPath = path.join(CONTRATOS_DOCX_DIR, safeTemplate);
  const normalizedTemplate = normalizeTemplateFileName(safeTemplate);
  let resolvedPath = directPath;

  if (!fs.existsSync(resolvedPath)) {
    try {
      const files = fs.readdirSync(CONTRATOS_DOCX_DIR);
      const match = files.find((name) => normalizeTemplateFileName(name) === normalizedTemplate);
      if (match) {
        resolvedPath = path.join(CONTRATOS_DOCX_DIR, match);
      }
    } catch (_) {
      // keep default path and fail below with explicit error.
    }
  }

  if (docxTemplateCache.has(resolvedPath)) return docxTemplateCache.get(resolvedPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Plantilla de contrato no encontrada: ${safeTemplate}`);
  }

  const binary = fs.readFileSync(resolvedPath, "binary");
  docxTemplateCache.set(resolvedPath, binary);
  return binary;
}

function extractDocxtemplaterErrorDetails(err) {
  const details = Array.isArray(err?.properties?.errors)
    ? err.properties.errors.map((e) => e?.properties?.explanation || e?.message).filter(Boolean)
    : [];
  if (details.length) return details;
  const single = err?.properties?.explanation || err?.message;
  return single ? [String(single)] : ["error desconocido"];
}

function buildDocxtemplaterInstanceFromBinary(binary, templateFile) {
  const baseOptions = {
    paragraphLoop: true,
    linebreaks: true,
    parser: createDocxtemplaterParser,
    nullGetter: () => ""
  };

  const attempts = [
    {
      name: "double-braces",
      options: {
        ...baseOptions,
        delimiters: { start: "{{", end: "}}" },
        syntax: { allowUnopenedTag: true, allowUnclosedTag: true }
      }
    },
    {
      name: "single-braces-legacy",
      options: baseOptions
    }
  ];

  const attemptErrors = [];
  for (const attempt of attempts) {
    try {
      const zip = new PizZip(binary);
      return new Docxtemplater(zip, attempt.options);
    } catch (err) {
      const details = extractDocxtemplaterErrorDetails(err);
      attemptErrors.push({ attempt: attempt.name, details });
      console.warn(
        `[docxtemplater] Fallo compilando plantilla (${templateFile}) con modo ${attempt.name}:`,
        details.slice(0, 5).join(" | ")
      );
    }
  }

  const summary = attemptErrors
    .map((item) => `${item.attempt}: ${item.details.slice(0, 3).join(" | ")}`)
    .join(" || ");
  throw new Error(`Error compilando plantilla ${templateFile}: ${summary || "sin detalles"}`);
}

function renderDocxTemplateToBuffer({ templateFile, data }) {
  if (!PizZip || !Docxtemplater) {
    throw new Error("Dependencias DOCX no disponibles en servidor (pizzip/docxtemplater)");
  }
  const binary = getDocxTemplateBinary(templateFile);
  const doc = buildDocxtemplaterInstanceFromBinary(binary, templateFile);
  try {
    doc.render(data || {});
  } catch (err) {
    const details = extractDocxtemplaterErrorDetails(err);
    throw new Error(`Error renderizando plantilla ${templateFile}: ${details.slice(0, 6).join(" | ")}`);
  }
  return doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE"
  });
}

function enqueueDocxToPdf(task) {
  return new Promise((resolve, reject) => {
    docxToPdfQueue.push({ task, resolve, reject });
    setImmediate(processDocxToPdfQueue);
  });
}

async function processDocxToPdfQueue() {
  if (docxToPdfBusy) return;
  const next = docxToPdfQueue.shift();
  if (!next) return;
  docxToPdfBusy = true;
  try {
    const result = await next.task();
    next.resolve(result);
  } catch (err) {
    next.reject(err);
  } finally {
    docxToPdfBusy = false;
    setImmediate(processDocxToPdfQueue);
  }
}

function isAdobePdfConfigured() {
  return Boolean(ADOBE_PDF_CLIENT_ID && ADOBE_PDF_CLIENT_SECRET);
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAdobePdfAuthHeaders(accessToken, extraHeaders = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "x-api-key": ADOBE_PDF_CLIENT_ID,
    ...extraHeaders
  };
  if (ADOBE_PDF_ORGANIZATION_ID) {
    headers["x-gw-ims-org-id"] = ADOBE_PDF_ORGANIZATION_ID;
  }
  return headers;
}

function formatExternalServiceError(detail) {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return detail;
  if (typeof detail === "number" || typeof detail === "boolean") return String(detail);
  if (Array.isArray(detail)) {
    return detail
      .map((item) => formatExternalServiceError(item))
      .filter(Boolean)
      .join(" | ");
  }
  if (detail && typeof detail === "object") {
    const nested =
      formatExternalServiceError(detail.error) ||
      formatExternalServiceError(detail.message) ||
      formatExternalServiceError(detail.description) ||
      formatExternalServiceError(detail.error_description) ||
      formatExternalServiceError(detail.errors);
    if (nested) return nested;
    try {
      return JSON.stringify(detail);
    } catch (err) {
      return String(detail);
    }
  }
  return String(detail);
}

async function getAdobePdfAccessToken() {
  const nowMs = Date.now();
  if (
    adobePdfTokenCache.accessToken &&
    adobePdfTokenCache.expiresAtMs > nowMs + 60000
  ) {
    return adobePdfTokenCache.accessToken;
  }

  if (!isAdobePdfConfigured()) {
    throw new Error("Adobe PDF Services no esta configurado (faltan ADOBE_PDF_CLIENT_ID o ADOBE_PDF_CLIENT_SECRET)");
  }

  const baseFields = {
    client_id: ADOBE_PDF_CLIENT_ID,
    client_secret: ADOBE_PDF_CLIENT_SECRET
  };
  if (ADOBE_PDF_SCOPE) {
    baseFields.scope = ADOBE_PDF_SCOPE;
  }

  const tokenAttempts = [
    {
      label: "official_form",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      fields: {
        ...baseFields
      }
    },
    {
      label: "official_form_with_api_key",
      headers: {
        "x-api-key": ADOBE_PDF_CLIENT_ID,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      fields: {
        ...baseFields
      }
    },
    {
      label: "client_credentials_fallback",
      headers: {
        "x-api-key": ADOBE_PDF_CLIENT_ID,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      fields: {
        grant_type: "client_credentials",
        ...baseFields
      }
    }
  ];

  const failures = [];
  let tokenRes = null;
  for (const attempt of tokenAttempts) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(attempt.fields)) {
      if (value === undefined || value === null || value === "") continue;
      form.set(key, String(value));
    }
    try {
      tokenRes = await jsonRequest({
        method: "POST",
        url: ADOBE_PDF_TOKEN_URL,
        headers: attempt.headers,
        body: form.toString(),
        timeoutMs: ADOBE_PDF_TIMEOUT_MS
      });
      const token = pickStringByPaths(tokenRes?.data || {}, ["access_token", "token"]);
      if (token) {
        const expiresInSec = Math.max(300, Number(tokenRes?.data?.expires_in || 3600));
        adobePdfTokenCache = {
          accessToken: token,
          expiresAtMs: nowMs + expiresInSec * 1000
        };
        return token;
      }
      failures.push(`${attempt.label}: respuesta sin access_token`);
    } catch (err) {
      const detail =
        formatExternalServiceError(err?.response) ||
        formatExternalServiceError(err?.message) ||
        "sin detalle";
      failures.push(`${attempt.label}: HTTP ${Number(err?.status || 0) || "?"} ${detail}`);
    }
  }

  throw new Error(`No se pudo obtener token de Adobe PDF Services: ${failures.join(" || ") || "sin detalle"}`);
}

function normalizeAdobeJobStatus(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .trim();
}

async function waitAdobeCreatePdfResult(statusUrl, accessToken) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= ADOBE_PDF_POLL_TIMEOUT_MS) {
    const statusRes = await jsonRequest({
      method: "GET",
      url: statusUrl,
      headers: buildAdobePdfAuthHeaders(accessToken),
      timeoutMs: ADOBE_PDF_TIMEOUT_MS
    });
    const payload = statusRes?.data || {};
    const statusRaw = pickStringByPaths(payload, [
      "status",
      "state",
      "result.status",
      "job.status"
    ]);
    const status = normalizeAdobeJobStatus(statusRaw);
    if (["done", "succeeded", "success", "completed"].includes(status)) {
      return payload;
    }
    if (["failed", "error", "cancelled", "canceled", "aborted"].includes(status)) {
      const detail = pickStringByPaths(payload, [
        "error.message",
        "error.description",
        "message",
        "errors.0.message"
      ]);
      throw new Error(`Adobe PDF Services reporto fallo en createpdf: ${detail || statusRaw || "sin detalle"}`);
    }
    await sleepMs(ADOBE_PDF_POLL_INTERVAL_MS);
  }
  throw new Error(`Adobe PDF Services excedio timeout de espera (${ADOBE_PDF_POLL_TIMEOUT_MS} ms)`);
}

function extractAdobeDownloadUri(payload) {
  return pickStringByPaths(payload || {}, [
    "asset.downloadUri",
    "asset.downloadURL",
    "downloadUri",
    "downloadURL",
    "result.downloadUri",
    "result.downloadURL",
    "resource.downloadUri",
    "outputs.0.downloadUri"
  ]);
}

function extractAdobeAssetId(payload) {
  return pickStringByPaths(payload || {}, [
    "asset.assetID",
    "asset.assetId",
    "assetID",
    "assetId",
    "result.assetID",
    "result.assetId",
    "outputs.0.assetID"
  ]);
}

async function resolveAdobeOutputDownloadUri({ payload, accessToken }) {
  const direct = extractAdobeDownloadUri(payload);
  if (direct) return direct;

  const assetId = extractAdobeAssetId(payload);
  if (!assetId) {
    throw new Error("Adobe PDF Services no devolvio downloadUri ni assetID del PDF generado");
  }

  const assetRes = await jsonRequest({
    method: "GET",
    url: `${ADOBE_PDF_API_BASE}/assets/${encodeURIComponent(assetId)}`,
    headers: buildAdobePdfAuthHeaders(accessToken),
    timeoutMs: ADOBE_PDF_TIMEOUT_MS
  });

  const uri = extractAdobeDownloadUri(assetRes?.data || {});
  if (!uri) {
    throw new Error("Adobe PDF Services no devolvio URL de descarga para el asset convertido");
  }
  return uri;
}

async function runAdobeDocxToPdfConvert({ docxBuffer }) {
  if (!Buffer.isBuffer(docxBuffer) || !docxBuffer.length) {
    throw new Error("Buffer DOCX vacio para conversion Adobe");
  }

  const accessToken = await getAdobePdfAccessToken();
  const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  const assetCreate = await jsonRequest({
    method: "POST",
    url: `${ADOBE_PDF_API_BASE}/assets`,
    headers: buildAdobePdfAuthHeaders(accessToken, {
      "Content-Type": "application/json"
    }),
    body: { mediaType: docxMime },
    timeoutMs: ADOBE_PDF_TIMEOUT_MS
  });

  const uploadUri = pickStringByPaths(assetCreate?.data || {}, ["uploadUri", "uploadURL"]);
  const inputAssetId = extractAdobeAssetId(assetCreate?.data || {});
  if (!uploadUri || !inputAssetId) {
    throw new Error("Adobe PDF Services no devolvio uploadUri/assetID para subir el DOCX");
  }

  await binaryRequest({
    method: "PUT",
    url: uploadUri,
    headers: {
      "Content-Type": docxMime
    },
    body: docxBuffer,
    timeoutMs: ADOBE_PDF_TIMEOUT_MS
  });

  const createPdfRes = await jsonRequest({
    method: "POST",
    url: `${ADOBE_PDF_API_BASE}/operation/createpdf`,
    headers: buildAdobePdfAuthHeaders(accessToken, {
      "Content-Type": "application/json"
    }),
    body: { assetID: inputAssetId },
    timeoutMs: ADOBE_PDF_TIMEOUT_MS
  });

  const locationHeader = String(
    createPdfRes?.headers?.location ||
    createPdfRes?.headers?.Location ||
    ""
  ).trim();
  const statusUrl = locationHeader
    ? new URL(locationHeader, ADOBE_PDF_API_BASE).toString()
    : pickStringByPaths(createPdfRes?.data || {}, ["statusUrl", "statusURL", "location", "self"]);

  if (!statusUrl) {
    throw new Error("Adobe PDF Services no devolvio URL de seguimiento para createpdf");
  }

  const finalPayload = await waitAdobeCreatePdfResult(statusUrl, accessToken);
  const downloadUri = await resolveAdobeOutputDownloadUri({
    payload: finalPayload,
    accessToken
  });

  try {
    const downloadRes = await binaryRequest({
      method: "GET",
      url: downloadUri,
      timeoutMs: ADOBE_PDF_TIMEOUT_MS
    });
    if (isPdfBuffer(downloadRes?.buffer)) {
      return downloadRes.buffer;
    }
  } catch (_) {
    // Continúa con variante alterna autenticada.
  }

  const authedDownloadRes = await binaryRequest({
    method: "GET",
    url: downloadUri,
    headers: buildAdobePdfAuthHeaders(accessToken),
    timeoutMs: ADOBE_PDF_TIMEOUT_MS
  });

  if (!isPdfBuffer(authedDownloadRes?.buffer)) {
    throw new Error("Adobe PDF Services devolvio un archivo no valido al descargar el PDF generado");
  }

  return authedDownloadRes.buffer;
}

async function convertDocxBufferToPdfBuffer(docxBuffer, fileBaseName) {
  const safeBase = sanitizePathSegment(fileBaseName || "contrato", "contrato");
  let lastError = null;
  for (let attempt = 0; attempt <= ADOBE_PDF_RETRY_COUNT; attempt += 1) {
    try {
      return await enqueueDocxToPdf(() =>
        runAdobeDocxToPdfConvert({
          docxBuffer,
          fileBaseName: safeBase
        })
      );
    } catch (err) {
      lastError = err;
      if (attempt < ADOBE_PDF_RETRY_COUNT) {
        console.warn(
          `Reintentando conversion DOCX->PDF con Adobe (intento ${attempt + 2}/${ADOBE_PDF_RETRY_COUNT + 1}):`,
          err?.message || err
        );
      }
    }
  }
  throw lastError || new Error("No se pudo convertir DOCX a PDF con Adobe PDF Services");
}

function buildContratistaComparecencia(personaContext) {
  const nombre = personaContext?.nombreCompleto || "";
  const tipoDoc = personaContext?.tipoDocumento || "";
  const numDoc = personaContext?.numeroDocumento || "";
  const tipoPersona = personaContext?.tipoPersona || "Natural";

  if (tipoPersona === "Jurídica" || tipoPersona === "Juridica") {
    const razonSocial = personaContext?.razonSocial || nombre;
    const nitEmpresa = personaContext?.nitEmpresa || "";
    const repLegal = personaContext?.representanteLegalContratista || nombre;
    const tipoDocRep = personaContext?.tipoDocumentoRepresentante || tipoDoc;
    const numDocRep = personaContext?.numeroDocumentoRepresentante || numDoc;
    const nitPart = nitEmpresa ? `, persona jurídica identificada con NIT ${nitEmpresa}` : "";
    return `${razonSocial}${nitPart}, representada legalmente por ${repLegal}, identificado con ${tipoDocRep} ${numDocRep}`;
  }

  // Persona natural
  return `${nombre}, identificado con ${tipoDoc} ${numDoc}, obrando en nombre propio`;
}

function buildContratistaFirmaPayload(personaContext) {
  const tipoPersona = personaContext?.tipoPersona || "Natural";
  const isJuridica = tipoPersona === "Jurídica" || tipoPersona === "Juridica";
  const nombre = isJuridica
    ? (personaContext?.representanteLegalContratista || personaContext?.nombreCompleto || "")
    : (personaContext?.nombreCompleto || "");
  const tipoDoc = isJuridica
    ? (personaContext?.tipoDocumentoRepresentante || personaContext?.tipoDocumento || "")
    : (personaContext?.tipoDocumento || "");
  const numeroDoc = isJuridica
    ? (personaContext?.numeroDocumentoRepresentante || personaContext?.numeroDocumento || "")
    : (personaContext?.numeroDocumento || "");

  return {
    ContratistaFirmaNombre: nombre,
    ContratistaFirmaDocumento: [tipoDoc, numeroDoc].filter(Boolean).join(" "),
    ContratistaFirmaNit: isJuridica ? (personaContext?.nitEmpresa || "") : "",
    ContratistaFirmaCargo: isJuridica ? "Representante Legal" : "Contratista"
  };
}

function buildContratoBaseTemplatePayload({ personaContext, proceso = {}, correoOverride = null } = {}) {
  const now = new Date();
  const diaMes = new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    timeZone: "America/Bogota"
  }).format(now);
  const anio = new Intl.DateTimeFormat("es-CO", {
    year: "numeric",
    timeZone: "America/Bogota"
  }).format(now);
  const mesTexto = formatMonthNameEs(now.toISOString().slice(0, 10));

  // Fecha de inicio del contrato: fecha_inicio de la solicitud → fecha de generación
  const fechaInicioRaw =
    personaContext?.fecha_inicio ||
    personaContext?.fecha_extension_desde ||
    null;
  const fechaInicioDate = fechaInicioRaw
    ? new Date(`${String(fechaInicioRaw).slice(0, 10)}T12:00:00.000Z`)
    : now;
  const fechaInicioDia = new Intl.DateTimeFormat("es-CO", { day: "2-digit", timeZone: "America/Bogota" }).format(fechaInicioDate);
  const fechaInicioAnio = new Intl.DateTimeFormat("es-CO", { year: "numeric", timeZone: "America/Bogota" }).format(fechaInicioDate);
  const fechaInicioMesTexto = formatMonthNameEs(fechaInicioDate.toISOString().slice(0, 10));
  const fechaInicioContrato = `${Number(fechaInicioDia)} de ${fechaInicioMesTexto} de ${fechaInicioAnio}`;

  const empresa = resolveEmpresaContratoConfig(personaContext?.facturaEnColombia ?? null);
  const contratistaFirma = buildContratistaFirmaPayload(personaContext);

  return {
    NombreCompleto: personaContext?.nombreCompleto || proceso?.nombre_persona || "",
    TipoDocumento: personaContext?.tipoDocumento || "",
    NumeroDocumento: personaContext?.numeroDocumento || "",
    Telefono: personaContext?.telefono || "",
    Correo: correoOverride || personaContext?.correoPersonal || proceso?.correo_personal || "",
    CorreoPersonal: correoOverride || personaContext?.correoPersonal || proceso?.correo_personal || "",
    Ciudad: personaContext?.ciudad || empresa.ciudad,
    DiaMes: diaMes,
    MesTexto: mesTexto,
    Anio: anio,
    // Fecha de inicio del contrato (dinámica según solicitud)
    FechaInicioDia: fechaInicioDia,
    FechaInicioMesTexto: fechaInicioMesTexto,
    FechaInicioAnio: fechaInicioAnio,
    FechaInicioContrato: fechaInicioContrato,
    Direccion: personaContext?.direccion || "",
    ContratistaComparecencia: buildContratistaComparecencia(personaContext),
    // Tags de empresa contratante (genéricos, compatibles Silver y Capital)
    EmpresaRazonSocial: empresa.razonSocial,
    EmpresaRepresentanteLegal: empresa.representanteLegal,
    EmpresaCedulaRepresentante: empresa.cedulaRepresentante,
    EmpresaNit: empresa.nit,
    EmpresaCiudad: empresa.ciudad,
    EmpresaDomicilio: empresa.domicilio,
    // Tags legacy Silver — se mantienen por compatibilidad con plantillas existentes
    RepresentanteLegal: empresa.representanteLegal,
    CedulaRL: empresa.cedulaRepresentante,
    NitSilver: empresa.nit,
    CiudadSilver: empresa.ciudad,
    ...contratistaFirma
  };
}

async function buildContratoTemplatePayload({ docDefinition, personaContext, proceso }) {
  const payload = buildContratoBaseTemplatePayload({ personaContext, proceso });

  if (docDefinition?.doc_key === "anexo_tecnico") {
    const items = await requirePersistedAnexoFromProceso(proceso, personaContext);
    payload.items = (items || []).map(buildAnexoItemForTemplateRow);
  }

  return payload;
}

async function generateContratoPdfFromTemplate({ docDefinition, personaContext, proceso, fileBaseName }) {
  const payload = await buildContratoTemplatePayload({ docDefinition, personaContext, proceso });
  const docxBuffer = renderDocxTemplateToBuffer({
    templateFile: docDefinition.template_file,
    data: payload
  });
  return convertDocxBufferToPdfBuffer(docxBuffer, fileBaseName);
}

async function generateAnexoIndividualPdfFromItems({ userRow, items, correoFirmante }) {
  const docDefinition = getContratoDocDefinition("anexo_tecnico");
  if (!docDefinition) {
    throw new Error("No se encontro la configuracion del anexo tecnico");
  }

  const personaContext = {
    nombreCompleto: userRow?.nombre_usuario || "",
    tipoDocumento: userRow?.tipo_documento_codigo || userRow?.tipo_documento_titulo || "",
    numeroDocumento: userRow?.cedula || "",
    telefono: userRow?.telefono || "",
    correoPersonal: correoFirmante || userRow?.email || "",
    ciudad: userRow?.ciudad || CONTRATOS_CIUDAD_SILVER,
    direccion: userRow?.direccion || ""
  };
  const payload = buildContratoBaseTemplatePayload({
    personaContext,
    proceso: {
      nombre_persona: userRow?.nombre_usuario || "",
      correo_personal: correoFirmante || userRow?.email || ""
    },
    correoOverride: correoFirmante || userRow?.email || ""
  });
  payload.items = (items || []).map(buildAnexoItemForTemplateRow);

  const personaSlug = sanitizePathSegment(
    String(userRow?.nombre_usuario || "Persona").replace(/\s+/g, "_"),
    "Persona"
  );
  const fileBaseName = `${personaSlug}_anexo_individual_${Date.now()}`;
  const docxBuffer = renderDocxTemplateToBuffer({
    templateFile: docDefinition.template_file,
    data: payload
  });
  const pdfBuffer = await convertDocxBufferToPdfBuffer(docxBuffer, fileBaseName);
  const fileName = sanitizePdfFileName(
    `AnexoTecnico_${personaSlug}_${new Date().toISOString().slice(0, 10)}.pdf`,
    "AnexoTecnico.pdf"
  );

  return {
    pdfBuffer,
    fileName,
    docDefinition
  };
}

async function collectAnexoIndividualSignatureContext({
  userInput,
  correoFirmante = "",
  requestedItemIds = [],
  client = pool,
  lockRows = false
} = {}) {
  const userRow = await getUsuarioAnexoIndividualById(userInput);
  if (!userRow) {
    const err = new Error("Usuario no encontrado");
    err.status = 404;
    throw err;
  }

  const numeroDocumento = toNullableTrimmedString(userRow.cedula);
  const correoPersonalFallback =
    toNullableTrimmedString(correoFirmante) ||
    toNullableTrimmedString(await resolveSuggestedAnexoFirmanteEmailForUser(userRow));
  const itemsSql = `
    SELECT
      ati.id,
      ati.public_id,
      ati.nombre_persona,
      ati.numero_documento,
      ati.correo_personal,
      ati.tipo_asignacion,
      ati.cliente_nombre,
      ati.moneda,
      ati.valor_tarifa,
      ati.fecha_inicio,
      ati.fecha_fin,
      ati.fecha_fin_calculada,
      ati.origen,
      ati.estado,
      ati.estado_firma,
      m.titulo AS modulo_titulo
    FROM anexo_tecnico_items ati
    LEFT JOIN modulo m ON m.id = ati.modulo_id
    WHERE ati.estado = 'activo'
      AND (
        ati.usuario_id = $1
        OR ($2::text IS NOT NULL AND ati.usuario_id IS NULL AND ati.numero_documento = $2)
        OR (
          $3::text IS NOT NULL
          AND ati.usuario_id IS NULL
          AND COALESCE(BTRIM(ati.numero_documento), '') = ''
          AND LOWER(COALESCE(ati.correo_personal, '')) = LOWER($3)
        )
      )
    ORDER BY ati.fecha_inicio DESC NULLS LAST, ati.created_at DESC
    ${lockRows ? "FOR UPDATE OF ati" : ""}
  `;
  const itemsResult = await client.query(itemsSql, [userRow.id, numeroDocumento, correoPersonalFallback]);
  const items = itemsResult.rows || [];
  if (!items.length) {
    const err = new Error("La persona no tiene items activos para firmar");
    err.status = 400;
    throw err;
  }

  const requestedIdsNormalized = Array.isArray(requestedItemIds)
    ? requestedItemIds.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (requestedIdsNormalized.length > 0) {
    const activeIds = new Set(
      items.flatMap((item) => [String(item.id), String(item.public_id || "")]).filter(Boolean)
    );
    const matchesAll =
      requestedIdsNormalized.length === items.length &&
      requestedIdsNormalized.every((id) => activeIds.has(id));
    if (!matchesAll) {
      const err = new Error("El envio siempre incluye todos los items activos actuales");
      err.status = 409;
      throw err;
    }
  }

  const correoSugerido =
    toNullableTrimmedString(correoFirmante) ||
    correoPersonalFallback ||
    toNullableTrimmedString(userRow.email) ||
    "";

  return {
    userRow,
    items,
    correoFirmante: correoSugerido
  };
}

function isAnexoIndividualInfraError(err) {
  const code = String(err?.code || "").trim();
  if (!["42P01", "42703", "42704", "42883"].includes(code)) return false;

  const haystack = `${err?.message || ""} ${err?.detail || ""} ${err?.hint || ""}`.toLowerCase();
  return [
    "tokens_firma_anexo_individual",
    "anexo_tecnico_items",
    "estado_firma",
    "usuario_id",
    "modulo_id",
    "public_id",
    "update_tokens_firma_anexo_individual_updated_at"
  ].some((fragment) => haystack.includes(fragment));
}

function buildAnexoIndividualInfraErrorPayload() {
  return {
    error: "El flujo de anexo tecnico individual no esta completamente habilitado en la base de datos.",
    detalle:
      "Aplica las migraciones 2026-03-24-anexo-individual-th.sql, 2026-03-25-anexo-individual-check-usuario.sql y 2026-03-25-anexo-individual-firma-hardening.sql."
  };
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

function graphPatch(path, accessToken, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const options = {
      hostname: "graph.microsoft.com",
      path,
      method: "PATCH",
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
            resolve(data ? JSON.parse(data) : {});
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

function sanitizeDownloadFileName(value, fallback = "documento.bin") {
  const safe = sanitizePathSegment(value || fallback, fallback).replace(/\.+/g, ".");
  return safe || fallback;
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

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await graphPost(requestPath, accessToken, {
        name: safeFolderName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail"
      });
      break;
    } catch (err) {
      const errorText = String(err.message || "");
      const alreadyExists =
        errorText.includes("nameAlreadyExists") ||
        errorText.includes("itemAlreadyExists");
      const resourceModified = errorText.includes("resourceModified");
      if (alreadyExists) break;
      if (resourceModified && attempt < 2) {
        await sleepMs(300 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  return parentPath ? `${parentPath}/${safeFolderName}` : safeFolderName;
}

async function graphPutBinaryWithRetry(path, accessToken, buffer, contentType = "application/octet-stream", retryCount = 1) {
  let lastError = null;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await graphPutBinary(path, accessToken, buffer, contentType);
    } catch (err) {
      lastError = err;
      const errorText = String(err?.message || "");
      const resourceModified = errorText.includes("resourceModified");
      if (!resourceModified || attempt >= retryCount) {
        throw err;
      }
      await sleepMs(400 * (attempt + 1));
    }
  }
  throw lastError || new Error("Graph upload failed");
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

function parseGraphErrorPayload(message) {
  const raw = String(message || "");
  const match = raw.match(/Graph(?: binary)? error (\d{3}):\s*([\s\S]*)$/);
  const status = match ? Number(match[1]) : null;
  const payloadRaw = match?.[2] || "";
  let payload = null;
  try {
    payload = payloadRaw ? JSON.parse(payloadRaw) : null;
  } catch (err) {
    payload = null;
  }
  return {
    status,
    code: payload?.error?.code || null,
    message: payload?.error?.message || null,
    request_id:
      payload?.error?.innerError?.["request-id"] ||
      payload?.error?.innerError?.requestId ||
      null,
    date: payload?.error?.innerError?.date || null
  };
}

function buildGraphErrorDetails(err, fallbackMessage = "Error desconocido") {
  const parsed = parseGraphErrorPayload(err?.message || "");
  return {
    status: parsed.status,
    code: parsed.code,
    message: parsed.message || err?.message || fallbackMessage,
    request_id: parsed.request_id,
    date: parsed.date
  };
}

function buildGraphUserCandidates(azureOid, email) {
  const candidates = [azureOid, email]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(candidates)];
}

function normalizeSkuIdList(input) {
  if (!Array.isArray(input)) return [];
  const values = input
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(values)];
}

async function executeGraphUserActionWithFallback(candidates, action) {
  let lastError = null;
  for (const userId of candidates) {
    try {
      const result = await action(userId);
      return { result, resolvedUserId: userId };
    } catch (err) {
      lastError = err;
      const status = parseGraphErrorStatus(err?.message || "");
      if (status !== 404) {
        throw err;
      }
    }
  }
  if (lastError) throw lastError;
  throw new Error("No fue posible resolver el usuario en Entra ID");
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

// Equivalente a: Get-MgSubscribedSku
// Requiere permiso de aplicación: Organization.Read.All
async function getSubscribedSkus(accessToken) {
  const data = await graphGet("/v1.0/subscribedSkus", accessToken);
  return (data?.value || []).map((sku) => ({
    skuId: sku.skuId,
    skuPartNumber: sku.skuPartNumber,
    consumedUnits: sku.consumedUnits,
    prepaidUnits: sku.prepaidUnits
  }));
}

async function getUserLicenseDetails(accessToken, userId) {
  const encodedUser = encodeURIComponent(userId);
  const data = await graphGet(
    `/v1.0/users/${encodedUser}/licenseDetails?$select=skuId,skuPartNumber`,
    accessToken
  );
  return (data?.value || []).map((item) => ({
    skuId: item?.skuId,
    skuPartNumber: item?.skuPartNumber
  }));
}

// Equivalente a: Set-MgUserLicense -UserId "..." -RemoveLicenses @("sku-id") -AddLicenses @()
// Requiere permiso de aplicación: User.ReadWrite.All
// userId puede ser email (UPN) o Azure OID
async function assignUserLicense(accessToken, userId, addLicenses = [], removeLicenses = []) {
  const encodedUser = encodeURIComponent(userId);
  return graphPost(`/v1.0/users/${encodedUser}/assignLicense`, accessToken, {
    addLicenses: addLicenses.map((skuId) => ({ skuId, disabledPlans: [] })),
    removeLicenses
  });
}

async function saveUserLicenseBackupSnapshot({
  userInternalId,
  userPublicId,
  azureOid,
  email,
  licenses = [],
  deactivatedByUserId = null,
  deactivatedByEmail = null
}) {
  const normalized = (licenses || [])
    .map((item) => ({
      skuId: String(item?.skuId || "").trim(),
      skuPartNumber: String(item?.skuPartNumber || "").trim() || null
    }))
    .filter((item) => item.skuId);

  if (!normalized.length) return null;

  const groupRes = await pool.query("SELECT gen_random_uuid()::text AS backup_group_id");
  const backupGroupId = groupRes.rows[0]?.backup_group_id;
  if (!backupGroupId) {
    throw new Error("No se pudo generar backup_group_id para el respaldo de licencias");
  }

  const skuIds = normalized.map((item) => item.skuId);
  const skuPartNumbers = normalized.map((item) => item.skuPartNumber);
  await pool.query(
    `
    INSERT INTO usuario_licencias_backup (
      backup_group_id,
      usuario_id,
      usuario_public_id,
      azure_oid,
      email,
      sku_id,
      sku_part_number,
      desactivado_por_usuario_id,
      desactivado_por_email
    )
    SELECT
      $1::uuid,
      $2,
      $3::uuid,
      $4,
      $5,
      s.sku_id,
      s.sku_part_number,
      $6,
      $7
    FROM unnest($8::text[], $9::text[]) AS s(sku_id, sku_part_number)
    `,
    [
      backupGroupId,
      userInternalId,
      userPublicId,
      azureOid || null,
      email || null,
      deactivatedByUserId,
      deactivatedByEmail || null,
      skuIds,
      skuPartNumbers
    ]
  );

  return backupGroupId;
}

async function getPendingLicenseBackupSnapshot(userInternalId) {
  const groupRes = await pool.query(
    `
    SELECT backup_group_id
    FROM usuario_licencias_backup
    WHERE usuario_id = $1
      AND restaurado = false
    ORDER BY fecha_desactivacion DESC
    LIMIT 1
    `,
    [userInternalId]
  );
  const backupGroupId = groupRes.rows[0]?.backup_group_id || null;
  if (!backupGroupId) {
    return { backupGroupId: null, licenses: [] };
  }

  const rowsRes = await pool.query(
    `
    SELECT sku_id, sku_part_number
    FROM usuario_licencias_backup
    WHERE usuario_id = $1
      AND restaurado = false
      AND backup_group_id = $2::uuid
    ORDER BY fecha_desactivacion DESC, sku_id ASC
    `,
    [userInternalId, backupGroupId]
  );

  return {
    backupGroupId,
    licenses: rowsRes.rows || []
  };
}

async function markLicenseBackupSnapshotRestored({
  userInternalId,
  backupGroupId,
  restoredByUserId = null,
  restoredByEmail = null
}) {
  if (!backupGroupId) return 0;
  const updateRes = await pool.query(
    `
    UPDATE usuario_licencias_backup
    SET
      restaurado = true,
      fecha_restauracion = NOW(),
      restaurado_por_usuario_id = $3,
      restaurado_por_email = $4
    WHERE usuario_id = $1
      AND restaurado = false
      AND backup_group_id = $2::uuid
    `,
    [userInternalId, backupGroupId, restoredByUserId, restoredByEmail || null]
  );
  return Number(updateRes.rowCount || 0);
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
        : Buffer.isBuffer(body)
          ? body
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
            resolve({ status, data: parsedBody, headers: res.headers || {} });
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
        : Buffer.isBuffer(body)
          ? body
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
  const uploaded = await graphPutBinaryWithRetry(uploadPath, token, pdfBuffer, "application/pdf");

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
    "signature.landing_url",
    "signature.sign_url",
    "signature.signatories.0.url",
    "signature.signatories.0.sign_url",
    "signature.signatories.0.landing_url",
    "signatories.0.url",
    "signatories.0.landing_url",
    "signatories.0.sign_url",
    "data.url",
    "data.sign_url",
    "data.landing_url",
    "data.signature.url",
    "data.signature.sign_url",
    "data.signature.landing_url",
    "data.signature.signatories.0.url",
    "data.signatories.0.url",
    "data.signatories.0.landing_url",
    "result.url",
    "result.sign_url",
    "result.landing_url",
    "result.signature.url",
    "result.signature.signatories.0.url"
  ];
  return pickStringByPaths(responseBody, directPaths);
}

function isClickSignConfigured({ forContratos = false } = {}) {
  const configId = forContratos ? CLICKSIGN_CONTRATOS_CONFIG_ID : CLICKSIGN_CONFIG_ID;
  return Boolean(CLICKSIGN_API_KEY && CLICKSIGN_USER && Number(configId || 0) > 0);
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

async function assertCuentaCobroOwnerAccess(createdBy, req) {
  const role = normalizeValue(req.user?.rol);
  if (["administrador", "coordinador"].includes(role)) return;
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
      u.moneda_cobro,
      COALESCE(p.numero_documento, u.cedula)            AS cedula,
      COALESCE(p.direccion_residencia, u.direccion)     AS direccion,
      COALESCE(p.numero_contacto, u.telefono)           AS telefono,
      COALESCE(p.ciudad_residencia, u.ciudad)           AS ciudad,
      COALESCE(p.numero_cuenta, u.nro_cuenta_bancaria)  AS nro_cuenta_bancaria,
      COALESCE(b_p.titulo, b_u.titulo)                  AS banco,
      COALESCE(tcb_p.titulo, tcb_u.titulo)              AS tipo_cuenta,
      COALESCE(di_p.titulo, di_u.titulo)                AS tipo_documento
    FROM cuenta_cobro cc
      JOIN usuarios u              ON cc.created_by       = u.id
      LEFT JOIN personas p         ON u.persona_id        = p.id
      LEFT JOIN bancos b_p         ON p.banco_id          = b_p.id
      LEFT JOIN bancos b_u         ON u.banco_id          = b_u.id
      LEFT JOIN tipo_cuenta_bancaria tcb_p ON p.tipo_cuenta_id = tcb_p.id
      LEFT JOIN tipo_cuenta_bancaria tcb_u ON u.tipo_cuenta_id = tcb_u.id
      LEFT JOIN documento_identidad di_p   ON p.tipo_documento_id = di_p.id
      LEFT JOIN documento_identidad di_u   ON u.tipo_documento_id = di_u.id
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
      ra.nro_caso_cliente AS asignacion_nro_caso_cliente,
      ra.nro_caso_interno AS asignacion_nro_caso_interno,
      rh.horas_reportadas,
      rh.cantidad_dias_reportados,
      rh.total_cobrar
    FROM reporte_horas rh
      LEFT JOIN clientes c ON rh.cliente_id = c.id
      LEFT JOIN modulo m ON rh.modulo_id = m.id
      LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
      LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
      LEFT JOIN registro_asignaciones ra ON rh.id_registro_asignacion = ra.id
    WHERE rh.id_cuenta_cobro = $1
    ORDER BY rh.id DESC
    `,
    [cuentaInternalId]
  );

  const detalles = (detallesRes.rows || []).map((row) => {
    const withCases = applyTicketCaseFields(row);
    return {
      ...withCases,
      nro_caso_cliente:
        withCases.nro_caso_cliente || row?.asignacion_nro_caso_cliente || null,
      nro_caso_interno:
        withCases.nro_caso_interno || row?.asignacion_nro_caso_interno || null
    };
  });

  return {
    cuenta,
    detalles
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

function normalizeCuentaCobroIdentityValue(value) {
  const raw = toNullableTrimmedString(value);
  if (!raw) return null;
  if (/^\d+\.0+$/.test(raw)) {
    return raw.replace(/\.0+$/, "");
  }
  return raw;
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
//  writeCuentaCobroPdf  ?  versión corregida
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

// Formatea fecha sin mostrar UTC ? acepta string ISO o Date
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

function infoRow(doc, x, y, label, value, labelWidth = 90, maxWidth = null) {
  const w = maxWidth !== null ? maxWidth : (pageWidth(doc) / 2 - labelWidth - 16);
  doc.fontSize(8.5).font("Helvetica-Bold").fillColor(COLOR.textoPrin)
    .text(label, x, y, { width: labelWidth, lineBreak: false });
  doc.font("Helvetica").fillColor(COLOR.textoSec)
    .text(String(value || "-"), x + labelWidth, y, { width: w, lineBreak: false, ellipsis: true });
}

function sectionTitle(doc, title, y) {
  const ML = MARGIN.left;
  fillRect(doc, ML, y, 3, 13, COLOR.turquesa);
  doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR.azulOscuro)
    .text(title, ML + 10, y + 1, { lineBreak: false });
  return y + 20;
}

// ====Función principal ============================================================
function buildCaseSummaryText(row = {}) {
  const parsed = parseTicketCaseFields(row?.nro_caso_int_ext);
  const casoCliente =
    normalizeCaseValue(row?.nro_caso_cliente) ||
    normalizeCaseValue(row?.asignacion_nro_caso_cliente) ||
    parsed.nro_caso_cliente;
  const casoInterno =
    normalizeCaseValue(row?.nro_caso_interno) ||
    normalizeCaseValue(row?.asignacion_nro_caso_interno) ||
    parsed.nro_caso_interno;
  if (casoCliente && casoInterno) return `Cli: ${casoCliente} | Int: ${casoInterno}`;
  if (casoCliente) return `Cli: ${casoCliente}`;
  if (casoInterno) return `Int: ${casoInterno}`;
  const legacy = normalizeCaseValue(row?.nro_caso_int_ext);
  return legacy || "-";
}

function fitSingleLineText(doc, value, maxWidth, { fontName = "Helvetica", fontSize = 8 } = {}) {
  const base = String(value ?? "-").replace(/\s+/g, " ").trim() || "-";
  doc.font(fontName).fontSize(fontSize);
  if (doc.widthOfString(base) <= maxWidth) return base;
  const suffix = "...";
  let current = base;
  while (current.length > 1 && doc.widthOfString(`${current}${suffix}`) > maxWidth) {
    current = current.slice(0, -1);
  }
  return `${current}${suffix}`;
}

function writeCuentaCobroPdf(doc, cuenta, detalles) {
  const PW = pageWidth(doc);
  const ML = MARGIN.left;
  const PW_TOTAL = doc.page.width; // ancho real de página

  const totalNumeros = Number(cuenta.total_cuenta_cobro || 0);
  const totalLetras = buildTotalLetras(totalNumeros, cuenta.moneda_cobro || "COP");
  const monedaSimbolo = String(cuenta.moneda_cobro || "COP").toUpperCase() === "USD" ? "USD" : "COP";
  const nombreConsultor = cuenta.nombre_usuario || "Consultor";
  const cedulaConsultor = normalizeCuentaCobroIdentityValue(cuenta.cedula) || "-";
  const telefonoConsultor = normalizeCuentaCobroIdentityValue(cuenta.telefono) || "-";
  const cuentaBancariaConsultor = cuenta.nro_cuenta_bancaria || "-";

  // ============================================================
  // 1. HEADER ? dos bloques separados sin solaparse
  // ============================================================
  const headerH = 80;
  fillRect(doc, 0, 0, PW_TOTAL, headerH, COLOR.azulMedio);

  // ? Bloque izquierdo: empresa
  doc.fontSize(15).font("Helvetica-Bold").fillColor(COLOR.blanco)
    .text("SILVER CONSULTING S.A.S.", ML, 16, { width: PW / 2, lineBreak: false });

  doc.fontSize(8).font("Helvetica").fillColor(COLOR.blanco)
    .text("NIT 901.149.190-0", ML, 34, { width: PW / 2, lineBreak: false });

  // ? Bloque derecho: tipo doc + número + fecha
  const rightX = ML + PW / 2;
  const rightW = PW / 2;

  doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR.blanco)
    .text("CUENTA DE COBRO", rightX, 16, { width: rightW, align: "right", lineBreak: false });

  const numCuenta = String(cuenta.id || "");
  doc.fontSize(8).font("Helvetica").fillColor(COLOR.blanco)
    .text(`N° ${numCuenta}`, rightX, 30, { width: rightW, align: "right", lineBreak: false });

  const fechaDoc = fmtFecha(cuenta.created_at);
  const ciudadDoc = cuenta.ciudad_cobro || "";
  doc.fontSize(8).fillColor(COLOR.blanco)
    .text(`${fechaDoc}  -  ${ciudadDoc}`, rightX, 44, { width: rightW, align: "right", lineBreak: false });

  // Banda turquesa inferior del header
  fillRect(doc, 0, headerH, PW_TOTAL, 4, COLOR.naranjaSilver);

  let curY = headerH + 18;

  // ============================================================
  // 2. DEBE A ? tarjeta con 2 columnas
  // ============================================================
  curY = sectionTitle(doc, "DEBE A", curY);

  const cardPad = 12;
  const cardH = 88;
  doc.save()
    .roundedRect(ML, curY, PW, cardH, 5)
    .strokeColor(COLOR.grisLinea).lineWidth(0.8).stroke()
    .restore();

  const c1x = ML + cardPad;
  const c2x = ML + PW / 2 + cardPad;
  const rh = 15;
  const colW = PW / 2 - cardPad - 8;
  let ry = curY + 10;

  infoRow(doc, c1x, ry, "Nombre:", cuenta.nombre_usuario || "-");
  infoRow(doc, c2x, ry, "Teléfono:", telefonoConsultor);
  ry += rh;

  infoRow(doc, c1x, ry, "Documento:",
    `${cuenta.tipo_documento || "CC"}: ${cedulaConsultor}`);
  infoRow(doc, c2x, ry, "Banco:", cuenta.banco || "-");
  ry += rh;

  infoRow(doc, c1x, ry, "No. Cuenta:", cuentaBancariaConsultor);
  infoRow(doc, c2x, ry, "Tipo cuenta:", cuenta.tipo_cuenta || "-");
  ry += rh;

  // Dirección en fila propia para evitar solapamiento con textos largos
  infoRow(doc, c1x, ry, "Dirección:", cuenta.direccion || "-", 90, PW - cardPad - 90);

  curY += cardH + 14;

  // ============================================================
  // 3. VALOR A COBRAR
  // ============================================================
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

  // ============================================================
  // 4. CONCEPTO
  // ============================================================
  curY = sectionTitle(doc, "CONCEPTO", curY);

  const periodoInicio = fmtFecha(cuenta.fecha_periodo_inicio);
  const periodoFin = fmtFecha(cuenta.fecha_periodo_fin);

  doc.fontSize(8.5).font("Helvetica").fillColor(COLOR.textoSec)
    .text(
      `Honorarios de Consultoría - ${cuenta.descripcion || "Cuenta de cobro"}\n` +
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

  // ============================================================
  // 5. TABLA DE DETALLES
  // ============================================================
  curY = sectionTitle(doc, "DETALLE DE SERVICIOS", curY);

  const cols = [
    { label: "Cliente", key: "cliente", w: 110 },
    { label: "Consultor", key: "consultor_responsable", w: 102 },
    { label: "Tipo", key: "tipo_asignacion", w: 78 },
    { label: "Caso / Req.", key: "nro_caso_int_ext", w: 96 },
    { label: "Cant.", key: "_cant", w: 40, align: "right" },
    { label: "Total", key: "_total", w: 64, align: "right" },
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
      nro_caso_int_ext: buildCaseSummaryText(d),
      _cant: cant,
      _total: formatCuentaCobroCurrency(d.total_cobrar),
    };

    cols.forEach(c => {
      const isNumericCol = c.key === "_cant" || c.key === "_total";
      const fontName = isNumericCol ? "Helvetica-Bold" : "Helvetica";
      const fitted = fitSingleLineText(doc, vals[c.key], c.w - 8, { fontName, fontSize: 8 });
      doc.fontSize(8).font(fontName).fillColor(COLOR.textoPrin)
        .text(fitted, c.x + 4, curY + 4, { width: c.w - 8, align: c.align || "left", lineBreak: false });
    });

    curY += ROW_H;
  });

  // Borde inferior tabla
  hLine(doc, ML, curY, PW, COLOR.azulOscuro, 1);

  //Fila TOTAL
  curY += 1;
  const totalRowH = 18;
  fillRect(doc, ML, curY, PW, totalRowH, "#E8ECF4");

  // Etiqueta "TOTAL" ? ocupa todo el ancho menos la última columna
  doc.fontSize(8.5).font("Helvetica-Bold").fillColor(COLOR.azulOscuro)
    .text("TOTAL", ML + 4, curY + 5,
      { width: cols[cols.length - 1].x - ML - 8, align: "right", lineBreak: false });

  // Valor ? moneda + número como un solo string en la última columna
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

  // ============================================================
  // 6. PIE + FIRMA
  // ============================================================
  if (curY > doc.page.height - 120) {
    doc.addPage();
    curY = MARGIN.top;
  }

  hLine(doc, ML, curY, PW);
  curY += 10;

  doc.fontSize(7.5).font("Helvetica").fillColor(COLOR.textoSec)
    .text(
      "Documento generado electrónicamente - Silver Consulting S.A.S.  -  NIT 901.149.190-0  -  Medellín, Colombia",
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

const isAsociadoUser = (req) => normalizeValue(req?.user?.tipo_consultor) === "asociado";

/* ===============================
   SERVIR ARCHIVOS DEL FRONTEND
=============================== */
// Ajusta esta ruta si tu carpeta 'front' está en otro nivel relativo
// Frontend se sirve por separado (no está en este contenedor)

/* ===============================
   RUTAS DE VISTAS (SPA)
=============================== */
// (sin rutas de vistas aquí)

/* ===============================
   API - CLIENTES (AQUÍ ESTABA EL FALTANTE)
=============================== */

// ====Firma de contratos: rutas admin ============================================================
const TALENTO_HUMANO_ROL = "Talento Humano";

function buildContratoEmailHtml({ nombre, token, link }) {
  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr><td style="background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:32px 40px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">Silver Consulting</h1>
          <p style="color:#bfdbfe;margin:8px 0 0;font-size:14px;">Proceso de contratación</p>
        </td></tr>
        <tr><td style="padding:36px 40px;">
          <p style="font-size:16px;color:#1e293b;margin:0 0 12px;">Hola <strong>${nombre}</strong>,</p>
          <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 24px;">
            Has sido seleccionado para iniciar tu proceso de contratación con Silver Consulting.
            A continuación encontrarás tu código de acceso y el enlace para revisar y firmar tus documentos.
          </p>
          <div style="background:#f1f5f9;border-radius:10px;padding:20px 24px;text-align:center;margin:0 0 24px;">
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;">Tu código de acceso</p>
            <p style="font-size:28px;font-weight:800;color:#1e3a5f;letter-spacing:4px;margin:0;font-family:monospace;">${token.toUpperCase()}</p>
          </div>
          <p style="font-size:13px;color:#64748b;margin:0 0 20px;text-align:center;">
            Este código expira en <strong>${CONTRATOS_TOKEN_EXPIRY_HOURS} horas</strong>.
          </p>
          <div style="text-align:center;margin:0 0 28px;">
            <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:.02em;">
              Revisar y firmar documentos ?
            </a>
          </div>
          <p style="font-size:12px;color:#94a3b8;text-align:center;margin:0;">
            Si no esperabas este correo, puedes ignorarlo. El enlace no realiza ninguna acción hasta que ingreses tu código.
          </p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:16px 40px;text-align:center;border-top:1px solid #e2e8f0;">
          <p style="font-size:11px;color:#94a3b8;margin:0;">Silver Consulting ? Este correo fue generado automáticamente.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function parseSimpleEmailList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueEmailList(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .flatMap((value) => parseSimpleEmailList(value))
        .map((email) => String(email || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

async function getActiveUserEmailsByRole(roleTitle) {
  const role = String(roleTitle || "").trim();
  if (!role) return [];
  try {
    const result = await pool.query(
      `
      SELECT DISTINCT LOWER(BTRIM(u.email)) AS email
      FROM usuarios u
      JOIN roles r ON r.id = u.rol_usuario_id
      WHERE u.activo = true
        AND NULLIF(BTRIM(u.email), '') IS NOT NULL
        AND LOWER(r.titulo) = LOWER($1)
      ORDER BY LOWER(BTRIM(u.email)) ASC
      `,
      [role]
    );
    return uniqueEmailList(result.rows.map((row) => row.email));
  } catch (err) {
    console.error(`No se pudieron resolver destinatarios por rol "${role}":`, err?.message || err);
    return [];
  }
}

async function resolveTalentoHumanoNotificationRecipients({ fallback = "", extras = "" } = {}) {
  const roleRecipients = await getActiveUserEmailsByRole(TALENTO_HUMANO_ROL);
  const baseRecipients = roleRecipients.length ? roleRecipients : uniqueEmailList(fallback);
  return uniqueEmailList([...baseRecipients, ...uniqueEmailList(extras)]);
}

function escapeHtmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function deriveOneDriveFolderUrlFromFileUrl(fileUrl) {
  const raw = String(fileUrl || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length > 1) {
      segments.pop();
      parsed.pathname = `/${segments.join("/")}`;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return "";
  }
}

function buildContratoFirmaCompletadaEmail({ proceso, docs = [] }) {
  const nombre = String(proceso?.nombre_persona || "Sin nombre").trim();
  const correo = String(proceso?.correo_personal || "").trim();
  const tokenPublicId = String(proceso?.public_id || "").trim();
  const solicitudPublicId = String(proceso?.solicitud_public_id || "").trim();
  const preregistroPublicId = String(proceso?.preregistro_public_id || "").trim();
  const links = Array.isArray(docs) ? docs : [];
  const carpetaOneDrive =
    String(links.find((doc) => String(doc?.carpeta_url || "").trim())?.carpeta_url || "").trim() ||
    deriveOneDriveFolderUrlFromFileUrl(String(links.find((doc) => String(doc?.url || "").trim())?.url || "").trim()) ||
    "";

  const metaLines = [
    `Persona: ${nombre || "Sin nombre"}`,
    correo ? `Correo personal: ${correo}` : null,
    tokenPublicId ? `Proceso de firma: ${tokenPublicId}` : null,
    solicitudPublicId ? `Solicitud de contratacion: ${solicitudPublicId}` : null,
    preregistroPublicId ? `Preregistro: ${preregistroPublicId}` : null,
    carpetaOneDrive ? `Carpeta OneDrive: ${carpetaOneDrive}` : null
  ].filter(Boolean);

  const docLines = links.map((doc) => `- ${doc.titulo}: ${doc.url}`);
  const text = [
    `El contrato de ${nombre || "la persona"} ya fue firmado y los documentos quedaron disponibles en OneDrive.`,
    "",
    ...metaLines,
    "",
    "Documentos firmados:",
    ...docLines
  ].join("\n");

  const metaHtml = metaLines.map((line) => `<li style="margin:0 0 8px;">${escapeHtmlText(line)}</li>`).join("");
  const docsHtml = links
    .map((doc) => `
      <li style="margin:0 0 10px;">
        <strong>${escapeHtmlText(doc.titulo)}</strong><br>
        <a href="${escapeHtmlText(doc.url)}" style="color:#2563eb;text-decoration:none;">${escapeHtmlText(doc.url)}</a>
      </li>
    `)
    .join("");

  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f4f6fa;font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
    <tr>
      <td style="padding:28px 32px;background:#0f766e;color:#ffffff;">
        <h1 style="margin:0;font-size:22px;">Contrato firmado</h1>
        <p style="margin:8px 0 0;font-size:14px;color:#ccfbf1;">Los documentos ya quedaron disponibles para revision interna.</p>
      </td>
    </tr>
    <tr>
      <td style="padding:28px 32px;">
        <p style="margin:0 0 18px;font-size:15px;">
          El contrato de <strong>${escapeHtmlText(nombre || "la persona")}</strong> ya fue firmado y los documentos quedaron almacenados en OneDrive.
        </p>
        <p style="margin:0 0 10px;font-size:13px;color:#475569;font-weight:700;">Datos del proceso</p>
        <ul style="margin:0 0 22px 18px;padding:0;font-size:14px;color:#334155;">
          ${metaHtml}
        </ul>
        ${carpetaOneDrive
      ? `<p style="margin:0 0 14px;font-size:14px;">
              <strong>Carpeta de OneDrive:</strong><br>
              <a href="${escapeHtmlText(carpetaOneDrive)}" style="color:#2563eb;text-decoration:none;">${escapeHtmlText(carpetaOneDrive)}</a>
            </p>`
      : ""}
        <p style="margin:0 0 10px;font-size:13px;color:#475569;font-weight:700;">Documentos firmados</p>
        <ul style="margin:0 0 8px 18px;padding:0;font-size:14px;color:#334155;">
          ${docsHtml}
        </ul>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: `Contrato firmado - ${nombre || "Sin nombre"}`,
    text,
    html
  };
}

async function notifyContratoFirmaCompletada(tokenId) {
  const recipients = await resolveTalentoHumanoNotificationRecipients({
    fallback: CONTRATOS_FIRMA_COMPLETADA_FALLBACK_NOTIFY,
    extras: CONTRATOS_FIRMA_COMPLETADA_NOTIFY_TO
  });
  if (!tokenId || recipients.length === 0) {
    return { ok: false, skipped: "config_missing" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
      SELECT
        t.id,
        t.public_id,
        t.nombre_persona,
        t.correo_personal,
        t.estado,
        t.docs_firma,
        t.firma_completada_notificada_at,
        sc.public_id AS solicitud_public_id,
        pp.public_id AS preregistro_public_id
      FROM tokens_firma_contrato t
      LEFT JOIN solicitudes_contratacion sc ON sc.id = t.solicitud_id
      LEFT JOIN preregistro_personas pp ON pp.id = t.preregistro_id
      WHERE t.id = $1
      FOR UPDATE
      `,
      [tokenId]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, skipped: "not_found" };
    }

    const proceso = result.rows[0];
    if (proceso.estado !== "completado") {
      await client.query("ROLLBACK");
      return { ok: false, skipped: "not_completed" };
    }
    if (proceso.firma_completada_notificada_at) {
      await client.query("ROLLBACK");
      return { ok: true, skipped: "already_notified" };
    }

    const docs = normalizeDocsFirmaListCompat(proceso.docs_firma)
      .filter((doc) => normalizeDocStatus(doc?.estado) === "signed")
      .map((doc) => ({
        doc_index: Number(doc?.doc_index || 0) || null,
        titulo: String(doc?.titulo || doc?.doc_key || `Documento ${doc?.doc_index || ""}`).trim() || "Documento firmado",
        url: String(doc?.onedrive_url || "").trim(),
        carpeta: String(doc?.onedrive_carpeta || "").trim(),
        carpeta_url:
          String(doc?.onedrive_carpeta_url || "").trim() ||
          deriveOneDriveFolderUrlFromFileUrl(String(doc?.onedrive_url || "").trim())
      }));

    if (!docs.length) {
      await client.query("ROLLBACK");
      return { ok: false, skipped: "no_signed_docs" };
    }
    if (docs.some((doc) => !doc.url)) {
      await client.query("ROLLBACK");
      return { ok: false, skipped: "pending_onedrive_upload" };
    }

    const mail = buildContratoFirmaCompletadaEmail({ proceso, docs });
    const sendResult = await sendEmailSafe({
      graphUserEmail: CONTRATOS_FIRMA_COMPLETADA_SENDER || ONEDRIVE_TARGET_USER,
      to: recipients,
      subject: mail.subject,
      text: mail.text,
      html: mail.html
    });
    if (!sendResult.ok) {
      await client.query("ROLLBACK");
      return { ok: false, skipped: "send_failed", error: sendResult.error || null };
    }

    await client.query(
      `
      UPDATE tokens_firma_contrato
      SET firma_completada_notificada_at = NOW(),
          firma_completada_notificada_a = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [tokenId, recipients.join(", ")]
    );
    await client.query("COMMIT");
    return { ok: true, notified_to: recipients };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch { }
    throw err;
  } finally {
    client.release();
  }
}

app.get("/admin/firma-contratos", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        t.public_id        AS id,
        t.nombre_persona,
        t.correo_personal,
        t.estado,
        t.checks_completados,
        t.docs_firma,
        t.expires_at,
        t.created_at,
        sc.public_id       AS solicitud_public_id,
        sc.perfil          AS solicitud_perfil,
        pp.public_id       AS preregistro_public_id,
        u.nombre_usuario   AS generado_por_nombre
      FROM tokens_firma_contrato t
        LEFT JOIN solicitudes_contratacion sc ON sc.id = t.solicitud_id
        LEFT JOIN preregistro_personas pp ON pp.id = t.preregistro_id
        LEFT JOIN usuarios u ON u.id = t.generado_por
      ORDER BY t.created_at DESC
    `);
    const checksRequeridos = Array.isArray(CLAVES_REQUERIDAS_FIRMA) && CLAVES_REQUERIDAS_FIRMA.length
      ? [...CLAVES_REQUERIDAS_FIRMA]
      : ["pdf1", "pdf2", "pdf3", "pdf4", "pdf5"];
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.json(result.rows.map((row) => ({
      ...row,
      checks_requeridos: checksRequeridos
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tokens de firma" });
  }
});

// Resuelve la solicitud o preregistro más reciente para una persona identificada por numero_documento o correo.
// Prioriza solicitudes tipo 'Nuevo' sobre preregistros.
async function resolveProcesoForPersona(pgClient, { numero_documento, correo_personal }) {
  const numDoc = toNullableTrimmedString(numero_documento);
  const correo = toNullableTrimmedString(correo_personal)?.toLowerCase() || null;
  if (!numDoc && !correo) return { solicitud_id: null, preregistro_id: null };

  const conditions = [];
  const params = [];
  if (numDoc) {
    params.push(numDoc);
    conditions.push(`NULLIF(BTRIM(numero_documento),'') = $${params.length}`);
  }
  if (correo) {
    params.push(correo);
    conditions.push(`LOWER(NULLIF(BTRIM(correo_personal),'')) = $${params.length}`);
  }
  const where = conditions.join(" OR ");

  const solR = await pgClient.query(
    `SELECT id FROM solicitudes_contratacion
     WHERE tipo_solicitud = 'Nuevo'
       AND estado IN ('Completado', 'Pendiente Revision TH', 'Pendiente Correo Silver')
       AND (${where})
     ORDER BY updated_at DESC LIMIT 1`,
    params
  );
  if (solR.rows[0]) return { solicitud_id: solR.rows[0].id, preregistro_id: null };

  const preR = await pgClient.query(
    `SELECT id FROM preregistro_personas
     WHERE estado IN ('Completado', 'Pendiente Revision TH', 'Pendiente Correo Silver')
       AND (${where})
     ORDER BY updated_at DESC LIMIT 1`,
    params
  );
  return { solicitud_id: null, preregistro_id: preR.rows[0]?.id || null };
}

app.get("/admin/firma-contratos/candidatos", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  try {
    // Personas registradas en tabla personas
    const personasQuery = pool.query(`
      SELECT
        COALESCE(NULLIF(BTRIM(p.numero_documento), ''), LOWER(NULLIF(BTRIM(p.correo_electronico), ''))) AS persona_key,
        CONCAT_WS(' ', NULLIF(BTRIM(p.nombre), ''), NULLIF(BTRIM(p.apellidos), '')) AS nombre_completo,
        p.correo_electronico AS correo_personal,
        p.numero_documento,
        p.factura_en_colombia,
        'persona' AS origen,
        p.created_at,
        EXISTS (
          SELECT 1 FROM tokens_firma_contrato tf
          WHERE tf.estado IN ('pendiente','en_proceso')
            AND (
              EXISTS (SELECT 1 FROM solicitudes_contratacion sc WHERE sc.id = tf.solicitud_id AND NULLIF(BTRIM(sc.numero_documento),'') = NULLIF(BTRIM(p.numero_documento),''))
              OR EXISTS (SELECT 1 FROM preregistro_personas pp WHERE pp.id = tf.preregistro_id AND NULLIF(BTRIM(pp.numero_documento),'') = NULLIF(BTRIM(p.numero_documento),''))
            )
        ) AS tiene_proceso_activo
      FROM personas p
      WHERE p.correo_electronico IS NOT NULL AND BTRIM(p.correo_electronico) <> ''
      ORDER BY p.created_at DESC
      LIMIT 200
    `);

    // Personas en vuelo: solicitudes o preregistros pendientes sin fila en personas aún
    const evQuery = pool.query(`
      SELECT
        COALESCE(NULLIF(BTRIM(x.numero_documento),''), LOWER(NULLIF(BTRIM(x.correo_personal),''))) AS persona_key,
        x.nombre_completo,
        x.correo_personal,
        x.numero_documento,
        NULL::boolean AS factura_en_colombia,
        'en_vuelo' AS origen,
        x.created_at,
        EXISTS (
          SELECT 1 FROM tokens_firma_contrato tf
          WHERE tf.estado IN ('pendiente','en_proceso')
            AND (
              EXISTS (SELECT 1 FROM solicitudes_contratacion sc WHERE sc.id = tf.solicitud_id AND NULLIF(BTRIM(sc.numero_documento),'') = NULLIF(BTRIM(x.numero_documento),''))
              OR EXISTS (SELECT 1 FROM preregistro_personas pp WHERE pp.id = tf.preregistro_id AND NULLIF(BTRIM(pp.numero_documento),'') = NULLIF(BTRIM(x.numero_documento),''))
            )
        ) AS tiene_proceso_activo
      FROM (
        SELECT
          BTRIM(sc.numero_documento) AS numero_documento,
          BTRIM(sc.correo_personal)  AS correo_personal,
          CONCAT_WS(' ', NULLIF(BTRIM(sc.nombre),''), NULLIF(BTRIM(sc.apellidos),'')) AS nombre_completo,
          MAX(sc.created_at) AS created_at
        FROM solicitudes_contratacion sc
        WHERE sc.tipo_solicitud = 'Nuevo'
          AND sc.estado IN ('Pendiente Revision TH', 'Pendiente Correo Silver')
          AND sc.correo_personal IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM personas p
            WHERE NULLIF(BTRIM(p.numero_documento),'') = NULLIF(BTRIM(sc.numero_documento),'')
              OR LOWER(NULLIF(BTRIM(p.correo_electronico),'')) = LOWER(NULLIF(BTRIM(sc.correo_personal),''))
          )
        GROUP BY BTRIM(sc.numero_documento), BTRIM(sc.correo_personal),
                 CONCAT_WS(' ', NULLIF(BTRIM(sc.nombre),''), NULLIF(BTRIM(sc.apellidos),''))
        UNION ALL
        SELECT
          BTRIM(pp.numero_documento) AS numero_documento,
          BTRIM(pp.correo_personal)  AS correo_personal,
          CONCAT_WS(' ', NULLIF(BTRIM(pp.nombre),''), NULLIF(BTRIM(pp.apellidos),'')) AS nombre_completo,
          MAX(pp.created_at) AS created_at
        FROM preregistro_personas pp
        WHERE pp.estado IN ('Pendiente Revision TH', 'Pendiente Correo Silver')
          AND pp.correo_personal IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM personas p
            WHERE NULLIF(BTRIM(p.numero_documento),'') = NULLIF(BTRIM(pp.numero_documento),'')
              OR LOWER(NULLIF(BTRIM(p.correo_electronico),'')) = LOWER(NULLIF(BTRIM(pp.correo_personal),''))
          )
        GROUP BY BTRIM(pp.numero_documento), BTRIM(pp.correo_personal),
                 CONCAT_WS(' ', NULLIF(BTRIM(pp.nombre),''), NULLIF(BTRIM(pp.apellidos),''))
      ) x
      ORDER BY x.created_at DESC
      LIMIT 200
    `);

    const [personasRes, evRes] = await Promise.all([personasQuery, evQuery]);

    const seen = new Map();
    for (const row of personasRes.rows) seen.set(row.persona_key, row);
    for (const row of evRes.rows) {
      if (!seen.has(row.persona_key)) seen.set(row.persona_key, row);
    }

    const candidatos = [...seen.values()]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 200);

    res.json({ candidatos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener candidatos" });
  }
});

app.post("/admin/firma-contratos/generar", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  const { solicitud_id, preregistro_id, nombre_persona, correo_personal, numero_documento } = req.body || {};

  if (!solicitud_id && !preregistro_id && !numero_documento && !correo_personal) {
    return res.status(400).json({ error: "Debes indicar numero_documento, correo_personal, solicitud_id o preregistro_id" });
  }

  try {
    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + CONTRATOS_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

    let solId = null;
    let preId = null;

    if (solicitud_id) {
      const r = await pool.query("SELECT id FROM solicitudes_contratacion WHERE public_id = $1", [solicitud_id]);
      if (r.rowCount === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
      solId = r.rows[0].id;
    } else if (preregistro_id) {
      const r = await pool.query("SELECT id FROM preregistro_personas WHERE public_id = $1", [preregistro_id]);
      if (r.rowCount === 0) return res.status(404).json({ error: "Preregistro no encontrado" });
      preId = r.rows[0].id;
    } else {
      // Auto-resolver por numero_documento o correo_personal
      const resolved = await resolveProcesoForPersona(pool, {
        numero_documento: toNullableTrimmedString(numero_documento),
        correo_personal: toNullableTrimmedString(correo_personal)
      });
      solId = resolved.solicitud_id;
      preId = resolved.preregistro_id;
    }

    const procesoContext = {
      solicitud_id: solId,
      preregistro_id: preId,
      nombre_persona: nombre_persona || "",
      correo_personal: correo_personal || ""
    };
    const personaContext = await resolveContratoPersonaContext(procesoContext);
    const nombreIngresado = toNullableTrimmedString(nombre_persona);
    const correoIngresado = toNullableTrimmedString(correo_personal);
    const nombreFinal =
      nombreIngresado ||
      toNullableTrimmedString(personaContext?.nombreCompleto) ||
      "";
    const correoFinal =
      correoIngresado ||
      toNullableTrimmedString(personaContext?.correoPersonal) ||
      "";
    if (!nombreFinal || !correoFinal) {
      return res.status(400).json({ error: "No se pudo resolver nombre_persona o correo_personal del proceso" });
    }

    // Expirar todos los tokens activos de la persona (por numero_documento)
    const numDocFinal = toNullableTrimmedString(personaContext?.numeroDocumento) || toNullableTrimmedString(numero_documento);
    if (numDocFinal) {
      await pool.query(
        `UPDATE tokens_firma_contrato tf SET estado = 'expirado', updated_at = NOW()
         WHERE tf.estado IN ('pendiente', 'en_proceso')
           AND (
             EXISTS (SELECT 1 FROM solicitudes_contratacion sc WHERE sc.id = tf.solicitud_id AND NULLIF(BTRIM(sc.numero_documento),'') = $1)
             OR EXISTS (SELECT 1 FROM preregistro_personas pp WHERE pp.id = tf.preregistro_id AND NULLIF(BTRIM(pp.numero_documento),'') = $1)
           )`,
        [numDocFinal]
      );
    } else {
      if (solId) {
        await pool.query(
          "UPDATE tokens_firma_contrato SET estado = 'expirado', updated_at = NOW() WHERE solicitud_id = $1 AND estado IN ('pendiente', 'en_proceso')",
          [solId]
        );
      }
      if (preId) {
        await pool.query(
          "UPDATE tokens_firma_contrato SET estado = 'expirado', updated_at = NOW() WHERE preregistro_id = $1 AND estado IN ('pendiente', 'en_proceso')",
          [preId]
        );
      }
    }

    const hasBaseContract = await hasContratoBaseFirmado({
      correoPersonal: toNullableTrimmedString(personaContext?.correoPersonal) || correoFinal,
      numeroDocumento: personaContext?.numeroDocumento || null
    });
    const docsPlan = buildDocsFirmaPlan({
      hasContratoBase: hasBaseContract,
      facturaEnColombia: personaContext?.facturaEnColombia ?? null
    });
    if (docsPlan.some((doc) => doc?.doc_key === "anexo_tecnico")) {
      await requirePersistedAnexoFromProceso(procesoContext, personaContext);
    }

    const insert = await pool.query(
      `INSERT INTO tokens_firma_contrato
        (token, solicitud_id, preregistro_id, nombre_persona, correo_personal, docs_firma, generado_por, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING public_id AS id, token, expires_at, docs_firma`,
      [token, solId, preId, nombreFinal, correoFinal, JSON.stringify(docsPlan), req.user.id, expiresAt]
    );

    const row = insert.rows[0];

    const baseUrl = CONTRATOS_BASE_URL || "https://icy-ground-03832ec1e.1.azurestaticapps.net";
    const link = `${baseUrl}/contratacion.html?t=${token}`;

    const sendResult = await sendEmailSafe({
      ...getGraphContext(req),
      to: correoFinal,
      subject: "Proceso de contratación - Silver Consulting",
      html: buildContratoEmailHtml({ nombre: nombreFinal, token, link })
    });
    if (!sendResult?.ok) {
      await pool.query("DELETE FROM tokens_firma_contrato WHERE token = $1", [token]).catch((cleanupErr) => {
        console.error("No se pudo limpiar token de firma tras fallo de correo:", cleanupErr?.message || cleanupErr);
      });
      const sendErr = new Error(sendResult?.error || "No fue posible enviar el correo");
      sendErr.status = 502;
      throw sendErr;
    }

    res.status(201).json({
      id: row.id,
      token,
      expires_at: row.expires_at,
      docs_firma: normalizeDocsFirmaListCompat(row.docs_firma),
      paquete_documentos: hasBaseContract ? "anexo_tecnico" : "completo",
      link,
      correo_destino: correoFinal,
      correo_enviado: true
    });
  } catch (err) {
    console.error(err);
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || "No fue posible generar el token de firma" });
    }
    res.status(500).json({ error: "Error generando token de firma" });
  }
});

app.get("/admin/firma-contratos/anexo-items", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  try {
    const solicitudInput = req.query?.solicitud_id || null;
    const preregistroInput = req.query?.preregistro_id || null;
    let numeroDocumento = toNullableTrimmedString(req.query?.numero_documento);
    let correoPersonal = toNullableTrimmedString(req.query?.correo_personal);

    let solicitudId = null;
    let preregistroId = null;
    if (solicitudInput) {
      solicitudId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.solicitudesContratacion, solicitudInput);
      if (!solicitudId) return res.status(404).json({ error: "Solicitud no encontrada" });
    }
    if (preregistroInput) {
      preregistroId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.preregistroPersonas, preregistroInput);
      if (!preregistroId) return res.status(404).json({ error: "Preregistro no encontrado" });
    }

    if (!solicitudId && !preregistroId && !numeroDocumento && !correoPersonal) {
      return res.status(400).json({ error: "Debes indicar solicitud_id, preregistro_id, numero_documento o correo_personal" });
    }

    // Cuando hay IDs de proceso (solicitud/preregistro), NO se resuelven ni agregan
    // numero_documento ni correo_personal: hacerlo causaria que listAnexoTecnicoItems
    // devuelva filas de otras recontrataciones del mismo colaborador via OR.
    // Los identificadores personales solo se usan como fallback cuando no hay IDs.
    const rows = await listAnexoTecnicoItems({
      solicitudId,
      preregistroId,
      numeroDocumento: (!solicitudId && !preregistroId) ? numeroDocumento : null,
      correoPersonal: (!solicitudId && !preregistroId && !numeroDocumento) ? correoPersonal : null
    });
    res.json(rows.map(toAnexoApiRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo items de anexo tecnico" });
  }
});

app.post("/admin/firma-contratos/anexo-items", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  const payload = req.body || {};
  try {
    const solicitudInput = payload.solicitud_id || null;
    const preregistroInput = payload.preregistro_id || null;
    if (!solicitudInput && !preregistroInput) {
      return res.status(400).json({ error: "Debes indicar solicitud_id o preregistro_id" });
    }

    let solicitudId = null;
    let preregistroId = null;
    if (solicitudInput) {
      solicitudId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.solicitudesContratacion, solicitudInput);
      if (!solicitudId) return res.status(404).json({ error: "Solicitud no encontrada" });
    }
    if (preregistroInput) {
      preregistroId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.preregistroPersonas, preregistroInput);
      if (!preregistroId) return res.status(404).json({ error: "Preregistro no encontrado" });
    }

    const personaContext = await resolveContratoPersonaContext({
      solicitud_id: solicitudId,
      preregistro_id: preregistroId,
      nombre_persona: payload.nombre_persona || "",
      correo_personal: payload.correo_personal || ""
    });

    const clienteInput = payload.cliente_id || null;
    let clienteId = null;
    let clienteNombre = toNullableTrimmedString(payload.cliente_nombre) || personaContext?.clienteNombre || "";
    if (clienteInput) {
      clienteId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.clientes, clienteInput);
      if (!clienteId) return res.status(404).json({ error: "Cliente no encontrado" });
      const c = await pool.query("SELECT titulo FROM clientes WHERE id = $1 LIMIT 1", [clienteId]);
      clienteNombre = c.rows[0]?.titulo || clienteNombre || "";
    } else if (personaContext?.clienteId) {
      clienteId = personaContext.clienteId;
      if (!clienteNombre) clienteNombre = personaContext?.clienteNombre || "";
    }

    const insertPayload = buildAnexoInsertPayload({
      input: payload,
      personaContext,
      solicitudId,
      preregistroId,
      clienteId,
      clienteNombre,
      creadoPor: req.user.id,
      origen: "manual"
    });

    const insert = await insertAnexoTecnicoItem(insertPayload);
    const row = await getAnexoTecnicoItemByInternalId(insert.row?.id);
    const statusCode = insert.duplicated ? 200 : 201;
    return res.status(statusCode).json({
      duplicated: insert.duplicated,
      item: toAnexoApiRow(row)
    });
  } catch (err) {
    const statusCode = Number(err?.status || 500);
    if (statusCode >= 400 && statusCode < 500) {
      return res.status(statusCode).json({ error: err.message || "Datos inválidos para anexo tecnico" });
    }
    console.error(err);
    return res.status(500).json({ error: "Error creando item de anexo tecnico" });
  }
});

app.delete("/admin/firma-contratos/:id", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE tokens_firma_contrato SET estado = 'expirado', updated_at = NOW() WHERE public_id = $1 RETURNING id",
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Token no encontrado" });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error anulando token" });
  }
});

app.get("/th/anexo-individual/search", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  try {
    const q = String(req.query?.q || "").trim();
    const like = `%${q}%`;
    const result = await pool.query(
      `
      SELECT
        u.public_id AS id,
        u.nombre_usuario AS nombre,
        u.email,
        COALESCE(p.numero_documento, u.cedula) AS cedula,
        u.tipo_consultor,
        EXISTS (
          SELECT 1
          FROM anexo_tecnico_items ati
          WHERE ati.estado = 'activo'
            AND (
              ati.usuario_id = u.id
              OR (
                COALESCE(p.numero_documento, u.cedula) IS NOT NULL
                AND ati.usuario_id IS NULL
                AND ati.numero_documento = COALESCE(p.numero_documento, u.cedula)
              )
            )
        ) AS tiene_items_activos,
        EXISTS (
          SELECT 1
          FROM tokens_firma_anexo_individual t
          WHERE t.usuario_id = u.id
            AND t.estado = 'enviado'
        ) AS envio_pendiente
      FROM usuarios u
      LEFT JOIN personas p ON u.persona_id = p.id
      WHERE u.activo = true
        AND LOWER(COALESCE(u.email, '')) LIKE '%@silverconsulting.com.co'
        AND (
          $1 = ''
          OR u.nombre_usuario ILIKE $2
          OR u.email ILIKE $2
          OR COALESCE(p.numero_documento, u.cedula, '') ILIKE $2
        )
      ORDER BY
        CASE WHEN u.nombre_usuario ILIKE $2 THEN 0 ELSE 1 END,
        u.nombre_usuario ASC
      LIMIT 20
      `,
      [q, like]
    );
    res.json(result.rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error buscando usuarios para anexo tecnico" });
  }
});

app.get("/th/anexo-individual/usuarios/:usuarioId/items", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  try {
    const userRow = await getUsuarioAnexoIndividualById(req.params.usuarioId);
    if (!userRow) return res.status(404).json({ error: "Usuario no encontrado" });
    const payload = await buildAnexoIndividualDashboardPayload(userRow, {
      includeFinalizados: String(req.query?.incluir_finalizados || "").toLowerCase() === "true"
    });
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo items del anexo tecnico" });
  }
});

app.get("/th/anexo-individual/items/:itemId", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  try {
    const item = await getAnexoIndividualItemByInput(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Item no encontrado" });
    res.json(toAnexoApiRow(item));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo item del anexo tecnico" });
  }
});

app.post("/th/anexo-individual/items", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  try {
    const userRow = await getUsuarioAnexoIndividualById(req.body?.usuario_id);
    if (!userRow) return res.status(404).json({ error: "Usuario no encontrado" });

    // Resolver solicitante opcional pasado por TH (public_id del coordinador/comercial)
    let solicitanteInternalId = null;
    let rolSolicitante = null;
    if (req.body?.solicitante_id) {
      const solRes = await pool.query(
        `SELECT u.id, r.titulo AS rol FROM usuarios u JOIN roles r ON r.id = u.rol_usuario_id WHERE u.public_id::text = $1::text LIMIT 1`,
        [req.body.solicitante_id]
      );
      if (solRes.rows[0]) {
        solicitanteInternalId = solRes.rows[0].id;
        rolSolicitante = solRes.rows[0].rol || null;
      }
    }

    const payload = await buildAnexoIndividualItemPayload({
      input: req.body || {},
      userRow,
      existingRow: null,
      actorUserId: req.user?.id || null
    });

    const insert = await pool.query(
      `
      INSERT INTO anexo_tecnico_items (
        solicitud_contratacion_id,
        preregistro_id,
        usuario_id,
        nombre_persona,
        numero_documento,
        correo_personal,
        tipo_asignacion,
        cliente_id,
        cliente_nombre,
        modulo_id,
        moneda,
        valor_tarifa,
        fecha_inicio,
        fecha_fin,
        fecha_fin_calculada,
        origen,
        estado,
        estado_firma,
        creado_por,
        updated_by,
        solicitante_id,
        rol_solicitante
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22
      )
      RETURNING id
      `,
      [
        payload.solicitud_contratacion_id,
        payload.preregistro_id,
        payload.usuario_id,
        payload.nombre_persona,
        payload.numero_documento,
        payload.correo_personal,
        payload.tipo_asignacion,
        payload.cliente_id,
        payload.cliente_nombre,
        payload.modulo_id,
        payload.moneda,
        payload.valor_tarifa,
        payload.fecha_inicio,
        payload.fecha_fin,
        payload.fecha_fin_calculada,
        payload.origen,
        payload.estado,
        "pendiente",
        payload.creado_por,
        null,
        solicitanteInternalId,
        rolSolicitante
      ]
    );

    const row = await getAnexoTecnicoItemByInternalId(insert.rows[0]?.id);
    res.status(201).json({ item: toAnexoApiRow(row) });
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || "Datos invalidos para item de anexo tecnico" });
    }
    if (err?.code === "23514") {
      console.error("CHECK anexo_tecnico_items:", err.message);
      return res.status(400).json({
        error:
          "Los datos no cumplen las reglas del anexo en base de datos. Si acabas de habilitar anexo individual, aplica la migracion 2026-03-25-anexo-individual-check-usuario.sql."
      });
    }
    console.error(err);
    res.status(500).json({ error: "Error creando item de anexo tecnico" });
  }
});

app.patch("/th/anexo-individual/items/:itemId", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  try {
    const existingRow = await getAnexoIndividualItemByInput(req.params.itemId);
    if (!existingRow) return res.status(404).json({ error: "Item no encontrado" });
    if (existingRow.estado !== "activo") {
      return res.status(409).json({ error: "Solo se pueden editar items activos" });
    }

    const userRow = await getUsuarioAnexoIndividualById(
      req.body?.usuario_id || existingRow.usuario_public_id || existingRow.usuario_id
    );
    if (!userRow) return res.status(404).json({ error: "Usuario no encontrado" });

    const payload = await buildAnexoIndividualItemPayload({
      input: req.body || {},
      userRow,
      existingRow,
      actorUserId: req.user?.id || null
    });

    await pool.query(
      `
      UPDATE anexo_tecnico_items
      SET
        usuario_id = $1,
        nombre_persona = $2,
        numero_documento = $3,
        correo_personal = $4,
        tipo_asignacion = $5,
        cliente_id = $6,
        cliente_nombre = $7,
        modulo_id = $8,
        moneda = $9,
        valor_tarifa = $10,
        fecha_inicio = $11,
        fecha_fin = $12,
        fecha_fin_calculada = $13,
        estado_firma = $14,
        updated_by = $15,
        updated_at = NOW()
      WHERE id = $16
      `,
      [
        payload.usuario_id,
        payload.nombre_persona,
        payload.numero_documento,
        payload.correo_personal,
        payload.tipo_asignacion,
        payload.cliente_id,
        payload.cliente_nombre,
        payload.modulo_id,
        payload.moneda,
        payload.valor_tarifa,
        payload.fecha_inicio,
        payload.fecha_fin,
        payload.fecha_fin_calculada,
        payload.estado_firma,
        req.user?.id || null,
        existingRow.id
      ]
    );

    const refreshed = await getAnexoTecnicoItemByInternalId(existingRow.id);
    res.json({ item: toAnexoApiRow(refreshed) });
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || "Datos invalidos para actualizar el item" });
    }
    console.error(err);
    res.status(500).json({ error: "Error actualizando item de anexo tecnico" });
  }
});

app.patch("/th/anexo-individual/items/:itemId/finalizar", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  try {
    const existingRow = await getAnexoIndividualItemByInput(req.params.itemId);
    if (!existingRow) return res.status(404).json({ error: "Item no encontrado" });

    await pool.query(
      `
      UPDATE anexo_tecnico_items
      SET estado = 'finalizado',
          updated_by = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [existingRow.id, req.user?.id || null]
    );

    const refreshed = await getAnexoTecnicoItemByInternalId(existingRow.id);
    res.json({ item: toAnexoApiRow(refreshed) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error finalizando item de anexo tecnico" });
  }
});

app.post("/th/anexo-individual/preview-pdf", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  const correoFirmante = String(req.body?.correo_firmante || "").trim();
  const usuarioInput = req.body?.usuario_id || null;
  if (!usuarioInput) return res.status(400).json({ error: "usuario_id es obligatorio" });
  if (correoFirmante && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoFirmante)) {
    return res.status(400).json({ error: "correo_firmante invalido" });
  }

  try {
    const { userRow, items, correoFirmante: correoFinal } = await collectAnexoIndividualSignatureContext({
      userInput: usuarioInput,
      correoFirmante,
      requestedItemIds: req.body?.item_ids || []
    });
    const generated = await generateAnexoIndividualPdfFromItems({
      userRow,
      items,
      correoFirmante: correoFinal
    });
    const fileName = sanitizeDownloadFileName(
      generated.fileName || "AnexoTecnico.pdf",
      "AnexoTecnico.pdf"
    ).replace(/"/g, "");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(generated.pdfBuffer);
  } catch (err) {
    console.error("Error descargando preview de anexo individual:", err);
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || "No fue posible generar la vista previa" });
    }
    if (isAnexoIndividualInfraError(err)) {
      return res.status(503).json(buildAnexoIndividualInfraErrorPayload());
    }
    const errMessage = String(err?.message || "");
    if (isDocxTemplateFailureMessage(errMessage)) {
      return res.status(422).json({
        error: "No fue posible generar la vista previa porque la plantilla del anexo tecnico tiene marcadores invalidos."
      });
    }
    if (isDocxInfraFailureMessage(errMessage)) {
      return res.status(503).json({
        error: "No fue posible generar el PDF del anexo tecnico.",
        detalle: errMessage || "Sin detalle tecnico"
      });
    }
    return res.status(500).json({ error: "Error generando la vista previa del anexo tecnico" });
  }
});

app.post("/th/anexo-individual/iniciar-firma", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  if (!isClickSignConfigured({ forContratos: true })) {
    return res.status(503).json({ error: "Click&Sign no esta configurado en el servidor" });
  }

  const correoFirmante = String(req.body?.correo_firmante || "").trim();
  const usuarioInput = req.body?.usuario_id || null;
  if (!usuarioInput) return res.status(400).json({ error: "usuario_id es obligatorio" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoFirmante)) {
    return res.status(400).json({ error: "correo_firmante invalido" });
  }

  try {
    const userRow = await getUsuarioAnexoIndividualById(usuarioInput);
    if (!userRow) return res.status(404).json({ error: "Usuario no encontrado" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const activeToken = await client.query(
        `
        SELECT *
        FROM tokens_firma_anexo_individual
        WHERE usuario_id = $1
          AND estado = 'enviado'
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        `,
        [userRow.id]
      );
      if (activeToken.rowCount > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Ya existe un envio pendiente para esta persona",
          token_activo: mapAnexoIndividualTokenRow(activeToken.rows[0])
        });
      }

      const { items, correoFirmante: correoFinal } = await collectAnexoIndividualSignatureContext({
        userInput: userRow.id,
        correoFirmante,
        requestedItemIds: req.body?.item_ids || [],
        client,
        lockRows: true
      });

      const generated = await generateAnexoIndividualPdfFromItems({
        userRow,
        items,
        correoFirmante: correoFinal
      });
      const token = crypto.randomBytes(32).toString("hex");
      const requestId = `ANX-${token.slice(0, 12)}-${Date.now()}`;
      const contractId = `anexo_individual_${String(userRow.public_id || userRow.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}_${Date.now()}`;
      const signatoryExternalId = String(userRow.id || Date.now());
      const clicksignPayload = {
        request: "START_SIGNATURE",
        request_id: requestId,
        user: CLICKSIGN_USER,
        signature: {
          config_id: CLICKSIGN_CONTRATOS_CONFIG_ID,
          contract_id: contractId,
          title: `Anexo Tecnico - ${userRow.nombre_usuario || "Persona"}`,
          level: [
            {
              level_order: 0,
              required_signatories_to_complete_level: 1,
              signatories: [
                {
                  email: correoFinal,
                  name: userRow.nombre_usuario || correoFinal,
                  external_id: signatoryExternalId
                }
              ]
            }
          ],
          file: [
            {
              filename: generated.fileName,
              content: generated.pdfBuffer.toString("base64"),
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
      const signatoryEmailCbUrl = CLICKSIGN_SIGNATORY_EMAIL_CB_URL || signatoryCbUrl;
      if (signatureCbUrl) clicksignPayload.signature.signature_cb_url = signatureCbUrl;
      if (signatoryCbUrl) clicksignPayload.signature.signatory_cb_url = signatoryCbUrl;
      if (signatoryEmailCbUrl) clicksignPayload.signature.signatory_email_cb_url = signatoryEmailCbUrl;

      let clicksignRes = null;
      try {
        clicksignRes = await jsonRequest({
          method: "POST",
          url: buildClickSignUrl("start_signature"),
          headers: buildClickSignAuthHeaders(),
          body: clicksignPayload
        });
      } catch (clickErr) {
        await client.query("ROLLBACK");
        return res.status(502).json({
          error: "Error al iniciar firma en Click&Sign",
          detalle: clickErr?.response || clickErr?.message || "Error desconocido",
          http_status: Number(clickErr?.status || 0) || null
        });
      }

      const clicksignBody = clicksignRes?.data && typeof clicksignRes.data === "object" ? clicksignRes.data : {};
      const urlFirma = getClickSignLandingUrl(clicksignBody);
      const responseRequestId = pickStringByPaths(clicksignBody, [
        "request_id",
        "data.request_id",
        "signature.request_id",
        "request.id",
        "data.request.id",
        "result.request_id",
        "result.request.id"
      ]);
      const resolvedRequestId = responseRequestId || requestId;
      const signatureId = extractClickSignSignatureId(clicksignBody);
      if (!urlFirma) {
        await client.query("ROLLBACK");
        return res.status(502).json({
          error: "Click&Sign no devolvio URL de firma",
          detalle: clicksignBody
        });
      }

      const insertToken = await client.query(
        `
        INSERT INTO tokens_firma_anexo_individual (
          token,
          usuario_id,
          anexo_item_ids,
          correo_firmante,
          nombre_persona,
          estado,
          request_id,
          contract_id,
          signature_id,
          url_firma,
          generado_por
        )
        VALUES (
          $1, $2, $3::int[], $4, $5, 'enviado', $6, $7, $8, $9, $10
        )
        RETURNING *
        `,
        [
          token,
          userRow.id,
          items.map((item) => Number(item.id)).filter(Number.isInteger),
          correoFinal,
          userRow.nombre_usuario || "",
          resolvedRequestId || null,
          contractId,
          signatureId || null,
          urlFirma || null,
          req.user?.id || null
        ]
      );

      await client.query(
        `
        UPDATE anexo_tecnico_items
        SET estado_firma = 'enviado',
            updated_at = NOW()
        WHERE id = ANY($1::int[])
        `,
        [items.map((item) => Number(item.id)).filter(Number.isInteger)]
      );

      await client.query("COMMIT");
      return res.status(200).json({
        ok: true,
        token: mapAnexoIndividualTokenRow(insertToken.rows[0]),
        url_firma: urlFirma || null
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch { }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error iniciando firma de anexo individual:", err);
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || "No fue posible iniciar la firma" });
    }
    if (isAnexoIndividualInfraError(err)) {
      return res.status(503).json(buildAnexoIndividualInfraErrorPayload());
    }
    const errMessage = String(err?.message || "");
    if (isDocxTemplateFailureMessage(errMessage)) {
      return res.status(422).json({
        error: "No fue posible generar el PDF porque la plantilla del anexo tecnico tiene marcadores invalidos."
      });
    }
    if (isDocxInfraFailureMessage(errMessage)) {
      return res.status(503).json({
        error: "No fue posible generar el PDF del anexo tecnico.",
        detalle: errMessage || "Sin detalle tecnico"
      });
    }
    res.status(500).json({ error: "Error iniciando proceso de firma del anexo tecnico" });
  }
});

app.delete("/th/anexo-individual/cancelar-firma/:tokenId", requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] }), async (req, res) => {
  const rawId = String(req.params.tokenId || "").trim();
  if (!rawId) return res.status(400).json({ error: "Token invalido" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let lookup = null;
    if (isGuid(rawId)) {
      lookup = await client.query(
        `
        SELECT *
        FROM tokens_firma_anexo_individual
        WHERE public_id = $1
          AND estado = 'enviado'
        LIMIT 1
        FOR UPDATE
        `,
        [rawId]
      );
    } else {
      lookup = await client.query(
        `
        SELECT *
        FROM tokens_firma_anexo_individual
        WHERE token = $1
          AND estado = 'enviado'
        LIMIT 1
        FOR UPDATE
        `,
        [rawId]
      );
    }

    if (!lookup || lookup.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No existe un envio pendiente con ese identificador" });
    }

    const tokenRow = lookup.rows[0];
    await client.query(
      `
      UPDATE tokens_firma_anexo_individual
      SET estado = 'cancelado',
          cancelado_at = NOW(),
          cancelado_por = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [tokenRow.id, req.user?.id || null]
    );
    await client.query(
      `
      UPDATE anexo_tecnico_items
      SET estado_firma = 'pendiente',
          updated_at = NOW()
      WHERE id = ANY($1::int[])
      `,
      [tokenRow.anexo_item_ids || []]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch { }
    console.error(err);
    res.status(500).json({ error: "Error cancelando el envio de firma" });
  } finally {
    client.release();
  }
});

// Equivalente a: Get-MgSubscribedSku | Select-Object SkuId, SkuPartNumber
app.get("/admin/licencias-disponibles", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  try {
    const token = await getGraphAccessToken();
    const skus = await getSubscribedSkus(token);
    res.json(skus);
  } catch (err) {
    console.error("Error obteniendo SKUs de Entra ID:", err?.message || err);
    const status = parseGraphErrorStatus(err?.message || "");
    if (status === 401 || status === 403) {
      return res.status(502).json({
        error: "Sin permisos para leer licencias en Entra ID. Verifica que la app tenga Organization.Read.All como permiso de aplicación."
      });
    }
    res.status(502).json({ error: "No se pudieron obtener las licencias de Entra ID." });
  }
});

// ====Gestión de Personas ============================================================

function canEditGestionPersonas(req) {
  const role = normalizeValue(req?.user?.rol);
  return role === "administrador" || role === "talento humano";
}

function isValidEmailFormat(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function normalizeTipoPersonaForUsuariosInput(value) {
  const raw = normalizeValue(value);
  if (!raw) return null;
  if (raw === "natural") return "Natural";
  if (raw === "juridica") return "Jurídica";
  return null;
}

function normalizeTipoConsultorInput(value) {
  const raw = normalizeValue(value);
  if (!raw) return null;
  if (raw === "principal") return "Principal";
  if (raw === "asociado") return "Asociado";
  return null;
}

async function resolvePersonaReferenceOrThrow(db, tableName, value, label) {
  if (value === undefined) return { provided: false, id: null };
  if (value === null || String(value).trim() === "") {
    return { provided: true, id: null };
  }

  const resolvedId = await resolveInternalIdFromPublicIdOrId(db, tableName, value);
  if (!resolvedId) {
    const err = new Error(`${label} no válido`);
    err.status = 400;
    throw err;
  }
  return { provided: true, id: resolvedId };
}

function sanitizePersonaForRead(row, req) {
  if (!row) return row;
  if (canEditGestionPersonas(req)) return row;

  const sanitized = { ...row, azure_oid: null };
  delete sanitized.rol_id;
  delete sanitized.banco_id;
  delete sanitized.tipo_cuenta_id;
  delete sanitized.tipo_documento_id;
  delete sanitized.consultor_principal_id;
  return sanitized;
}

// GET /admin/personas-standalone — personas creadas sin usuario del sistema (admin + TH)
app.get("/admin/personas-standalone", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.public_id,
        p.estado,
        p.nombre,
        p.apellidos,
        p.numero_documento    AS cedula,
        p.tipo_persona,
        p.correo_electronico  AS email,
        p.ciudad_residencia   AS ciudad,
        p.numero_contacto     AS telefono,
        p.tipo_contrato,
        p.created_at
      FROM personas p
      WHERE NOT EXISTS (
        SELECT 1 FROM usuarios u WHERE u.persona_id = p.id
      )
      ORDER BY p.nombre ASC NULLS LAST, p.created_at DESC
    `);
    res.json(result.rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar personas standalone" });
  }
});

// GET /admin/personas/p/:personaId — ficha de persona standalone por personas.public_id (admin + TH)
// Solo aplica a personas sin usuario vinculado; si tiene usuario, usar GET /admin/personas/:id.
app.get("/admin/personas/p/:personaId", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const { personaId } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        p.public_id,
        p.estado,
        p.nombre,
        p.apellidos,
        p.numero_documento        AS cedula,
        p.tipo_persona,
        p.factura_en_colombia,
        p.numero_contacto         AS telefono,
        p.correo_electronico,
        p.direccion_residencia    AS direccion,
        p.ciudad_residencia       AS ciudad,
        p.departamento_pais,
        p.titulo_profesional,
        p.sexo,
        p.fecha_nacimiento,
        p.nombre_contacto_emergencia,
        p.telefono_contacto_emergencia,
        p.parentesco,
        p.eps, p.afp, p.arl,
        p.composicion_familiar, p.hijos, p.personas_a_cargo,
        p.tipo_contrato, p.modalidad,
        p.numero_cuenta           AS nro_cuenta_bancaria,
        p.razon_social,
        p.nit_empresa,
        p.representante_legal,
        p.tipo_documento_representante,
        p.numero_documento_representante,
        p.modulo_otro, p.cliente_otro,
        di.public_id  AS tipo_documento_id,
        di.titulo     AS tipo_documento,
        di.codigo     AS tipo_documento_codigo,
        b.public_id   AS banco_id,
        b.titulo      AS banco,
        tc.public_id  AS tipo_cuenta_id,
        tc.titulo     AS tipo_cuenta,
        m.public_id   AS persona_modulo_id,
        m.titulo      AS persona_modulo,
        cl.public_id  AS persona_cliente_id,
        cl.titulo     AS persona_cliente
      FROM personas p
      LEFT JOIN documento_identidad di  ON di.id = p.tipo_documento_id
      LEFT JOIN bancos b                ON b.id  = p.banco_id
      LEFT JOIN tipo_cuenta_bancaria tc ON tc.id = p.tipo_cuenta_id
      LEFT JOIN modulo m                ON m.id  = p.modulo_id
      LEFT JOIN clientes cl             ON cl.id = p.cliente_id
      WHERE p.public_id = $1
        AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.persona_id = p.id)
    `, [personaId]);

    if (result.rowCount === 0) return res.status(404).json({ error: "Persona standalone no encontrada" });
    res.json(sanitizePersonaForRead(result.rows[0], req));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener ficha de persona" });
  }
});

// PUT /admin/personas/p/:personaId/personal — editar datos personales de persona standalone (admin + TH)
app.put("/admin/personas/p/:personaId/personal", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const { personaId } = req.params;
  const {
    tipo_documento_id, cedula, nombre, apellidos,
    telefono, direccion, ciudad, tipo_persona,
    fecha_nacimiento, sexo, departamento_pais, titulo_profesional,
    correo_electronico,
    razon_social, nit_empresa, representante_legal,
    tipo_documento_representante, numero_documento_representante
  } = req.body || {};
  try {
    const tipoDocumentoRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.documentoIdentidad, tipo_documento_id, "Tipo de documento");
    const tipoPersonaNormalizada = tipo_persona ? normalizeTipoPersonaForUsuariosInput(tipo_persona) : null;
    if (tipo_persona && !tipoPersonaNormalizada) {
      return res.status(400).json({ error: "Tipo de persona inválido" });
    }
    const sexoNormalizado = toNullableTrimmedString(sexo);
    if (sexoNormalizado && !["Hombre", "Mujer", "Otro"].includes(sexoNormalizado)) {
      return res.status(400).json({ error: "Sexo inválido. Debe ser Hombre, Mujer u Otro" });
    }

    const result = await pool.query(`
      UPDATE personas SET
        tipo_documento_id              = $1,
        numero_documento               = $2,
        nombre                         = $3,
        apellidos                      = $4,
        numero_contacto                = $5,
        direccion_residencia           = $6,
        ciudad_residencia              = $7,
        tipo_persona                   = $8::tipo_persona,
        fecha_nacimiento               = $9,
        sexo                           = $10::tipo_sexo,
        departamento_pais              = $11,
        titulo_profesional             = $12,
        correo_electronico             = $13,
        razon_social                   = $14,
        nit_empresa                    = $15,
        representante_legal            = $16,
        tipo_documento_representante   = $17,
        numero_documento_representante = $18,
        updated_at                     = CURRENT_TIMESTAMP
      WHERE public_id = $19
        AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.persona_id = personas.id)
      RETURNING public_id, nombre, apellidos, numero_documento AS cedula, tipo_persona, sexo, estado
    `, [
      tipoDocumentoRef.id,
      toNullableTrimmedString(cedula),
      toNullableTrimmedString(nombre),
      toNullableTrimmedString(apellidos),
      toNullableTrimmedString(telefono),
      toNullableTrimmedString(direccion),
      toNullableTrimmedString(ciudad),
      tipoPersonaNormalizada ?? null,
      fecha_nacimiento || null,
      sexoNormalizado,
      toNullableTrimmedString(departamento_pais),
      toNullableTrimmedString(titulo_profesional),
      toNullableTrimmedString(correo_electronico)?.toLowerCase() || null,
      toNullableTrimmedString(razon_social),
      toNullableTrimmedString(nit_empresa),
      toNullableTrimmedString(representante_legal),
      toNullableTrimmedString(tipo_documento_representante),
      toNullableTrimmedString(numero_documento_representante),
      personaId
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Persona standalone no encontrada. Si tiene usuario vinculado, usa PUT /admin/personas/:id/personal" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "El número de documento ya está en uso" });
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Error al actualizar datos personales" });
  }
});

// PUT /admin/personas/p/:personaId/cobro — editar datos bancarios de persona standalone (admin + TH)
app.put("/admin/personas/p/:personaId/cobro", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const { personaId } = req.params;
  const { banco_id, tipo_cuenta_id, nro_cuenta_bancaria, factura_en_colombia } = req.body || {};
  try {
    const bancoRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.bancos, banco_id, "Banco");
    const tipoCuentaRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.tipoCuentaBancaria, tipo_cuenta_id, "Tipo de cuenta");
    const facturaVal =
      factura_en_colombia === true || factura_en_colombia === "true" || factura_en_colombia === 1 ? true
        : factura_en_colombia === false || factura_en_colombia === "false" || factura_en_colombia === 0 ? false
          : null;

    const result = await pool.query(`
      UPDATE personas SET
        banco_id            = $1,
        tipo_cuenta_id      = $2,
        numero_cuenta       = $3,
        factura_en_colombia = $4,
        updated_at          = CURRENT_TIMESTAMP
      WHERE public_id = $5
        AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.persona_id = personas.id)
      RETURNING public_id, numero_cuenta AS nro_cuenta_bancaria, factura_en_colombia
    `, [bancoRef.id, tipoCuentaRef.id, toNullableTrimmedString(nro_cuenta_bancaria), facturaVal, personaId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Persona standalone no encontrada. Si tiene usuario vinculado, usa PUT /admin/personas/:id/cobro" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Error al actualizar datos de cobro" });
  }
});

// PUT /admin/personas/p/:personaId/contratacion — editar contrato/módulo/cliente/familiar de persona standalone (admin + TH)
app.put("/admin/personas/p/:personaId/contratacion", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const { personaId } = req.params;
  const {
    tipo_contrato, modalidad,
    modulo_id, modulo_otro, cliente_id, cliente_otro,
    eps, afp, arl,
    composicion_familiar, hijos, personas_a_cargo,
    nombre_contacto_emergencia, telefono_contacto_emergencia, parentesco
  } = req.body || {};
  try {
    const moduloRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.modulo, modulo_id, "Módulo");
    const clienteRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.clientes, cliente_id, "Cliente");

    const tipoContratoNormalizado = toNullableTrimmedString(tipo_contrato);
    if (tipoContratoNormalizado && !["Full time", "Por horas", "Aprendiz", "Vinculado"].includes(tipoContratoNormalizado)) {
      return res.status(400).json({ error: "Tipo de contrato inválido" });
    }

    const result = await pool.query(`
      UPDATE personas SET
        tipo_contrato                = $1::tipo_contrato,
        modalidad                    = $2,
        modulo_id                    = $3,
        modulo_otro                  = $4,
        cliente_id                   = $5,
        cliente_otro                 = $6,
        eps                          = $7,
        afp                          = $8,
        arl                          = $9,
        composicion_familiar         = $10,
        hijos                        = $11,
        personas_a_cargo             = $12,
        nombre_contacto_emergencia   = $13,
        telefono_contacto_emergencia = $14,
        parentesco                   = $15,
        updated_at                   = CURRENT_TIMESTAMP
      WHERE public_id = $16
        AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.persona_id = personas.id)
      RETURNING public_id, tipo_contrato, modalidad
    `, [
      tipoContratoNormalizado,
      toNullableTrimmedString(modalidad),
      moduloRef.id,
      toNullableTrimmedString(modulo_otro),
      clienteRef.id,
      toNullableTrimmedString(cliente_otro),
      toNullableTrimmedString(eps),
      toNullableTrimmedString(afp),
      toNullableTrimmedString(arl),
      toNullableTrimmedString(composicion_familiar),
      Number.isFinite(Number(hijos)) ? Math.max(0, Math.floor(Number(hijos))) : 0,
      Number.isFinite(Number(personas_a_cargo)) ? Math.max(0, Math.floor(Number(personas_a_cargo))) : 0,
      toNullableTrimmedString(nombre_contacto_emergencia),
      toNullableTrimmedString(telefono_contacto_emergencia),
      toNullableTrimmedString(parentesco),
      personaId
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Persona standalone no encontrada. Si tiene usuario vinculado, usa PUT /admin/personas/:id/contratacion" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Error al actualizar datos de contratación" });
  }
});

// PATCH /admin/personas/p/:personaId/estado — activar o inactivar persona standalone (admin + TH)
app.patch("/admin/personas/p/:personaId/estado", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const { personaId } = req.params;
  const { estado } = req.body || {};
  if (!["activo", "inactivo"].includes(estado)) {
    return res.status(400).json({ error: "Estado inválido. Debe ser 'activo' o 'inactivo'" });
  }
  try {
    const result = await pool.query(
      `UPDATE personas SET estado = $1, updated_at = CURRENT_TIMESTAMP
       WHERE public_id = $2
         AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.persona_id = personas.id)
       RETURNING public_id, estado`,
      [estado, personaId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Persona standalone no encontrada. Si tiene usuario vinculado, gestiona su estado en /admin/usuarios" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar estado" });
  }
});

// POST /admin/personas — crear persona independiente (sin usuario del sistema) (admin + TH)
app.post("/admin/personas", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const {
    numero_documento, tipo_documento_id, nombre, apellidos,
    fecha_nacimiento, sexo, numero_contacto, correo_electronico,
    direccion_residencia, ciudad_residencia, departamento_pais,
    titulo_profesional, tipo_persona, factura_en_colombia,
    nombre_contacto_emergencia, telefono_contacto_emergencia, parentesco,
    banco_id, tipo_cuenta_id, numero_cuenta,
    composicion_familiar, hijos, personas_a_cargo,
    eps, afp, arl, tipo_contrato, modalidad,
    modulo_id, modulo_otro, cliente_id, cliente_otro
  } = req.body || {};

  try {
    const tipoDocumentoRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.documentoIdentidad, tipo_documento_id, "Tipo de documento");
    const bancoRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.bancos, banco_id, "Banco");
    const tipoCuentaRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.tipoCuentaBancaria, tipo_cuenta_id, "Tipo de cuenta");
    const moduloRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.modulo, modulo_id, "Módulo");
    const clienteRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.clientes, cliente_id, "Cliente");

    const tipoPersonaNormalizada = tipo_persona ? normalizeTipoPersonaForUsuariosInput(tipo_persona) : null;
    if (tipo_persona && !tipoPersonaNormalizada) {
      return res.status(400).json({ error: "Tipo de persona inválido" });
    }

    const sexoNormalizado = toNullableTrimmedString(sexo);
    const validSexos = ["Hombre", "Mujer", "Otro"];
    if (sexoNormalizado && !validSexos.includes(sexoNormalizado)) {
      return res.status(400).json({ error: "Sexo inválido. Debe ser Hombre, Mujer u Otro" });
    }

    const tipoContratoNormalizado = toNullableTrimmedString(tipo_contrato);
    const validTiposContrato = ["Full time", "Por horas", "Aprendiz", "Vinculado"];
    if (tipoContratoNormalizado && !validTiposContrato.includes(tipoContratoNormalizado)) {
      return res.status(400).json({ error: "Tipo de contrato inválido" });
    }

    const facturaVal =
      factura_en_colombia === true || factura_en_colombia === "true" || factura_en_colombia === 1
        ? true
        : factura_en_colombia === false || factura_en_colombia === "false" || factura_en_colombia === 0
          ? false
          : null;

    const result = await pool.query(`
      INSERT INTO personas (
        numero_documento, tipo_documento_id, nombre, apellidos,
        fecha_nacimiento, sexo, numero_contacto, correo_electronico,
        direccion_residencia, ciudad_residencia, departamento_pais,
        titulo_profesional, tipo_persona, factura_en_colombia,
        nombre_contacto_emergencia, telefono_contacto_emergencia, parentesco,
        banco_id, tipo_cuenta_id, numero_cuenta,
        composicion_familiar, hijos, personas_a_cargo,
        eps, afp, arl, tipo_contrato, modalidad,
        modulo_id, modulo_otro, cliente_id, cliente_otro,
        created_by
      ) VALUES (
        $1,$2,$3,$4,$5,$6::tipo_sexo,$7,$8,$9,$10,$11,
        $12,$13::tipo_persona,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27::tipo_contrato,$28,$29,$30,$31,$32,$33
      )
      RETURNING id, public_id, numero_documento, nombre, apellidos, estado, created_at
    `, [
      toNullableTrimmedString(numero_documento),
      tipoDocumentoRef.id,
      toNullableTrimmedString(nombre),
      toNullableTrimmedString(apellidos),
      fecha_nacimiento || null,
      sexoNormalizado,
      toNullableTrimmedString(numero_contacto),
      toNullableTrimmedString(correo_electronico)?.toLowerCase() || null,
      toNullableTrimmedString(direccion_residencia),
      toNullableTrimmedString(ciudad_residencia),
      toNullableTrimmedString(departamento_pais),
      toNullableTrimmedString(titulo_profesional),
      tipoPersonaNormalizada,
      facturaVal,
      toNullableTrimmedString(nombre_contacto_emergencia),
      toNullableTrimmedString(telefono_contacto_emergencia),
      toNullableTrimmedString(parentesco),
      bancoRef.id,
      tipoCuentaRef.id,
      toNullableTrimmedString(numero_cuenta),
      toNullableTrimmedString(composicion_familiar),
      Number.isFinite(Number(hijos)) ? Math.max(0, Math.floor(Number(hijos))) : 0,
      Number.isFinite(Number(personas_a_cargo)) ? Math.max(0, Math.floor(Number(personas_a_cargo))) : 0,
      toNullableTrimmedString(eps),
      toNullableTrimmedString(afp),
      toNullableTrimmedString(arl),
      tipoContratoNormalizado,
      toNullableTrimmedString(modalidad),
      moduloRef.id,
      toNullableTrimmedString(modulo_otro),
      clienteRef.id,
      toNullableTrimmedString(cliente_otro),
      req.user?.id || null
    ]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "El número de documento ya está en uso" });
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Error al crear persona" });
  }
});

// GET /admin/personas — listado de todos los usuarios con datos de persona (admin + coordinador + TH)
app.get("/admin/personas", requireAccess({ roles: ["Administrador", "Coordinador", "Talento Humano"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.public_id                                        AS id,
        u.nombre_usuario,
        u.email,
        u.activo,
        u.ultimo_inicio_sesion,
        u.azure_oid,
        r.titulo                                           AS rol,
        p.public_id                                        AS persona_public_id,
        COALESCE(p.ciudad_residencia, u.ciudad)            AS ciudad,
        COALESCE(p.numero_documento, u.cedula)             AS cedula,
        COALESCE(p.tipo_persona, u.tipo_persona)           AS tipo_persona,
        p.estado                                           AS persona_estado,
        p.nombre                                           AS persona_nombre,
        p.apellidos                                        AS persona_apellidos
      FROM usuarios u
      LEFT JOIN roles r    ON r.id = u.rol_usuario_id
      LEFT JOIN personas p ON p.id = u.persona_id
      ORDER BY u.nombre_usuario ASC
    `);
    res.json((result.rows || []).map((row) => sanitizePersonaForRead(row, req)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar personas" });
  }
});

// GET /admin/personas/:id — ficha completa con datos de persona (admin + coordinador + TH)
app.get("/admin/personas/:id", requireAccess({ roles: ["Administrador", "Coordinador", "Talento Humano"] }), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        u.public_id                                              AS id,
        u.nombre_usuario,
        u.email,
        u.activo,
        u.azure_oid,
        u.ultimo_inicio_sesion,
        u.moneda_cobro,
        u.tipo_consultor,
        u.observaciones,

        -- Rol
        r.public_id                                             AS rol_id,
        r.titulo                                                AS rol,

        -- Consultor principal
        cp.public_id                                            AS consultor_principal_id,
        cp.nombre_usuario                                       AS consultor_principal_nombre,

        -- Persona (COALESCE: persona primero, usuario como fallback)
        p.public_id                                             AS persona_public_id,
        p.estado                                                AS persona_estado,
        COALESCE(p.tipo_persona, u.tipo_persona)                AS tipo_persona,
        COALESCE(p.factura_en_colombia, u.factura_en_colombia)  AS factura_en_colombia,
        COALESCE(p.numero_documento, u.cedula)                  AS cedula,
        COALESCE(p.numero_contacto, u.telefono)                 AS telefono,
        COALESCE(p.direccion_residencia, u.direccion)           AS direccion,
        COALESCE(p.ciudad_residencia, u.ciudad)                 AS ciudad,
        p.departamento_pais,
        p.titulo_profesional,
        p.sexo,
        p.fecha_nacimiento,
        p.nombre                                                AS persona_nombre,
        p.apellidos                                             AS persona_apellidos,
        COALESCE(p.numero_cuenta, u.nro_cuenta_bancaria)        AS nro_cuenta_bancaria,
        p.eps,
        p.afp,
        p.arl,
        p.composicion_familiar,
        p.hijos,
        p.personas_a_cargo,
        p.nombre_contacto_emergencia,
        p.telefono_contacto_emergencia,
        p.parentesco,
        p.tipo_contrato,
        p.modalidad,
        m.public_id                                             AS persona_modulo_id,
        m.titulo                                                AS persona_modulo,
        p.modulo_otro,
        cl.public_id                                            AS persona_cliente_id,
        cl.titulo                                               AS persona_cliente,
        p.cliente_otro,

        -- Persona jurídica (contratista)
        p.razon_social,
        p.nit_empresa,
        p.representante_legal,
        p.tipo_documento_representante,
        p.numero_documento_representante,

        -- Bancario (persona primero, luego usuario)
        COALESCE(b_p.public_id, b_u.public_id)                 AS banco_id,
        COALESCE(b_p.titulo, b_u.titulo)                       AS banco,
        COALESCE(tc_p.public_id, tc_u.public_id)               AS tipo_cuenta_id,
        COALESCE(tc_p.titulo, tc_u.titulo)                     AS tipo_cuenta,

        -- Documento (persona primero, luego usuario)
        COALESCE(di_p.public_id, di_u.public_id)               AS tipo_documento_id,
        COALESCE(di_p.titulo, di_u.titulo)                     AS tipo_documento,
        COALESCE(di_p.codigo, di_u.codigo)                     AS tipo_documento_codigo

      FROM usuarios u
      LEFT JOIN roles r                  ON r.id  = u.rol_usuario_id
      LEFT JOIN personas p               ON p.id  = u.persona_id
      LEFT JOIN bancos b_p               ON b_p.id  = p.banco_id
      LEFT JOIN bancos b_u               ON b_u.id  = u.banco_id
      LEFT JOIN tipo_cuenta_bancaria tc_p ON tc_p.id = p.tipo_cuenta_id
      LEFT JOIN tipo_cuenta_bancaria tc_u ON tc_u.id = u.tipo_cuenta_id
      LEFT JOIN documento_identidad di_p  ON di_p.id = p.tipo_documento_id
      LEFT JOIN documento_identidad di_u  ON di_u.id = u.tipo_documento_id
      LEFT JOIN modulo m                 ON m.id  = p.modulo_id
      LEFT JOIN clientes cl              ON cl.id = p.cliente_id
      LEFT JOIN usuarios cp              ON cp.id = u.id_consultor_principal
      WHERE u.public_id = $1
    `, [id]);

    if (result.rowCount === 0) return res.status(404).json({ error: "Persona no encontrada" });
    res.json(sanitizePersonaForRead(result.rows[0], req));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener ficha de persona" });
  }
});

// PUT /admin/personas/:id/identidad — nombre, email, rol, activo, azure_oid (admin + TH)
app.put("/admin/personas/:id/identidad", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const { id } = req.params;
  const { nombre_usuario, email, rol_id, activo, azure_oid } = req.body || {};
  try {
    const nombreUsuario = toNullableTrimmedString(nombre_usuario);
    const emailNormalizado = toNullableTrimmedString(email)?.toLowerCase() || null;
    const azureOid = toNullableTrimmedString(azure_oid);
    const rolRef = await resolvePersonaReferenceOrThrow(pool, ID_TABLES.roles, rol_id, "Rol");

    if (!nombreUsuario) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }
    if (!emailNormalizado || !isValidEmailFormat(emailNormalizado)) {
      return res.status(400).json({ error: "El email no tiene un formato válido" });
    }
    if (typeof activo !== "boolean") {
      return res.status(400).json({ error: "El estado activo es obligatorio" });
    }

    const result = await pool.query(`
      UPDATE usuarios SET
        nombre_usuario = $1,
        email          = $2,
        rol_usuario_id = $3,
        activo         = $4,
        azure_oid      = $5,
        updated_at     = CURRENT_TIMESTAMP
      WHERE public_id = $6
      RETURNING public_id AS id, nombre_usuario, email, activo, azure_oid
    `, [
      nombreUsuario,
      emailNormalizado,
      rolRef.id,
      activo,
      azureOid,
      id
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Persona no encontrada" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "El email ya está en uso por otro usuario" });
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Error al actualizar identidad" });
  }
});

// PUT /admin/personas/:id/personal — escribe a tabla personas (crea si no existe) + fallback usuarios (admin + TH)
app.put("/admin/personas/:id/personal", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const { id } = req.params;
  const {
    tipo_documento_id, cedula, telefono, direccion, ciudad, tipo_persona,
    apellidos, fecha_nacimiento, sexo, departamento_pais, titulo_profesional,
    razon_social, nit_empresa, representante_legal,
    tipo_documento_representante, numero_documento_representante
  } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tipoDocumentoRef = await resolvePersonaReferenceOrThrow(client, ID_TABLES.documentoIdentidad, tipo_documento_id, "Tipo de documento");
    const tipoPersonaNormalizada = tipo_persona === undefined
      ? undefined
      : normalizeTipoPersonaForUsuariosInput(tipo_persona);

    if (tipo_persona !== undefined && tipo_persona !== null && !tipoPersonaNormalizada) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Tipo de persona inválido" });
    }

    const sexoNormalizado = toNullableTrimmedString(sexo);
    const validSexos = ["Hombre", "Mujer", "Otro"];
    if (sexoNormalizado && !validSexos.includes(sexoNormalizado)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Sexo inválido. Debe ser Hombre, Mujer u Otro" });
    }

    // Obtener usuario y su persona_id (nombre_usuario para poblar persona.nombre si se crea desde aquí)
    const usuarioRes = await client.query(
      "SELECT id, persona_id, nombre_usuario FROM usuarios WHERE public_id = $1",
      [id]
    );
    if (usuarioRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Persona no encontrada" });
    }
    const usuario = usuarioRes.rows[0];
    let personaId = usuario.persona_id;

    if (!personaId) {
      // Crear nueva persona y vincularla.
      // Se puebla nombre con nombre_usuario para que la persona no quede completamente vacía.
      const newPersona = await client.query(`
        INSERT INTO personas (
          nombre,
          numero_documento, tipo_documento_id, tipo_persona,
          numero_contacto, direccion_residencia, ciudad_residencia,
          apellidos, fecha_nacimiento, sexo, departamento_pais, titulo_profesional,
          razon_social, nit_empresa, representante_legal,
          tipo_documento_representante, numero_documento_representante,
          created_by
        ) VALUES ($1, $2, $3, $4::tipo_persona, $5, $6, $7, $8, $9, $10::tipo_sexo, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING id
      `, [
        usuario.nombre_usuario,
        toNullableTrimmedString(cedula),
        tipoDocumentoRef.id,
        tipoPersonaNormalizada ?? null,
        toNullableTrimmedString(telefono),
        toNullableTrimmedString(direccion),
        toNullableTrimmedString(ciudad),
        toNullableTrimmedString(apellidos),
        fecha_nacimiento || null,
        sexoNormalizado,
        toNullableTrimmedString(departamento_pais),
        toNullableTrimmedString(titulo_profesional),
        toNullableTrimmedString(razon_social),
        toNullableTrimmedString(nit_empresa),
        toNullableTrimmedString(representante_legal),
        toNullableTrimmedString(tipo_documento_representante),
        toNullableTrimmedString(numero_documento_representante),
        usuario.id
      ]);
      personaId = newPersona.rows[0].id;
      await client.query(
        "UPDATE usuarios SET persona_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        [personaId, usuario.id]
      );
    } else {
      // Actualizar persona existente
      await client.query(`
        UPDATE personas SET
          numero_documento              = $1,
          tipo_documento_id             = $2,
          tipo_persona                  = $3::tipo_persona,
          numero_contacto               = $4,
          direccion_residencia          = $5,
          ciudad_residencia             = $6,
          apellidos                     = $7,
          fecha_nacimiento              = $8,
          sexo                          = $9::tipo_sexo,
          departamento_pais             = $10,
          titulo_profesional            = $11,
          razon_social                  = $12,
          nit_empresa                   = $13,
          representante_legal           = $14,
          tipo_documento_representante  = $15,
          numero_documento_representante = $16,
          updated_at                    = CURRENT_TIMESTAMP
        WHERE id = $17
      `, [
        toNullableTrimmedString(cedula),
        tipoDocumentoRef.id,
        tipoPersonaNormalizada ?? null,
        toNullableTrimmedString(telefono),
        toNullableTrimmedString(direccion),
        toNullableTrimmedString(ciudad),
        toNullableTrimmedString(apellidos),
        fecha_nacimiento || null,
        sexoNormalizado,
        toNullableTrimmedString(departamento_pais),
        toNullableTrimmedString(titulo_profesional),
        toNullableTrimmedString(razon_social),
        toNullableTrimmedString(nit_empresa),
        toNullableTrimmedString(representante_legal),
        toNullableTrimmedString(tipo_documento_representante),
        toNullableTrimmedString(numero_documento_representante),
        personaId
      ]);
    }

    await client.query("COMMIT");

    const updated = await pool.query(`
      SELECT
        COALESCE(p.numero_documento, u.cedula)             AS cedula,
        COALESCE(p.numero_contacto, u.telefono)            AS telefono,
        COALESCE(p.direccion_residencia, u.direccion)      AS direccion,
        COALESCE(p.ciudad_residencia, u.ciudad)            AS ciudad,
        COALESCE(p.tipo_persona, u.tipo_persona)           AS tipo_persona,
        p.apellidos,
        p.fecha_nacimiento,
        p.sexo,
        p.departamento_pais,
        p.titulo_profesional,
        p.razon_social,
        p.nit_empresa,
        p.representante_legal,
        p.tipo_documento_representante,
        p.numero_documento_representante,
        p.public_id                                        AS persona_public_id,
        di.public_id  AS tipo_documento_id,
        di.titulo     AS tipo_documento,
        di.codigo     AS tipo_documento_codigo
      FROM usuarios u
      LEFT JOIN personas p              ON p.id  = u.persona_id
      LEFT JOIN documento_identidad di  ON di.id = p.tipo_documento_id
      WHERE u.public_id = $1
    `, [id]);

    res.json(updated.rows[0] || {});
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { });
    if (err.code === "23505") return res.status(409).json({ error: "El número de documento ya está en uso" });
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Error al actualizar datos personales" });
  } finally {
    client.release();
  }
});

// PUT /admin/personas/:id/cobro — moneda queda en usuarios; banco/cuenta/factura van a personas (admin + TH)
app.put("/admin/personas/:id/cobro", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const { id } = req.params;
  const { moneda_cobro, banco_id, tipo_cuenta_id, nro_cuenta_bancaria, factura_en_colombia } = req.body || {};
  const client = await pool.connect();
  try {
    const bancoRef = await resolvePersonaReferenceOrThrow(client, ID_TABLES.bancos, banco_id, "Banco");
    const tipoCuentaRef = await resolvePersonaReferenceOrThrow(client, ID_TABLES.tipoCuentaBancaria, tipo_cuenta_id, "Tipo de cuenta");
    const monedaNormalizada = moneda_cobro === undefined ? undefined : normalizeValue(moneda_cobro).toUpperCase();
    const facturaEnColombiaNormalizada =
      factura_en_colombia === undefined
        ? undefined
        : factura_en_colombia === null || factura_en_colombia === ""
          ? null
          : factura_en_colombia === true || factura_en_colombia === "true" || factura_en_colombia === 1 || factura_en_colombia === "1"
            ? true
            : factura_en_colombia === false || factura_en_colombia === "false" || factura_en_colombia === 0 || factura_en_colombia === "0"
              ? false
              : "__invalid__";

    if (!["COP", "USD", "EUR"].includes(monedaNormalizada || "")) {
      return res.status(400).json({ error: "Moneda no válida" });
    }
    if (facturaEnColombiaNormalizada === "__invalid__") {
      return res.status(400).json({ error: "Factura en Colombia no válida" });
    }

    await client.query("BEGIN");

    // Obtener usuario (nombre_usuario para poblar persona.nombre si se crea desde aquí)
    const usuarioRes = await client.query(
      "SELECT id, persona_id, nombre_usuario FROM usuarios WHERE public_id = $1",
      [id]
    );
    if (usuarioRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Persona no encontrada" });
    }
    const usuario = usuarioRes.rows[0];
    let personaId = usuario.persona_id;

    // Moneda se actualiza en usuarios
    await client.query(
      "UPDATE usuarios SET moneda_cobro = $1::tipo_moneda, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [monedaNormalizada, usuario.id]
    );

    if (!personaId) {
      // Crear persona con datos de cobro y vincular.
      // Se puebla nombre con nombre_usuario para que la persona no quede completamente vacía.
      const newPersona = await client.query(`
        INSERT INTO personas (nombre, banco_id, tipo_cuenta_id, numero_cuenta, factura_en_colombia, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [usuario.nombre_usuario, bancoRef.id, tipoCuentaRef.id, toNullableTrimmedString(nro_cuenta_bancaria), facturaEnColombiaNormalizada ?? null, usuario.id]);
      personaId = newPersona.rows[0].id;
      await client.query(
        "UPDATE usuarios SET persona_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        [personaId, usuario.id]
      );
    } else {
      // Actualizar datos bancarios en persona
      await client.query(`
        UPDATE personas SET
          banco_id            = $1,
          tipo_cuenta_id      = $2,
          numero_cuenta       = $3,
          factura_en_colombia = $4,
          updated_at          = CURRENT_TIMESTAMP
        WHERE id = $5
      `, [bancoRef.id, tipoCuentaRef.id, toNullableTrimmedString(nro_cuenta_bancaria), facturaEnColombiaNormalizada ?? null, personaId]);
    }

    await client.query("COMMIT");

    const updated = await pool.query(`
      SELECT
        u.moneda_cobro,
        COALESCE(p.factura_en_colombia, u.factura_en_colombia)  AS factura_en_colombia,
        COALESCE(p.numero_cuenta, u.nro_cuenta_bancaria)        AS nro_cuenta_bancaria,
        COALESCE(b_p.public_id, b_u.public_id)                 AS banco_id,
        COALESCE(b_p.titulo, b_u.titulo)                       AS banco,
        COALESCE(tc_p.public_id, tc_u.public_id)               AS tipo_cuenta_id,
        COALESCE(tc_p.titulo, tc_u.titulo)                     AS tipo_cuenta
      FROM usuarios u
      LEFT JOIN personas p               ON p.id  = u.persona_id
      LEFT JOIN bancos b_p               ON b_p.id  = p.banco_id
      LEFT JOIN bancos b_u               ON b_u.id  = u.banco_id
      LEFT JOIN tipo_cuenta_bancaria tc_p ON tc_p.id = p.tipo_cuenta_id
      LEFT JOIN tipo_cuenta_bancaria tc_u ON tc_u.id = u.tipo_cuenta_id
      WHERE u.public_id = $1
    `, [id]);

    res.json(updated.rows[0] || {});
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { });
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Error al actualizar datos de cobro" });
  } finally {
    client.release();
  }
});

// PUT /admin/personas/:id/contratacion — tipo_contrato, módulo, cliente, seguridad social, familiar, emergencia (admin + TH)
app.put("/admin/personas/:id/contratacion", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const { id } = req.params;
  const {
    tipo_contrato, modalidad,
    modulo_id, modulo_otro, cliente_id, cliente_otro,
    eps, afp, arl,
    composicion_familiar, hijos, personas_a_cargo,
    nombre_contacto_emergencia, telefono_contacto_emergencia, parentesco,
    apellidos, fecha_nacimiento, sexo, departamento_pais, titulo_profesional
  } = req.body || {};
  const client = await pool.connect();
  try {
    const moduloRef = await resolvePersonaReferenceOrThrow(client, ID_TABLES.modulo, modulo_id, "Módulo");
    const clienteRef = await resolvePersonaReferenceOrThrow(client, ID_TABLES.clientes, cliente_id, "Cliente");

    const tipoContratoNormalizado = toNullableTrimmedString(tipo_contrato);
    const validTiposContrato = ["Full time", "Por horas", "Aprendiz", "Vinculado"];
    if (tipoContratoNormalizado && !validTiposContrato.includes(tipoContratoNormalizado)) {
      return res.status(400).json({ error: "Tipo de contrato inválido" });
    }

    const sexoNormalizado = toNullableTrimmedString(sexo);
    const validSexos = ["Hombre", "Mujer", "Otro"];
    if (sexoNormalizado && !validSexos.includes(sexoNormalizado)) {
      return res.status(400).json({ error: "Sexo inválido. Debe ser Hombre, Mujer u Otro" });
    }

    await client.query("BEGIN");

    const usuarioRes = await client.query(
      "SELECT id, persona_id, nombre_usuario FROM usuarios WHERE public_id = $1",
      [id]
    );
    if (usuarioRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Persona no encontrada" });
    }
    const usuario = usuarioRes.rows[0];
    let personaId = usuario.persona_id;

    const params = [
      tipoContratoNormalizado,
      toNullableTrimmedString(modalidad),
      moduloRef.id,
      toNullableTrimmedString(modulo_otro),
      clienteRef.id,
      toNullableTrimmedString(cliente_otro),
      toNullableTrimmedString(eps),
      toNullableTrimmedString(afp),
      toNullableTrimmedString(arl),
      toNullableTrimmedString(composicion_familiar),
      Number.isFinite(Number(hijos)) ? Math.max(0, Math.floor(Number(hijos))) : 0,
      Number.isFinite(Number(personas_a_cargo)) ? Math.max(0, Math.floor(Number(personas_a_cargo))) : 0,
      toNullableTrimmedString(nombre_contacto_emergencia),
      toNullableTrimmedString(telefono_contacto_emergencia),
      toNullableTrimmedString(parentesco),
      toNullableTrimmedString(apellidos),
      fecha_nacimiento || null,
      sexoNormalizado,
      toNullableTrimmedString(departamento_pais),
      toNullableTrimmedString(titulo_profesional)
    ];

    if (!personaId) {
      // Se puebla nombre con nombre_usuario para que la persona no quede completamente vacía.
      const newPersona = await client.query(`
        INSERT INTO personas (
          nombre,
          tipo_contrato, modalidad, modulo_id, modulo_otro, cliente_id, cliente_otro,
          eps, afp, arl, composicion_familiar, hijos, personas_a_cargo,
          nombre_contacto_emergencia, telefono_contacto_emergencia, parentesco,
          apellidos, fecha_nacimiento, sexo, departamento_pais, titulo_profesional,
          created_by
        ) VALUES (
          $1,
          $2::tipo_contrato,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
          $14,$15,$16,$17,$18,$19::tipo_sexo,$20,$21,$22
        )
        RETURNING id
      `, [usuario.nombre_usuario, ...params, usuario.id]);
      personaId = newPersona.rows[0].id;
      await client.query(
        "UPDATE usuarios SET persona_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        [personaId, usuario.id]
      );
    } else {
      await client.query(`
        UPDATE personas SET
          tipo_contrato                = $1::tipo_contrato,
          modalidad                    = $2,
          modulo_id                    = $3,
          modulo_otro                  = $4,
          cliente_id                   = $5,
          cliente_otro                 = $6,
          eps                          = $7,
          afp                          = $8,
          arl                          = $9,
          composicion_familiar         = $10,
          hijos                        = $11,
          personas_a_cargo             = $12,
          nombre_contacto_emergencia   = $13,
          telefono_contacto_emergencia = $14,
          parentesco                   = $15,
          apellidos                    = $16,
          fecha_nacimiento             = $17,
          sexo                         = $18::tipo_sexo,
          departamento_pais            = $19,
          titulo_profesional           = $20,
          updated_at                   = CURRENT_TIMESTAMP
        WHERE id = $21
      `, [...params, personaId]);
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { });
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Error al actualizar datos de contratación" });
  } finally {
    client.release();
  }
});

// PUT /admin/personas/:id/operativa — tipo_consultor, consultor_principal (admin + TH)
app.put("/admin/personas/:id/operativa", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  const { id } = req.params;
  const { tipo_consultor, consultor_principal_id } = req.body || {};
  const client = await pool.connect();
  try {
    const personaId = await resolveInternalIdFromPublicIdOrId(client, ID_TABLES.usuarios, id);
    if (!personaId) return res.status(404).json({ error: "Persona no encontrada" });

    const personaActualRes = await client.query(
      `
      SELECT id, tipo_consultor, id_consultor_principal
      FROM usuarios
      WHERE id = $1
      LIMIT 1
      `,
      [personaId]
    );
    const personaActual = personaActualRes.rows[0];
    const principalRef = await resolvePersonaReferenceOrThrow(client, ID_TABLES.usuarios, consultor_principal_id, "Consultor principal");
    const tipoConsultorNormalizado = tipo_consultor === undefined
      ? undefined
      : normalizeTipoConsultorInput(tipo_consultor);

    if (tipo_consultor !== undefined && tipo_consultor !== null && !tipoConsultorNormalizado) {
      return res.status(400).json({ error: "Tipo de consultor inválido" });
    }

    let nextPrincipalId = principalRef.provided ? principalRef.id : personaActual.id_consultor_principal;
    let nextTipoConsultor = tipoConsultorNormalizado !== undefined ? tipoConsultorNormalizado : personaActual.tipo_consultor;

    if (nextPrincipalId && Number(nextPrincipalId) === Number(personaId)) {
      return res.status(400).json({ error: "Una persona no puede ser su propio consultor principal" });
    }

    const dependientesRes = await client.query(
      `
      SELECT COUNT(*)::int AS total
      FROM usuarios
      WHERE id_consultor_principal = $1
      `,
      [personaId]
    );
    const totalDependientes = Number(dependientesRes.rows[0]?.total || 0);

    if (nextPrincipalId) {
      const principalMeta = await client.query(
        `
        SELECT id, tipo_consultor
        FROM usuarios
        WHERE id = $1
          AND activo = true
        LIMIT 1
        `,
        [nextPrincipalId]
      );
      const principalRow = principalMeta.rows[0];
      if (!principalRow) {
        return res.status(400).json({ error: "Consultor principal no válido" });
      }
      if (normalizeValue(principalRow.tipo_consultor) === "asociado") {
        return res.status(400).json({ error: "Un consultor asociado no puede ser consultor principal" });
      }
      if (totalDependientes > 0) {
        return res.status(400).json({ error: "No puedes asociar a una persona que ya tiene subconsultores asignados" });
      }
      if (!nextTipoConsultor) nextTipoConsultor = "Asociado";
      if (nextTipoConsultor !== "Asociado") {
        return res.status(400).json({ error: "Solo un consultor asociado puede tener consultor principal asignado" });
      }
    }

    if (!nextPrincipalId && nextTipoConsultor === "Asociado") {
      return res.status(400).json({ error: "Un consultor asociado debe tener consultor principal asignado" });
    }

    if (nextTipoConsultor === "Asociado" && totalDependientes > 0) {
      return res.status(400).json({ error: "No puedes marcar como asociado a una persona que ya tiene subconsultores asignados" });
    }

    const result = await client.query(
      `
      UPDATE usuarios SET
        tipo_consultor         = $1::tipo_consultor_enum,
        id_consultor_principal = $2,
        updated_at             = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING public_id AS id, tipo_consultor
      `,
      [nextTipoConsultor || null, nextPrincipalId || null, personaId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Persona no encontrada" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Error al actualizar relación operativa" });
  } finally {
    client.release();
  }
});

// GET /admin/tipos-cuenta-bancaria — catálogo para formulario (admin + TH)
app.get("/admin/tipos-cuenta-bancaria", requireAccess({ roles: ["Administrador", "Talento Humano"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT public_id AS id, titulo
      FROM tipo_cuenta_bancaria
      WHERE activo = true
      ORDER BY titulo ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tipos de cuenta" });
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

// Tipos de documento activos
app.get("/documentos-identidad", requireAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT public_id AS id, titulo, codigo
      FROM documento_identidad
      WHERE activo = true
      ORDER BY titulo ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener documentos de identidad" });
  }
});

// Supervisores/Coordinadores disponibles para flujos de contratación
app.get("/supervisores", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial", "Talento Humano"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.public_id AS id,
        u.nombre_usuario AS nombre,
        u.email
      FROM usuarios u
      LEFT JOIN roles r ON r.id = u.rol_usuario_id
      WHERE u.activo = true
        AND (
          LOWER(COALESCE(r.titulo, '')) IN ('coordinador', 'administrador')
          OR LOWER(COALESCE(u.tipo_consultor::text, '')) = 'principal'
        )
      ORDER BY u.nombre_usuario ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener supervisores" });
  }
});


/* ===============================
   API - RRHH SOLICITUDES
=============================== */

// Listar solicitudes: administrador y reclutador ven todas; coordinador/comercial ven solo las propias.
app.get("/rrhh/solicitudes", requireAccess({ roles: ["Coordinador", "Reclutador", "Comercial", "Administrador"] }), async (req, res) => {
  try {
    const role = normalizeValue(req.user?.rol);
    const params = [];
    let where = "";
    if (!["administrador", "reclutador"].includes(role)) {
      params.push(req.user?.id);
      where = "WHERE s.coordinador_id = $1";
    }
    const result = await pool.query(
      `
      SELECT
        s.public_id AS id,
        coord.public_id AS coordinador_id,
        c.public_id AS cliente_id,
        COALESCE(c.titulo, s.cliente_nombre_otro) AS cliente,
        s.cliente_nombre_otro,
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
app.post("/rrhh/solicitudes", requireAccess({ roles: ["Coordinador", "Administrador", "Comercial"] }), async (req, res) => {
  const {
    cliente_id,
    cliente_nombre_otro,
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
    const clienteNombreOtro = String(cliente_nombre_otro || "").trim() || null;
    const esProspecto = !cliente_id && clienteNombreOtro;
    if (!nivel) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }
    if (!cliente_id && !clienteNombreOtro) {
      return res.status(400).json({ error: "Selecciona un cliente o escribe el nombre del prospecto" });
    }
    let clienteInternalId = null;
    if (!esProspecto) {
      clienteInternalId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.clientes, cliente_id);
      if (!clienteInternalId) {
        return res.status(404).json({ error: "Cliente no encontrado o inválido" });
      }
    }
    const moduloInternalId = modulo_id
      ? await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.modulo, modulo_id)
      : null;
    if (modulo_id && !moduloInternalId) {
      return res.status(404).json({ error: "Módulo no encontrado o inválido" });
    }
    let perfilFinal = String(perfil || "").trim();
    if (!perfilFinal && moduloInternalId) {
      const moduloTituloRes = await pool.query(
        `SELECT titulo FROM modulo WHERE id = $1`,
        [moduloInternalId]
      );
      perfilFinal = String(moduloTituloRes.rows[0]?.titulo || "").trim();
    }
    if (!perfilFinal) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }
    const result = await pool.query(
      `
      INSERT INTO solicitudes_rrhh
        (
          coordinador_id,
          cliente_id,
          cliente_nombre_otro,
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
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id
      `,
      [
        req.user?.id,
        clienteInternalId,
        clienteNombreOtro,
        moduloInternalId,
        perfilFinal,
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
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cliente y/o módulo no encontrado(s), o inválido(s)" });
    }
    const createdInternalId = result.rows[0]?.id;
    const createdRes = await pool.query(
      `
      SELECT
        s.public_id AS id,
        coord.public_id AS coordinador_id,
        c.public_id AS cliente_id,
        COALESCE(c.titulo, s.cliente_nombre_otro) AS cliente,
        s.cliente_nombre_otro,
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
      WHERE s.public_id = $1
      `,
      [id]
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

    values.push(before.id);
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
        portalUrl: buildPortalUrl("solicitudesCoord"),
        senderName: req.user?.nombre_usuario || req.user?.email || "Silver Consulting"
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
  ID_TABLES,
  normalizeValue,
  requireAccess,
  getGraphContext,
  sendEmailSafe,
  buildEmailLayout,
  buildPortalUrl,
  ensurePersistedAnexoFromProceso,
  resolveTalentoHumanoNotificationRecipients
});

registerContratacionesRoutes({
  app,
  pool,
  ID_TABLES,
  normalizeValue,
  requireAccess,
  getGraphContext,
  sendEmailSafe,
  buildEmailLayout,
  ensurePersistedAnexoFromProceso,
  resolveTalentoHumanoNotificationRecipients
});
// ========================================================================================================================
//  RUTAS PÚBLICAS - MÓDULO FIRMA DE CONTRATOS (sin auth de Microsoft)
// ========================================================================================================================

const CONTRATOS_STATIC_DIR = path.join(__dirname, "static", "contratos");

// plantilla: true ? el frontend descarga automáticamente al confirmar lectura
const DOCS_ESTATICOS = [
  { clave: "politica_pago", archivo: "POL\u00CDTICA DE PAGO A PROVEEDORES - GENERAL.pdf", label: "Politica de pago de proveedores" },
  { clave: "codigo_etica", archivo: "Silver Consulting - C\u00F3digo de \u00E9tica y conducta.pdf", label: "Codigo de etica y conducta" },
  { clave: "requisitos", archivo: "REQUISITOS DE CONTRATO OUTSOURCING.pdf", label: "Requisitos de Contrato" },
  { clave: "plantilla_tiempos", archivo: "SC-PS-Seguridad Equipos V1.pdf", label: "Seguridad de Equipos", plantilla: true, descarga_archivo: "PLANTILLA DE TIEMPOS.xlsx" },
  { clave: "guia_autenticador", archivo: "Silver Consulting - Configurar Autenticaci\u00F3n Multifactor - Office 365.pdf", label: "Guia Autenticador Office 365" },
  { clave: "guia_mfa_365", archivo: "Silver Consulting - configurar MFA Silver Consulting - Office 365.pdf", label: "Guia MFA Office 365" },
  { clave: "guia_ingreso_365", archivo: "Silver Consulting - Ingresar a Microsoft 365 Est\u00E1ndar.pdf", label: "Guia ingreso Microsoft 365 Estandar" },
];

const ARCHIVOS_ESTATICOS_CONTRATACION = new Set(
  DOCS_ESTATICOS
    .flatMap((d) => [d.archivo, d.descarga_archivo])
    .filter(Boolean)
);

const FORM_DATOS_PERSONA = {
  clave: "datos_personales",
  label: "Datos personales"
};
const LEGACY_LINK_FORMULARIO_CLAVE = "link_formulario";
const ESTADOS_CIVILES_CONTRATACION = ["Soltero", "Casado", "Unión libre", "Separado", "Viudo"];
const SEXOS_CONTRATACION = ["Hombre", "Mujer", "Otro"];

function normalizeSexoContratacion(value) {
  const raw = toNullableTrimmedString(value);
  if (!raw) return null;

  const normalized = raw.toLowerCase();
  if (["hombre", "masculino", "male", "m"].includes(normalized)) return "Hombre";
  if (["mujer", "femenino", "female", "f"].includes(normalized)) return "Mujer";
  if (["otro", "other", "o"].includes(normalized)) return "Otro";
  return raw;
}

const VIDEO_BIENVENIDA = "Silver Consulting - Bienvenida.mp4";

const CLAVES_ESTATICAS_VALIDAS = new Set([
  ...DOCS_ESTATICOS.map(d => d.clave),
  LEGACY_LINK_FORMULARIO_CLAVE,
  // backward compat con tokens antiguos
  "pdf1", "pdf2", "pdf3", "pdf4", "pdf5"
]);

const CLAVES_REQUERIDAS_FIRMA = [
  ...DOCS_ESTATICOS.map(d => d.clave),
  FORM_DATOS_PERSONA.clave
];

const requireTokenFirma = (req, res, next) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token requerido" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tipo !== "firma_contrato") throw new Error("Tipo de token inválido");
    req.tokenFirma = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Token de firma inválido o expirado" });
  }
};

// POST /contratacion/validar ? valida token de correo y devuelve JWT temporal
app.post("/contratacion/validar", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Token requerido" });

  try {
    const r = await pool.query(
      `SELECT id, public_id, nombre_persona, correo_personal, estado, checks_completados, docs_firma, expires_at, solicitud_id, preregistro_id
       FROM tokens_firma_contrato WHERE token = $1 LIMIT 1`,
      [String(token).trim().toLowerCase()]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Token no válido" });

    const row = r.rows[0];
    if (row.estado === "expirado" || row.estado === "completado") {
      return res.status(400).json({ error: `Este proceso ya fue ${row.estado === "completado" ? "completado" : "anulado"}` });
    }
    if (new Date() > new Date(row.expires_at)) {
      await pool.query("UPDATE tokens_firma_contrato SET estado='expirado' WHERE id=$1", [row.id]);
      return res.status(401).json({ error: "El enlace ha expirado. Solicita uno nuevo a Talento Humano." });
    }
    if (row.estado === "pendiente") {
      await pool.query("UPDATE tokens_firma_contrato SET estado='en_proceso', updated_at=NOW() WHERE id=$1", [row.id]);
    }

    const docsFirma = await ensureTokenDocsFirmaPlan(row);

    const jwtTemporal = jwt.sign(
      { tipo: "firma_contrato", token_id: row.id, token_public_id: row.public_id },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      jwt: jwtTemporal,
      nombre: row.nombre_persona,
      checks_completados: row.checks_completados,
      docs_firma: normalizeDocsFirmaListCompat(docsFirma)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error validando token" });
  }
});

// GET /contratacion/estado ? estado actual del proceso (polling)
app.get("/contratacion/estado", requireTokenFirma, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre_persona, correo_personal, estado, checks_completados, docs_firma, expires_at, solicitud_id, preregistro_id
       FROM tokens_firma_contrato WHERE id = $1`,
      [req.tokenFirma.token_id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Proceso no encontrado" });
    const row = r.rows[0];
    const docsFirma = await ensureTokenDocsFirmaPlan(row);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("ETag", `"estado-${Date.now()}"`);
    res.json({
      nombre_persona: row.nombre_persona,
      estado: row.estado,
      checks_completados: row.checks_completados,
      docs_firma: normalizeDocsFirmaListCompat(docsFirma),
      expires_at: row.expires_at
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo estado" });
  }
});

// POST /contratacion/firma/reconciliar ? consulta Click&Sign y sincroniza docs_firma/OneDrive
app.post("/contratacion/firma/reconciliar", requireTokenFirma, async (req, res) => {
  const idxRaw = req.body?.doc_index;
  const idx =
    idxRaw === undefined || idxRaw === null || idxRaw === ""
      ? null
      : Number(idxRaw);

  if (idx !== null && (!Number.isInteger(idx) || idx < 1 || idx > 20)) {
    return res.status(400).json({ error: "doc_index invalido" });
  }

  try {
    const r = await pool.query(
      `SELECT id, nombre_persona, correo_personal, estado, checks_completados, docs_firma, expires_at, solicitud_id, preregistro_id
       FROM tokens_firma_contrato WHERE id = $1`,
      [req.tokenFirma.token_id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Proceso no encontrado" });

    const row = r.rows[0];
    const docsFirma = await ensureTokenDocsFirmaPlan(row);
    const reconciled = await reconcileContratoDocsForProcess(
      { ...row, docs_firma: docsFirma },
      { docIndex: idx, reason: "endpoint" }
    );

    res.json({
      ok: true,
      nombre_persona: row.nombre_persona,
      estado: reconciled.estado,
      checks_completados: row.checks_completados,
      docs_firma: normalizeDocsFirmaListCompat(reconciled.docs_firma),
      expires_at: row.expires_at,
      changed: reconciled.changed,
      reconciled: reconciled.reconciled
    });
  } catch (err) {
    console.error("Error reconciliando firma de contrato:", err);
    res.status(500).json({ error: "Error reconciliando firma de contrato" });
  }
});

// GET /contratacion/docs-info ? lista de documentos estáticos (sin auth de archivo)
app.get("/contratacion/docs-info", requireTokenFirma, (req, res) => {
  res.json({
    docs: DOCS_ESTATICOS.map(d => ({ clave: d.clave, label: d.label, archivo: d.archivo, plantilla: !!d.plantilla, descarga_archivo: d.descarga_archivo || null })),
    form: { clave: FORM_DATOS_PERSONA.clave, label: FORM_DATOS_PERSONA.label },
    video_disponible: fs.existsSync(path.join(CONTRATOS_STATIC_DIR, VIDEO_BIENVENIDA))
  });
});

function normalizeEstadoCivilContratacion(value) {
  const key = normalizeTextKey(value);
  if (!key) return null;
  const map = new Map([
    ["soltero", "Soltero"],
    ["casado", "Casado"],
    ["unionlibre", "Unión libre"],
    ["separado", "Separado"],
    ["viudo", "Viudo"]
  ]);
  return map.get(key) || null;
}

function normalizeNonNegativeIntegerInput(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

async function getTokenFirmaProcesoPublico(db, tokenId, { forUpdate = false } = {}) {
  const suffix = forUpdate ? " FOR UPDATE" : "";
  const r = await db.query(
    `SELECT id, public_id, nombre_persona, correo_personal, estado, checks_completados, docs_firma, solicitud_id, preregistro_id
     FROM tokens_firma_contrato
     WHERE id = $1${suffix}`,
    [tokenId]
  );
  return r.rows[0] || null;
}

async function listContratacionPersonaCatalogos(db) {
  const [docsRes, modulosRes] = await Promise.all([
    db.query(`
      SELECT public_id::text AS id, titulo, codigo
      FROM documento_identidad
      WHERE activo = true
      ORDER BY
        CASE UPPER(COALESCE(codigo, ''))
          WHEN 'CC' THEN 1
          WHEN 'CE' THEN 2
          WHEN 'PA' THEN 3
          WHEN 'NIT' THEN 4
          WHEN 'OT' THEN 5
          ELSE 9
        END,
        titulo ASC
    `),
    db.query(`
      SELECT public_id::text AS id, titulo, nombre_completo
      FROM modulo
      WHERE activo = true
      ORDER BY titulo ASC
    `)
  ]);

  return {
    documentos_identidad: docsRes.rows || [],
    modulos: modulosRes.rows || [],
    estados_civiles: [...ESTADOS_CIVILES_CONTRATACION]
  };
}

async function getContratoPersonaBaseRecord(db, {
  usuarioId = null,
  numeroDocumento = null,
  correoPersonal = null,
  preregistroId = null
} = {}) {
  const userId = toNullableInteger(usuarioId);
  const documento = toNullableTrimmedString(numeroDocumento);
  const correo = toNullableTrimmedString(correoPersonal);
  const preId = toNullableInteger(preregistroId);
  if (!userId && !documento && !correo && !preId) return null;

  const r = await db.query(
    `
    WITH usuario_base AS (
      SELECT u.*
      FROM usuarios u
      WHERE
        ($1::int IS NOT NULL AND u.id = $1)
        OR ($2::text IS NOT NULL AND NULLIF(BTRIM(u.cedula), '') = $2)
        OR ($3::text IS NOT NULL AND LOWER(NULLIF(BTRIM(u.email), '')) = LOWER($3))
      ORDER BY
        CASE WHEN $1::int IS NOT NULL AND u.id = $1 THEN 0 ELSE 1 END,
        u.id DESC
      LIMIT 1
    ),
    persona_base AS (
      SELECT p.*
      FROM personas p
      LEFT JOIN usuario_base u ON TRUE
      WHERE
        ($4::int IS NOT NULL AND p.preregistro_id = $4)
        OR (u.persona_id IS NOT NULL AND p.id = u.persona_id)
        OR ($2::text IS NOT NULL AND NULLIF(BTRIM(p.numero_documento), '') = $2)
        OR ($3::text IS NOT NULL AND LOWER(NULLIF(BTRIM(p.correo_electronico), '')) = LOWER($3))
        OR (u.cedula IS NOT NULL AND NULLIF(BTRIM(p.numero_documento), '') = NULLIF(BTRIM(u.cedula), ''))
      ORDER BY
        CASE WHEN $4::int IS NOT NULL AND p.preregistro_id = $4 THEN 0 ELSE 1 END,
        CASE WHEN p.id = (SELECT persona_id FROM usuario_base LIMIT 1) THEN 0 ELSE 1 END,
        p.updated_at DESC NULLS LAST,
        p.id DESC
      LIMIT 1
    )
    SELECT
      u.id AS usuario_id,
      u.public_id::text AS usuario_public_id,
      u.persona_id AS usuario_persona_id,
      u.nombre_usuario,
      u.email AS usuario_email,
      u.cedula AS usuario_cedula,
      u.telefono AS usuario_telefono,
      u.direccion AS usuario_direccion,
      u.ciudad AS usuario_ciudad,
      u.tipo_persona AS usuario_tipo_persona,
      u.factura_en_colombia AS usuario_factura_en_colombia,
      di_u.public_id::text AS usuario_tipo_documento_public_id,
      di_u.titulo AS usuario_tipo_documento_titulo,
      di_u.codigo AS usuario_tipo_documento_codigo,

      p.id AS persona_id,
      p.public_id::text AS persona_public_id,
      p.numero_documento,
      p.tipo_documento_id,
      di_p.public_id::text AS tipo_documento_public_id,
      di_p.titulo AS tipo_documento_titulo,
      di_p.codigo AS tipo_documento_codigo,
      p.estado,
      p.nombre AS persona_nombre,
      p.apellidos AS persona_apellidos,
      p.fecha_nacimiento,
      p.sexo,
      p.lugar_nacimiento,
      p.lugar_expedicion,
      p.nacionalidad,
      p.estado_civil,
      p.numero_contacto,
      p.correo_electronico,
      p.direccion_residencia,
      p.barrio,
      p.ciudad_residencia,
      p.departamento_pais,
      p.pais_residencia,
      p.titulo_profesional,
      p.tipo_persona,
      p.factura_en_colombia,
      p.nombre_contacto_emergencia,
      p.telefono_contacto_emergencia,
      p.parentesco,
      p.hijos,
      p.edades_hijos,
      p.visa_paises,
      p.acepta_tratamiento_datos,
      p.eps,
      p.afp,
      p.arl,
      p.modulo_id,
      m.public_id::text AS modulo_public_id,
      m.titulo AS modulo_titulo,
      p.modulo_otro,
      p.cliente_id,
      p.preregistro_id
    FROM usuario_base u
    FULL JOIN persona_base p ON TRUE
    LEFT JOIN documento_identidad di_u ON di_u.id = u.tipo_documento_id
    LEFT JOIN documento_identidad di_p ON di_p.id = p.tipo_documento_id
    LEFT JOIN modulo m ON m.id = p.modulo_id
    LIMIT 1
    `,
    [userId || null, documento || null, correo || null, preId || null]
  );

  return r.rows[0] || null;
}

async function resolveModuloCatalogRecord(db, value) {
  const id = await resolveInternalIdFromPublicIdOrId(db, ID_TABLES.modulo, value);
  if (!id) return null;
  const r = await db.query(
    `SELECT id, public_id::text AS public_id, titulo
     FROM modulo
     WHERE id = $1 AND activo = true
     LIMIT 1`,
    [id]
  );
  return r.rows[0] || null;
}

async function resolveModuloForContratoPersonaForm(db, personaContext, baseRecord = null, explicitValue = null) {
  if (explicitValue) return resolveModuloCatalogRecord(db, explicitValue);
  if (baseRecord?.modulo_public_id || baseRecord?.modulo_id) {
    return {
      id: baseRecord.modulo_id || null,
      public_id: baseRecord.modulo_public_id || null,
      titulo: baseRecord.modulo_titulo || null
    };
  }

  const extra = parseJsonObject(personaContext?.datos_extra || {});
  const candidates = [extra.modulo_id, personaContext?.modulo_id];
  for (const candidate of candidates) {
    const resolved = await resolveModuloCatalogRecord(db, candidate);
    if (resolved) return resolved;
  }

  const nombre = toNullableTrimmedString(personaContext?.modulo_nombre) || toNullableTrimmedString(extra.modulo);
  if (!nombre) return null;
  const byName = await db.query(
    `SELECT id, public_id::text AS public_id, titulo
     FROM modulo
     WHERE activo = true AND LOWER(titulo) = LOWER($1)
     LIMIT 1`,
    [nombre]
  );
  return byName.rows[0] || null;
}

function buildContratoPersonaFormData(baseRecord, personaContext, moduloRef = null) {
  const ctx = personaContext || {};
  return {
    nombre: toNullableTrimmedString(baseRecord?.persona_nombre) || toNullableTrimmedString(ctx.nombre) || "",
    apellidos: toNullableTrimmedString(baseRecord?.persona_apellidos) || toNullableTrimmedString(ctx.apellidos) || "",
    fecha_nacimiento: normalizeDateOnlyInput(baseRecord?.fecha_nacimiento) || "",
    sexo: normalizeSexoContratacion(baseRecord?.sexo) || "",
    lugar_nacimiento: toNullableTrimmedString(baseRecord?.lugar_nacimiento) || "",
    tipo_documento_id:
      toNullableTrimmedString(baseRecord?.tipo_documento_public_id) ||
      toNullableTrimmedString(baseRecord?.usuario_tipo_documento_public_id) ||
      toNullableTrimmedString(ctx.tipoDocumentoPublicId) ||
      "",
    numero_documento:
      toNullableTrimmedString(baseRecord?.numero_documento) ||
      toNullableTrimmedString(ctx.numeroDocumento) ||
      toNullableTrimmedString(baseRecord?.usuario_cedula) ||
      "",
    lugar_expedicion: toNullableTrimmedString(baseRecord?.lugar_expedicion) || "",
    nacionalidad: toNullableTrimmedString(baseRecord?.nacionalidad) || "",
    estado_civil: normalizeEstadoCivilContratacion(baseRecord?.estado_civil) || "",
    direccion_residencia:
      toNullableTrimmedString(baseRecord?.direccion_residencia) ||
      toNullableTrimmedString(ctx.direccion) ||
      toNullableTrimmedString(baseRecord?.usuario_direccion) ||
      "",
    barrio: toNullableTrimmedString(baseRecord?.barrio) || "",
    ciudad_residencia:
      toNullableTrimmedString(baseRecord?.ciudad_residencia) ||
      toNullableTrimmedString(ctx.ciudad) ||
      toNullableTrimmedString(baseRecord?.usuario_ciudad) ||
      "",
    departamento_pais: toNullableTrimmedString(baseRecord?.departamento_pais) || "",
    pais_residencia:
      toNullableTrimmedString(baseRecord?.pais_residencia) ||
      toNullableTrimmedString(ctx.paisUbicacion) ||
      "",
    correo_electronico:
      toNullableTrimmedString(baseRecord?.correo_electronico) ||
      toNullableTrimmedString(ctx.correoPersonal) ||
      toNullableTrimmedString(baseRecord?.usuario_email) ||
      "",
    numero_contacto:
      toNullableTrimmedString(baseRecord?.numero_contacto) ||
      toNullableTrimmedString(ctx.telefono) ||
      toNullableTrimmedString(baseRecord?.usuario_telefono) ||
      "",
    titulo_profesional: toNullableTrimmedString(baseRecord?.titulo_profesional) || "",
    modulo_id: toNullableTrimmedString(moduloRef?.public_id) || "",
    modulo_otro:
      toNullableTrimmedString(baseRecord?.modulo_otro) ||
      (!moduloRef?.public_id ? toNullableTrimmedString(ctx.modulo_nombre) : null) ||
      "",
    eps: toNullableTrimmedString(baseRecord?.eps) || "",
    arl: toNullableTrimmedString(baseRecord?.arl) || "",
    afp: toNullableTrimmedString(baseRecord?.afp) || "",
    nombre_contacto_emergencia: toNullableTrimmedString(baseRecord?.nombre_contacto_emergencia) || "",
    parentesco: toNullableTrimmedString(baseRecord?.parentesco) || "",
    telefono_contacto_emergencia: toNullableTrimmedString(baseRecord?.telefono_contacto_emergencia) || "",
    hijos: normalizeNonNegativeIntegerInput(baseRecord?.hijos) ?? 0,
    edades_hijos: toNullableTrimmedString(baseRecord?.edades_hijos) || "",
    visa_paises: toNullableTrimmedString(baseRecord?.visa_paises) || "",
    acepta_tratamiento_datos: baseRecord?.acepta_tratamiento_datos === true
  };
}

function normalizeContratoPersonaFormPayload(body = {}) {
  const hijos = normalizeNonNegativeIntegerInput(body.hijos) ?? 0;
  const aceptaTratamiento = normalizeNullableBooleanInput(body.acepta_tratamiento_datos);
  return {
    nombre: toNullableTrimmedString(body.nombre),
    apellidos: toNullableTrimmedString(body.apellidos),
    fecha_nacimiento: normalizeDateOnlyInput(body.fecha_nacimiento),
    sexo: normalizeSexoContratacion(body.sexo),
    lugar_nacimiento: toNullableTrimmedString(body.lugar_nacimiento),
    tipo_documento_id: toNullableTrimmedString(body.tipo_documento_id),
    numero_documento: toNullableTrimmedString(body.numero_documento),
    lugar_expedicion: toNullableTrimmedString(body.lugar_expedicion),
    nacionalidad: toNullableTrimmedString(body.nacionalidad),
    estado_civil: normalizeEstadoCivilContratacion(body.estado_civil),
    direccion_residencia: toNullableTrimmedString(body.direccion_residencia),
    barrio: toNullableTrimmedString(body.barrio),
    ciudad_residencia: toNullableTrimmedString(body.ciudad_residencia),
    departamento_pais: toNullableTrimmedString(body.departamento_pais),
    pais_residencia: toNullableTrimmedString(body.pais_residencia),
    correo_electronico: toNullableTrimmedString(body.correo_electronico)?.toLowerCase() || null,
    numero_contacto: toNullableTrimmedString(body.numero_contacto),
    titulo_profesional: toNullableTrimmedString(body.titulo_profesional),
    modulo_id: toNullableTrimmedString(body.modulo_id),
    modulo_otro: toNullableTrimmedString(body.modulo_otro),
    eps: toNullableTrimmedString(body.eps),
    arl: toNullableTrimmedString(body.arl),
    afp: toNullableTrimmedString(body.afp),
    nombre_contacto_emergencia: toNullableTrimmedString(body.nombre_contacto_emergencia),
    parentesco: toNullableTrimmedString(body.parentesco),
    telefono_contacto_emergencia: toNullableTrimmedString(body.telefono_contacto_emergencia),
    hijos,
    edades_hijos: hijos && hijos > 0 ? toNullableTrimmedString(body.edades_hijos) : null,
    visa_paises: toNullableTrimmedString(body.visa_paises),
    acepta_tratamiento_datos: aceptaTratamiento
  };
}

function validateContratoPersonaFormData(data) {
  const missing = [];
  const requiredText = [
    ["nombre", "Nombres"],
    ["apellidos", "Apellidos"],
    ["tipo_documento_id", "Tipo de documento"],
    ["numero_documento", "Numero de documento"],
    ["correo_electronico", "Correo electronico personal"],
    ["titulo_profesional", "Profesion"]
  ];
  for (const [key, label] of requiredText) {
    if (!data[key]) missing.push(label);
  }
  if (!data.fecha_nacimiento) missing.push("Fecha de nacimiento");
  if (!data.sexo) missing.push("Sexo");
  if (data.sexo && !SEXOS_CONTRATACION.includes(data.sexo)) missing.push("Sexo valido");
  if (data.hijos > 0 && !data.edades_hijos) missing.push("Edades de los hijos");

  if (data.correo_electronico && !isValidEmailFormat(data.correo_electronico)) {
    missing.push("Correo electronico valido");
  }
  if (data.acepta_tratamiento_datos !== true) {
    missing.push("Autorizacion de tratamiento de datos");
  }

  return missing;
}

// GET /contratacion/datos-persona - datos precargados del formulario interno
app.get("/contratacion/datos-persona", requireTokenFirma, async (req, res) => {
  try {
    const proceso = await getTokenFirmaProcesoPublico(pool, req.tokenFirma.token_id);
    if (!proceso) return res.status(404).json({ error: "Proceso no encontrado" });
    if (proceso.estado !== "en_proceso") return res.status(400).json({ error: "Proceso no disponible para edicion" });

    const personaContext = await resolveContratoPersonaContext(proceso);
    const preregistroId = personaContext?.preregistro?.id || proceso.preregistro_id || null;
    const baseRecord = await getContratoPersonaBaseRecord(pool, {
      usuarioId: personaContext?.usuario_id || null,
      numeroDocumento: personaContext?.numeroDocumento || null,
      correoPersonal: personaContext?.correoPersonal || null,
      preregistroId
    });
    const moduloRef = await resolveModuloForContratoPersonaForm(pool, personaContext, baseRecord);
    const catalogos = await listContratacionPersonaCatalogos(pool);

    res.json({
      form: { clave: FORM_DATOS_PERSONA.clave, label: FORM_DATOS_PERSONA.label },
      datos: buildContratoPersonaFormData(baseRecord, personaContext, moduloRef),
      catalogos,
      check_completado: Boolean(proceso.checks_completados?.[FORM_DATOS_PERSONA.clave])
    });
  } catch (err) {
    console.error("Error cargando datos personales de contratacion:", err);
    res.status(500).json({ error: "Error cargando datos personales" });
  }
});

// POST /contratacion/datos-persona - guarda el formulario interno en personas
app.post("/contratacion/datos-persona", requireTokenFirma, async (req, res) => {
  const data = normalizeContratoPersonaFormPayload(req.body || {});
  const faltantes = validateContratoPersonaFormData(data);
  if (faltantes.length > 0) {
    return res.status(422).json({
      error: "Completa los datos personales requeridos antes de continuar",
      faltantes
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const proceso = await getTokenFirmaProcesoPublico(client, req.tokenFirma.token_id, { forUpdate: true });
    if (!proceso) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Proceso no encontrado" });
    }
    if (proceso.estado !== "en_proceso") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Proceso no disponible para edicion" });
    }

    const personaContext = await resolveContratoPersonaContext(proceso);
    const preregistroId = personaContext?.preregistro?.id || proceso.preregistro_id || null;
    let baseRecord = await getContratoPersonaBaseRecord(client, {
      usuarioId: personaContext?.usuario_id || null,
      numeroDocumento: personaContext?.numeroDocumento || null,
      correoPersonal: personaContext?.correoPersonal || null,
      preregistroId
    });
    if (!baseRecord?.persona_id && !baseRecord?.usuario_id) {
      baseRecord = await getContratoPersonaBaseRecord(client, {
        numeroDocumento: data.numero_documento,
        correoPersonal: data.correo_electronico,
        preregistroId
      });
    }

    const tipoDocumentoRef = await resolvePersonaReferenceOrThrow(client, ID_TABLES.documentoIdentidad, data.tipo_documento_id, "Tipo de documento");
    const moduloRef = data.modulo_id
      ? await resolveModuloCatalogRecord(client, data.modulo_id)
      : await resolveModuloForContratoPersonaForm(client, personaContext, baseRecord);
    if (data.modulo_id && !moduloRef) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Modulo no valido" });
    }

    const usuarioId = toNullableInteger(baseRecord?.usuario_id) || toNullableInteger(personaContext?.usuario_id) || null;
    const tipoPersonaNormalizada = normalizeTipoPersonaForUsuariosInput(personaContext?.tipoPersona);
    const facturaEnColombia = normalizeNullableBooleanInput(personaContext?.facturaEnColombia);
    const moduloOtro =
      data.modulo_otro ||
      (!moduloRef?.id ? toNullableTrimmedString(personaContext?.modulo_nombre) : null);
    const personaValues = [
      data.numero_documento,
      tipoDocumentoRef.id,
      data.nombre,
      data.apellidos,
      data.fecha_nacimiento,
      data.sexo,
      data.lugar_nacimiento,
      data.lugar_expedicion,
      data.nacionalidad,
      data.estado_civil,
      data.numero_contacto,
      data.correo_electronico,
      data.direccion_residencia,
      data.barrio,
      data.ciudad_residencia,
      data.departamento_pais,
      data.pais_residencia,
      data.titulo_profesional,
      tipoPersonaNormalizada,
      facturaEnColombia,
      data.eps,
      data.arl,
      data.afp,
      data.nombre_contacto_emergencia,
      data.parentesco,
      data.telefono_contacto_emergencia,
      data.hijos,
      data.edades_hijos,
      data.visa_paises,
      data.acepta_tratamiento_datos,
      moduloRef?.id || null,
      moduloOtro,
      personaContext?.clienteId || null,
      preregistroId || null
    ];

    let personaResult;
    if (baseRecord?.persona_id) {
      personaResult = await client.query(
        `
        UPDATE personas SET
          numero_documento              = $1,
          tipo_documento_id             = $2,
          nombre                        = $3,
          apellidos                     = $4,
          fecha_nacimiento              = $5,
          sexo                          = $6::tipo_sexo,
          lugar_nacimiento              = $7,
          lugar_expedicion              = $8,
          nacionalidad                  = $9,
          estado_civil                  = $10,
          numero_contacto               = $11,
          correo_electronico            = $12,
          direccion_residencia          = $13,
          barrio                        = $14,
          ciudad_residencia             = $15,
          departamento_pais             = $16,
          pais_residencia               = $17,
          titulo_profesional            = $18,
          tipo_persona                  = COALESCE($19::tipo_persona, tipo_persona),
          factura_en_colombia           = COALESCE($20, factura_en_colombia),
          eps                           = $21,
          arl                           = $22,
          afp                           = $23,
          nombre_contacto_emergencia    = $24,
          parentesco                    = $25,
          telefono_contacto_emergencia  = $26,
          hijos                         = $27,
          edades_hijos                  = $28,
          visa_paises                   = $29,
          acepta_tratamiento_datos      = $30,
          tratamiento_datos_aceptado_at = CASE WHEN $30 THEN COALESCE(tratamiento_datos_aceptado_at, NOW()) ELSE NULL END,
          modulo_id                     = COALESCE($31, modulo_id),
          modulo_otro                   = COALESCE($32, modulo_otro),
          cliente_id                    = COALESCE($33, cliente_id),
          preregistro_id                = COALESCE($34, preregistro_id),
          updated_at                    = NOW()
        WHERE id = $35
        RETURNING id, public_id::text AS public_id
        `,
        [...personaValues, baseRecord.persona_id]
      );
    } else {
      personaResult = await client.query(
        `
        INSERT INTO personas (
          numero_documento, tipo_documento_id, nombre, apellidos,
          fecha_nacimiento, sexo, lugar_nacimiento, lugar_expedicion, nacionalidad, estado_civil,
          numero_contacto, correo_electronico, direccion_residencia, barrio, ciudad_residencia,
          departamento_pais, pais_residencia, titulo_profesional, tipo_persona, factura_en_colombia,
          eps, arl, afp, nombre_contacto_emergencia, parentesco, telefono_contacto_emergencia,
          hijos, edades_hijos, visa_paises, acepta_tratamiento_datos, tratamiento_datos_aceptado_at,
          modulo_id, modulo_otro, cliente_id, preregistro_id, created_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6::tipo_sexo,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::tipo_persona,$20,
          $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
          CASE WHEN $30 THEN NOW() ELSE NULL END,
          $31,$32,$33,$34,$35
        )
        ON CONFLICT (numero_documento) DO UPDATE SET
          tipo_documento_id             = EXCLUDED.tipo_documento_id,
          nombre                        = EXCLUDED.nombre,
          apellidos                     = EXCLUDED.apellidos,
          fecha_nacimiento              = EXCLUDED.fecha_nacimiento,
          sexo                          = EXCLUDED.sexo,
          lugar_nacimiento              = EXCLUDED.lugar_nacimiento,
          lugar_expedicion              = EXCLUDED.lugar_expedicion,
          nacionalidad                  = EXCLUDED.nacionalidad,
          estado_civil                  = EXCLUDED.estado_civil,
          numero_contacto               = EXCLUDED.numero_contacto,
          correo_electronico            = EXCLUDED.correo_electronico,
          direccion_residencia          = EXCLUDED.direccion_residencia,
          barrio                        = EXCLUDED.barrio,
          ciudad_residencia             = EXCLUDED.ciudad_residencia,
          departamento_pais             = EXCLUDED.departamento_pais,
          pais_residencia               = EXCLUDED.pais_residencia,
          titulo_profesional            = EXCLUDED.titulo_profesional,
          tipo_persona                  = COALESCE(EXCLUDED.tipo_persona, personas.tipo_persona),
          factura_en_colombia           = COALESCE(EXCLUDED.factura_en_colombia, personas.factura_en_colombia),
          eps                           = EXCLUDED.eps,
          arl                           = EXCLUDED.arl,
          afp                           = EXCLUDED.afp,
          nombre_contacto_emergencia    = EXCLUDED.nombre_contacto_emergencia,
          parentesco                    = EXCLUDED.parentesco,
          telefono_contacto_emergencia  = EXCLUDED.telefono_contacto_emergencia,
          hijos                         = EXCLUDED.hijos,
          edades_hijos                  = EXCLUDED.edades_hijos,
          visa_paises                   = EXCLUDED.visa_paises,
          acepta_tratamiento_datos      = EXCLUDED.acepta_tratamiento_datos,
          tratamiento_datos_aceptado_at = CASE WHEN EXCLUDED.acepta_tratamiento_datos THEN COALESCE(personas.tratamiento_datos_aceptado_at, NOW()) ELSE NULL END,
          modulo_id                     = COALESCE(EXCLUDED.modulo_id, personas.modulo_id),
          modulo_otro                   = COALESCE(EXCLUDED.modulo_otro, personas.modulo_otro),
          cliente_id                    = COALESCE(EXCLUDED.cliente_id, personas.cliente_id),
          preregistro_id                = COALESCE(EXCLUDED.preregistro_id, personas.preregistro_id),
          updated_at                    = NOW()
        RETURNING id, public_id::text AS public_id
        `,
        [...personaValues, usuarioId]
      );
    }

    const personaId = personaResult.rows[0]?.id || null;
    if (usuarioId && personaId) {
      await client.query(
        `
        UPDATE usuarios SET
          persona_id          = COALESCE(persona_id, $1),
          tipo_documento_id   = $2,
          cedula              = $3,
          direccion           = $4,
          telefono            = $5,
          ciudad              = $6,
          tipo_persona        = COALESCE($7::tipo_persona, tipo_persona),
          factura_en_colombia = COALESCE($8, factura_en_colombia),
          updated_at          = NOW()
        WHERE id = $9
        `,
        [
          personaId,
          tipoDocumentoRef.id,
          data.numero_documento,
          data.direccion_residencia,
          data.numero_contacto,
          data.ciudad_residencia,
          tipoPersonaNormalizada,
          facturaEnColombia,
          usuarioId
        ]
      );
    }

    const checkRes = await client.query(
      `UPDATE tokens_firma_contrato
       SET checks_completados = jsonb_set(checks_completados, $1::text[], 'true', true),
           updated_at = NOW()
       WHERE id = $2
       RETURNING checks_completados`,
      [`{${FORM_DATOS_PERSONA.clave}}`, proceso.id]
    );

    await client.query("COMMIT");
    res.json({
      ok: true,
      persona_id: personaResult.rows[0]?.public_id || null,
      checks_completados: checkRes.rows[0]?.checks_completados || {},
      datos: data
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { });
    if (err.code === "23505") {
      return res.status(409).json({ error: "El numero de documento ya esta en uso por otra persona" });
    }
    if (err?.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Error guardando datos personales de contratacion:", err);
    res.status(500).json({ error: "Error guardando datos personales" });
  } finally {
    client.release();
  }
});

// GET /contratacion/video ? sirve video de bienvenida con soporte de rango (streaming)
// El token puede venir en header Authorization o en query param ?t= (necesario para <video src>)
app.get("/contratacion/video", (req, res) => {
  const auth = req.headers.authorization || "";
  const rawToken = (auth.startsWith("Bearer ") ? auth.slice(7) : null) || String(req.query.t || "");
  if (!rawToken) return res.status(401).send("Token requerido");
  try {
    const payload = jwt.verify(rawToken, JWT_SECRET);
    if (payload.tipo !== "firma_contrato") throw new Error("tipo inválido");
  } catch {
    return res.status(401).send("Token inválido o expirado");
  }

  const filePath = path.join(CONTRATOS_STATIC_DIR, VIDEO_BIENVENIDA);
  if (!fs.existsSync(filePath)) {
    return res.status(503).send("Video no disponible. Contacta a Talento Humano.");
  }

  // Permite reproducir el video cuando el front y el back están en distintos dominios.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4"
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes"
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// GET /contratacion/pdf/:nombre ? sirve PDF informativo estático
app.get("/contratacion/pdf/:nombre", requireTokenFirma, (req, res) => {
  const nombre = req.params.nombre;
  if (!ARCHIVOS_ESTATICOS_CONTRATACION.has(nombre)) {
    return res.status(404).json({ error: "Documento no encontrado" });
  }

  const filePath = path.join(CONTRATOS_STATIC_DIR, nombre);
  if (!fs.existsSync(filePath)) {
    return res.status(503).json({ error: "Documento aun no disponible. Contacta a Talento Humano." });
  }

  const ext = String(path.extname(nombre) || "").toLowerCase();
  let contentType = "application/octet-stream";
  if (ext === ".pdf") contentType = "application/pdf";
  if (ext === ".doc") contentType = "application/msword";
  if (ext === ".docx") contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  const dispositionType = ext === ".pdf" ? "inline" : "attachment";
  const safeName = sanitizeDownloadFileName(nombre, "documento.bin").replace(/"/g, "");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `${dispositionType}; filename="${safeName}"`);
  fs.createReadStream(filePath).pipe(res);
});

// PATCH /contratacion/check ? marca un documento estático como leído
// Acepta { clave: "politica_pago" } o el formato antiguo { numero: 1|2|3|4|5 }
app.patch("/contratacion/check", requireTokenFirma, async (req, res) => {
  const { clave: claveRaw, numero } = req.body || {};
  // Compatibilidad con formato antiguo {numero: 1|2|3|4|5}
  const key = claveRaw || (numero ? `pdf${numero}` : null);
  if (!key || !CLAVES_ESTATICAS_VALIDAS.has(key)) {
    return res.status(400).json({ error: "clave no válida" });
  }

  try {
    const r = await pool.query(
      `UPDATE tokens_firma_contrato
       SET checks_completados = jsonb_set(checks_completados, $1::text[], 'true', true),
           updated_at = NOW()
       WHERE id = $2 AND estado = 'en_proceso'
       RETURNING checks_completados`,
      [`{${key}}`, req.tokenFirma.token_id]
    );
    if (r.rowCount === 0) return res.status(400).json({ error: "No se pudo registrar el check" });
    res.json({ checks_completados: r.rows[0].checks_completados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error registrando check" });
  }
});

// GET /contratacion/docs-firma/:doc_index/pdf ? genera y descarga el PDF del documento a firmar
app.get("/contratacion/docs-firma/:doc_index/pdf", requireTokenFirma, async (req, res) => {
  const idx = Number(req.params.doc_index);
  if (!Number.isInteger(idx) || idx < 1 || idx > 20) {
    return res.status(400).json({ error: "doc_index invalido" });
  }

  try {
    const r = await pool.query(
      `SELECT id, nombre_persona, correo_personal, checks_completados, docs_firma, solicitud_id, preregistro_id
       FROM tokens_firma_contrato WHERE id = $1 AND estado = 'en_proceso'`,
      [req.tokenFirma.token_id]
    );
    if (r.rowCount === 0) return res.status(400).json({ error: "Proceso no valido o ya completado" });

    const proceso = r.rows[0];
    const checks = proceso.checks_completados || {};
    const faltantes = CLAVES_REQUERIDAS_FIRMA.filter(c => !checks[c]);
    if (faltantes.length > 0) {
      return res.status(400).json({ error: "Debes revisar todos los documentos informativos antes de descargar o firmar" });
    }

    let docsActuales = normalizeDocsFirmaListCompat(proceso.docs_firma);
    if (!docsActuales.length) {
      docsActuales = await ensureTokenDocsFirmaPlan(proceso);
    }
    const docExistente = docsActuales.find((d) => Number(d.doc_index) === idx);
    if (!docExistente) {
      return res.status(400).json({
        error: "doc_index no corresponde a un documento habilitado para este proceso"
      });
    }

    const personaContext = await resolveContratoPersonaContext(proceso);
    const docKey = docExistente.doc_key || LEGACY_DOC_INDEX_TO_KEY.get(idx) || null;
    const docDefinition = resolveContratoDocDefinitionForFirma(docKey, {
      facturaEnColombia: personaContext?.facturaEnColombia ?? null,
      doc: docExistente
    });
    if (!docDefinition) {
      return res.status(500).json({
        error: "No se encontro la CONFIGURACIÓN de plantilla para el documento solicitado",
        doc_index: idx,
        doc_key: docKey
      });
    }

    const personaSlug = sanitizePathSegment(
      (personaContext?.nombreCompleto || proceso.nombre_persona || "Contratista").replace(/\s+/g, "_"),
      "Contratista"
    );
    const payload = await buildContratoTemplatePayload({
      docDefinition,
      personaContext,
      proceso
    });
    const fileBaseName = `${personaSlug}_${docDefinition.doc_key}_${idx}`;
    const docxBuffer = renderDocxTemplateToBuffer({
      templateFile: docDefinition.template_file,
      data: payload
    });

    const outputBuffer = await convertDocxBufferToPdfBuffer(docxBuffer, fileBaseName);
    const outputContentType = "application/pdf";
    const outputExtension = "pdf";

    const baseName = sanitizePathSegment(
      `${docDefinition.titulo}_${personaSlug}`,
      `Contrato_${docDefinition.doc_key || idx}`
    );
    const fileName = sanitizeDownloadFileName(
      `${baseName}.${outputExtension}`,
      `Contrato_${docDefinition.doc_key || idx}.${outputExtension}`
    ).replace(/"/g, "");

    res.setHeader("Content-Type", outputContentType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(outputBuffer);
  } catch (err) {
    console.error("Error descargando PDF de contrato:", err);
    const errMessage = String(err?.message || "");
    if (Number(err?.status || 0) === 422) {
      return res.status(422).json({ error: errMessage || "No fue posible generar el documento solicitado" });
    }
    if (isDocxTemplateFailureMessage(errMessage)) {
      return res.status(422).json({
        error: "No fue posible generar la vista previa porque la plantilla del documento tiene marcadores invalidos. Contacta a Talento Humano."
      });
    }
    if (isDocxInfraFailureMessage(errMessage)) {
      return res.status(503).json({
        error: "No fue posible generar el PDF del contrato. Verifica la configuracion de Adobe PDF Services y dependencias DOCX (pizzip/docxtemplater).",
        detalle: errMessage || "Sin detalle tecnico"
      });
    }
    return res.status(500).json({ error: "Error generando PDF del documento de firma" });
  }
});

// POST /contratacion/firmar ? inicia proceso ClickSign para un doc de firma
app.post("/contratacion/firmar", requireTokenFirma, async (req, res) => {
  const { doc_index } = req.body || {};
  const idx = Number(doc_index);
  if (!Number.isInteger(idx) || idx < 1 || idx > 20) {
    return res.status(400).json({ error: "doc_index invalido" });
  }

  if (!isClickSignConfigured({ forContratos: true })) {
    return res.status(503).json({ error: "Click&Sign no está configurado en el servidor" });
  }

  try {
    const r = await pool.query(
      `SELECT id, nombre_persona, correo_personal, checks_completados, docs_firma, solicitud_id, preregistro_id
       FROM tokens_firma_contrato WHERE id = $1 AND estado = 'en_proceso'`,
      [req.tokenFirma.token_id]
    );
    if (r.rowCount === 0) return res.status(400).json({ error: "Proceso no válido o ya completado" });

    const proceso = r.rows[0];
    const checks = proceso.checks_completados || {};
    const faltantes = CLAVES_REQUERIDAS_FIRMA.filter(c => !checks[c]);
    if (faltantes.length > 0) {
      return res.status(400).json({ error: "Debes revisar todos los documentos informativos antes de firmar" });
    }

    let docsActuales = normalizeDocsFirmaListCompat(proceso.docs_firma);
    if (!docsActuales.length) {
      docsActuales = await ensureTokenDocsFirmaPlan(proceso);
    }

    const docExistente = docsActuales.find((d) => Number(d.doc_index) === idx);
    if (!docExistente) {
      return res.status(400).json({
        error: "doc_index no corresponde a un documento habilitado para este proceso",
        documentos_habilitados: docsActuales.map((d) => ({
          doc_index: d.doc_index,
          doc_key: d.doc_key || null,
          titulo: d.titulo || null,
          estado: d.estado || "pending"
        }))
      });
    }

    const estadoActualDoc = normalizeDocStatus(docExistente.estado);
    if (estadoActualDoc === "signed") {
      return res.status(409).json({
        error: "Este documento ya fue firmado",
        doc_index: idx,
        doc_key: docExistente.doc_key || null,
        estado: "signed"
      });
    }

    const personaContext = await resolveContratoPersonaContext(proceso);
    const docKey = docExistente.doc_key || LEGACY_DOC_INDEX_TO_KEY.get(idx) || null;
    const docDefinition = resolveContratoDocDefinitionForFirma(docKey, {
      facturaEnColombia: personaContext?.facturaEnColombia ?? null,
      doc: docExistente
    });
    if (!docDefinition) {
      return res.status(500).json({
        error: "No se encontró la CONFIGURACIÓN de plantilla para el documento solicitado",
        doc_index: idx,
        doc_key: docKey
      });
    }

    if (docExistente?.request_id && docExistente?.url_firma && estadoActualDoc === "pending") {
      return res.json({
        url_firma: docExistente.url_firma,
        request_id: docExistente.request_id || null,
        doc_index: idx,
        doc_key: docDefinition.doc_key,
        ya_iniciado: true
      });
    }

    const personaSlug = sanitizePathSegment(
      (personaContext?.nombreCompleto || proceso.nombre_persona || "Contratista").replace(/\s+/g, "_"),
      "Contratista"
    );
    const pdfBuffer = await generateContratoPdfFromTemplate({
      docDefinition,
      personaContext,
      proceso,
      fileBaseName: `${personaSlug}_${docDefinition.doc_key}_${idx}`
    });

    // Llamar a ClickSign API siguiendo el mismo flujo START_SIGNATURE de cuentas de cobro.
    const pdfBase64 = pdfBuffer.toString("base64");
    const docTitulo = `${docDefinition.titulo}_${personaSlug}`;
    const publicIdToken = req.tokenFirma.token_public_id;
    const tokenRef = publicIdToken || String(req.tokenFirma.token_id || "token");
    const requestId = `CF-${tokenRef}-${docDefinition.doc_key}-${Date.now()}`;
    const contractId = `contrato_${tokenRef}_${docDefinition.doc_key}_${idx}`;
    const signatoryExternalId = String(req.tokenFirma.token_id || req.tokenFirma.token_public_id || idx || Date.now());
    const fileName = sanitizePdfFileName(
      `${docTitulo}.pdf`,
      `Contrato_${docDefinition.doc_key}_${idx}.pdf`
    );

    const clicksignPayload = {
      request: "START_SIGNATURE",
      request_id: requestId,
      user: CLICKSIGN_USER,
      signature: {
        config_id: CLICKSIGN_CONTRATOS_CONFIG_ID,
        contract_id: contractId,
        title: docTitulo,
        level: [
          {
            level_order: 0,
            required_signatories_to_complete_level: 1,
            signatories: [
              {
                email: proceso.correo_personal,
                name: proceso.nombre_persona || proceso.correo_personal,
                external_id: signatoryExternalId
              }
            ]
          }
        ],
        file: [
          {
            filename: fileName,
            content: pdfBase64,
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
      clicksignPayload.signature.signature_cb_url = signatureCbUrl;
    }
    if (signatoryCbUrl) {
      clicksignPayload.signature.signatory_cb_url = signatoryCbUrl;
    }
    if (signatoryEmailCbUrl) {
      clicksignPayload.signature.signatory_email_cb_url = signatoryEmailCbUrl;
    }

    let clicksignRes = null;
    try {
      clicksignRes = await jsonRequest({
        method: "POST",
        url: buildClickSignUrl("start_signature"),
        headers: buildClickSignAuthHeaders(),
        body: clicksignPayload
      });
    } catch (clickSignErr) {
      return res.status(502).json({
        error: "Error al iniciar firma en Click&Sign",
        detalle: clickSignErr?.response || clickSignErr?.message || "Error desconocido",
        http_status: Number(clickSignErr?.status || 0) || null
      });
    }

    const clicksignBody =
      clicksignRes?.data && typeof clicksignRes.data === "object"
        ? clicksignRes.data
        : {};
    const urlFirma = getClickSignLandingUrl(clicksignBody);
    const responseRequestId = pickStringByPaths(clicksignBody, [
      "request_id",
      "data.request_id",
      "signature.request_id",
      "request.id",
      "data.request.id",
      "result.request_id",
      "result.request.id"
    ]);
    const resolvedRequestId = responseRequestId || requestId;
    const signatureId = extractClickSignSignatureId(clicksignBody);
    if (!urlFirma) {
      return res.status(502).json({
        error: "Click&Sign no devolvio URL de firma.",
        detalle: clicksignBody,
        request_id: resolvedRequestId || null,
        doc_index: idx,
        doc_key: docDefinition.doc_key
      });
    }

    const docEntry = {
      ...docExistente,
      doc_index: idx,
      doc_key: docDefinition.doc_key,
      titulo: docDefinition.titulo,
      template_file: docDefinition.template_file,
      empresa_key: docDefinition.empresa_key || null,
      request_id: resolvedRequestId || null,
      contract_id: contractId,
      signature_id: signatureId || null,
      estado: "pending",
      url_firma: urlFirma || null,
      iniciado_en: new Date().toISOString()
    };

    const nuevaLista = upsertDocFirmaEntry(docsActuales, docEntry, {
      facturaEnColombia: personaContext?.facturaEnColombia ?? null
    });
    await pool.query(
      `UPDATE tokens_firma_contrato SET docs_firma = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(nuevaLista), req.tokenFirma.token_id]
    );

    res.json({
      url_firma: urlFirma || null,
      request_id: resolvedRequestId || null,
      signature_id: signatureId || null,
      doc_index: idx,
      doc_key: docDefinition.doc_key
    });
  } catch (err) {
    console.error("Error iniciando firma de contrato:", err);
    const errMessage = String(err?.message || "");
    if (Number(err?.status || 0) === 422) {
      return res.status(422).json({ error: errMessage || "No fue posible iniciar la firma del documento" });
    }
    if (isDocxTemplateFailureMessage(errMessage)) {
      return res.status(422).json({
        error: "No fue posible iniciar la firma porque la plantilla del documento tiene marcadores invalidos. Contacta a Talento Humano."
      });
    }
    if (isDocxInfraFailureMessage(errMessage)) {
      return res.status(503).json({
        error: "No fue posible generar el PDF del contrato. Verifica la configuracion de Adobe PDF Services y dependencias DOCX (pizzip/docxtemplater).",
        detalle: errMessage || "Sin detalle tecnico"
      });
    }
    res.status(500).json({ error: "Error iniciando proceso de firma" });
  }
});

app.use(require("./routes/health.routes"));

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
    const [
      consultorInternalId,
      clienteInternalId,
      moduloInternalId,
      tipoAsignacionInternalId
    ] = await Promise.all([
      resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.usuarios, consultor_id),
      resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.clientes, cliente_id),
      modulo_id
        ? resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.modulo, modulo_id)
        : Promise.resolve(null),
      tipo_asignacion_id
        ? resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.tipoAsignacion, tipo_asignacion_id)
        : Promise.resolve(null)
    ]);

    if (!consultorInternalId) {
      return res.status(404).json({ error: "Consultor no encontrado o inválido" });
    }
    if (!clienteInternalId) {
      return res.status(404).json({ error: "Cliente no encontrado o inválido" });
    }
    if (modulo_id && !moduloInternalId) {
      return res.status(404).json({ error: "Módulo no encontrado o inválido" });
    }
    if (tipo_asignacion_id && !tipoAsignacionInternalId) {
      return res.status(404).json({ error: "Tipo de asignación no encontrado o inválido" });
    }

    const result = await pool.query(
      `
      SELECT COALESCE(
        (
          SELECT tc.valor_tarifa
          FROM tarifa_consultor tc
          WHERE tc.consultor_id = $1
            AND tc.id_cliente = $2
            AND ($3::int IS NULL OR tc.modulo_id = $3::int)
            AND ($4::int IS NULL OR tc.id_tipo_asignacion = $4::int)
            AND tc.activo = true
            AND (tc.vigencia_hasta IS NULL OR tc.vigencia_hasta >= CURRENT_DATE)
          ORDER BY tc.vigencia_desde DESC
          LIMIT 1
        ),
        0
      ) AS valor_tarifa
      `,
      [
        consultorInternalId,
        clienteInternalId,
        moduloInternalId,
        tipoAsignacionInternalId
      ]
    );

    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "No se encontraron referencias para calcular tarifa" });
    }
    console.error("Error en GET /tarifa-consultor", {
      consultor_id,
      cliente_id,
      modulo_id,
      tipo_asignacion_id,
      message: err?.message,
      code: err?.code
    });
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

    const [
      clienteInternalId,
      consultorInternalId,
      moduloInternalId,
      tipoAsignacionInternalId
    ] = await Promise.all([
      resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.clientes, cliente_id),
      resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.usuarios, consultor_id),
      modulo_id
        ? resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.modulo, modulo_id)
        : Promise.resolve(null),
      resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.tipoAsignacion, tipo_asignacion_id)
    ]);

    if (!clienteInternalId) {
      return res.status(404).json({ error: "Cliente no encontrado o inválido" });
    }
    if (!consultorInternalId) {
      return res.status(404).json({ error: "Consultor no encontrado o inválido" });
    }
    if (modulo_id && !moduloInternalId) {
      return res.status(404).json({ error: "Módulo no encontrado o inválido" });
    }
    if (!tipoAsignacionInternalId) {
      return res.status(404).json({ error: "Tipo de asignación no encontrado o inválido" });
    }

    // Inserción atómica: solo inserta si no existe tarifa VIGENTE con la misma combinación.
    // El WHERE NOT EXISTS + el índice único parcial en BD garantizan atomicidad real.
    const ins = await pool.query(
      `INSERT INTO tarifa_consultor (id_cliente, consultor_id, modulo_id, id_tipo_asignacion, valor_tarifa, activo)
       SELECT $1, $2, $3, $4, $5, true
       WHERE NOT EXISTS (
         SELECT 1 FROM tarifa_consultor
         WHERE id_cliente = $1 AND consultor_id = $2
           AND (modulo_id = $3 OR (modulo_id IS NULL AND $3::int IS NULL))
           AND id_tipo_asignacion = $4
           AND activo = true
           AND (vigencia_hasta IS NULL OR vigencia_hasta >= CURRENT_DATE)
       )
       RETURNING id`,
      [clienteInternalId, consultorInternalId, moduloInternalId, tipoAsignacionInternalId, valor]
    );
    if (ins.rowCount === 0) {
      return res.status(409).json({ error: "Ya existe una tarifa vigente para esta combinación de consultor, cliente, módulo y tipo de asignación." });
    }

    const result = await pool.query(
      `SELECT
         tc.public_id AS id,
         c.public_id  AS cliente_id,
         u.public_id  AS consultor_id,
         m.public_id  AS modulo_id,
         ta.public_id AS tipo_asignacion_id,
         tc.valor_tarifa AS valor,
         tc.activo,
         c.titulo         AS nombre_cliente,
         u.nombre_usuario AS nombre_consultor,
         m.titulo         AS nombre_modulo,
         ta.titulo        AS tipo_asignacion,
         u.moneda_cobro   AS moneda
       FROM tarifa_consultor tc
       JOIN clientes c ON c.id = tc.id_cliente
       JOIN usuarios u ON u.id = tc.consultor_id
       LEFT JOIN modulo m ON m.id = tc.modulo_id
       LEFT JOIN tipo_asignacion ta ON ta.id = tc.id_tipo_asignacion
       WHERE tc.id = $1`,
      [ins.rows[0].id]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: "Cliente, consultor o tipo de asignación no válido" });
    }

    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: "Ya existe una tarifa vigente para esta combinación de consultor, cliente, módulo y tipo de asignación." });
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
    if (!cliente_id || !consultor_id || !tipo_asignacion_id || !valor) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const [
      tarifaInternalId,
      clienteInternalId,
      consultorInternalId,
      moduloInternalId,
      tipoAsignacionInternalId
    ] = await Promise.all([
      resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.tarifaConsultor, id),
      resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.clientes, cliente_id),
      resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.usuarios, consultor_id),
      modulo_id
        ? resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.modulo, modulo_id)
        : Promise.resolve(null),
      resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.tipoAsignacion, tipo_asignacion_id)
    ]);

    if (!tarifaInternalId) {
      return res.status(404).json({ error: "Tarifa no encontrada" });
    }
    if (!clienteInternalId) {
      return res.status(404).json({ error: "Cliente no encontrado o inválido" });
    }
    if (!consultorInternalId) {
      return res.status(404).json({ error: "Consultor no encontrado o inválido" });
    }
    if (modulo_id && !moduloInternalId) {
      return res.status(404).json({ error: "Módulo no encontrado o inválido" });
    }
    if (!tipoAsignacionInternalId) {
      return res.status(404).json({ error: "Tipo de asignación no encontrado o inválido" });
    }

    // Actualización atómica: solo actualiza si no existe OTRA tarifa vigente con la misma combinación.
    const upd = await pool.query(
      `UPDATE tarifa_consultor
       SET id_cliente = $1,
           consultor_id = $2,
           modulo_id = $3,
           id_tipo_asignacion = $4,
           valor_tarifa = $5
       WHERE id = $6
         AND NOT EXISTS (
           SELECT 1 FROM tarifa_consultor
           WHERE id_cliente = $1 AND consultor_id = $2
             AND (modulo_id = $3 OR (modulo_id IS NULL AND $3::int IS NULL))
             AND id_tipo_asignacion = $4
             AND activo = true
             AND id <> $6
             AND (vigencia_hasta IS NULL OR vigencia_hasta >= CURRENT_DATE)
         )
       RETURNING id`,
      [clienteInternalId, consultorInternalId, moduloInternalId, tipoAsignacionInternalId, valor, tarifaInternalId]
    );

    if (upd.rowCount === 0) {
      const exists = await pool.query(`SELECT 1 FROM tarifa_consultor WHERE id = $1 LIMIT 1`, [tarifaInternalId]);
      if (exists.rowCount === 0) {
        return res.status(404).json({ error: "Tarifa no encontrada" });
      }
      return res.status(409).json({ error: "Ya existe una tarifa vigente para esta combinación de consultor, cliente, módulo y tipo de asignación." });
    }

    // Recalcular asignaciones activas de tipo Full time / Part Time que usen esta tarifa
    await pool.query(
      `UPDATE registro_asignaciones ra
       SET valor_hora  = $1,
           valor_dia   = $1 / 20.0,
           total_pagar = CASE
             WHEN ra.cantidad_dias IS NOT NULL AND ra.cantidad_dias > 0
               THEN ($1 / 20.0) * ra.cantidad_dias
             ELSE ra.total_pagar
           END,
           updated_at  = NOW()
       FROM consultorias con
       JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
       WHERE ra.id_consultoria         = con.id
         AND con.id_cliente              = $2
         AND ra.consultor_responsable_id = $3
         AND (($4::int IS NULL AND ra.id_modulo IS NULL) OR ra.id_modulo = $4)
         AND con.id_tipo_asignacion      = $5
         AND ra.estado IN ('Abierto', 'Proceso')
         AND ra.es_costo_total           = false
         AND LOWER(ta.titulo) IN ('full time', 'part time')`,
      [valor, clienteInternalId, consultorInternalId, moduloInternalId, tipoAsignacionInternalId]
    );

    const result = await pool.query(
      `SELECT
         tc.public_id AS id,
         c.public_id  AS cliente_id,
         u.public_id  AS consultor_id,
         m.public_id  AS modulo_id,
         ta.public_id AS tipo_asignacion_id,
         tc.valor_tarifa AS valor,
         tc.activo,
         c.titulo         AS nombre_cliente,
         u.nombre_usuario AS nombre_consultor,
         m.titulo         AS nombre_modulo,
         ta.titulo        AS tipo_asignacion,
         u.moneda_cobro   AS moneda
       FROM tarifa_consultor tc
       JOIN clientes c ON c.id = tc.id_cliente
       JOIN usuarios u ON u.id = tc.consultor_id
       LEFT JOIN modulo m ON m.id = tc.modulo_id
       LEFT JOIN tipo_asignacion ta ON ta.id = tc.id_tipo_asignacion
       WHERE tc.id = $1`,
      [tarifaInternalId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: "Ya existe una tarifa vigente para esta combinación de consultor, cliente, módulo y tipo de asignación." });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar tarifa" });
  }
});

// Eliminar tarifa (soft delete)
app.delete("/tarifas/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      WITH c_tarifa AS (SELECT id FROM tarifa_consultor WHERE public_id = $1)
      UPDATE tarifa_consultor 
      SET activo = false 
      WHERE id = (SELECT id FROM c_tarifa)
      RETURNING id
    `, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Tarifa no encontrada" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar tarifa" });
  }
});

/* ===============================
   API - MIS ASIGNACIONES (COORDINADOR)
=============================== */

// Listar asignaciones activas para coordinador
app.get("/mis-asignaciones-coordinador", requireAccess({ roles: ["Coordinador"] }), async (req, res) => {
  try {
    const userId = req.user?.id || null;

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
        ra.es_costo_total,
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
        AND con.coordinador_responsable_id = $1::int
      ORDER BY ra.id DESC
    `, [userId]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener asignaciones" });
  }
});

// Listar asignaciones activas para consultor
app.get("/mis-asignaciones", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const esConsultorPrincipal = normalizeValue(req.user?.rol) === "consultor principal";

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
        ra.es_costo_total,
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
        ra.consultor_responsable_id = $1::int
        OR (
          $2::boolean = true
          AND ra.consultor_responsable_id IN (
            SELECT u.id
            FROM usuarios u
            WHERE u.activo = true
              AND u.id_consultor_principal = $1::int
          )
        )
      )
      ORDER BY ra.id DESC
    `, [userId, esConsultorPrincipal]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener asignaciones" });
  }
});

// Asignaciones disponibles para registro de horas (consultor)
app.get("/registro-horas-asignaciones", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  try {
    const { consultor_id } = req.query;
    const userId = req.user?.id || null;
    const estados = await getEstadoAsignacionValues();

    const result = await pool.query(`
      WITH 
        c_consultor AS (SELECT id, id_consultor_principal FROM usuarios WHERE public_id::text = $1::text OR (id = $2::int AND $1::text IS NULL))
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
        ra.es_costo_total,
        CASE
          WHEN ra.horas_asignadas IS NULL THEN NULL
          WHEN (
            LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempo y costo fijo%'
            OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempoycostofijo%'
          ) THEN GREATEST(ra.horas_asignadas - COALESCE(uso.horas_comprometidas, 0), 0)
          ELSE GREATEST(ra.horas_asignadas - COALESCE(uso.horas_aprobadas, 0), 0)
        END AS horas_disponibles,
        CASE
          WHEN ra.cantidad_dias IS NULL THEN NULL
          WHEN (
            LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempo y costo fijo%'
            OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempoycostofijo%'
          ) THEN GREATEST(ra.cantidad_dias - COALESCE(uso.dias_comprometidos, 0), 0)
          ELSE GREATEST(ra.cantidad_dias - COALESCE(uso.dias_aprobados, 0), 0)
        END AS dias_disponibles,
        CASE
          WHEN COALESCE(ra.es_costo_total, false) = false OR ra.total_pagar IS NULL THEN NULL
          WHEN (
            LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempo y costo fijo%'
            OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempoycostofijo%'
          ) THEN GREATEST(ra.total_pagar - COALESCE(uso.total_comprometido, 0), 0)
          ELSE GREATEST(ra.total_pagar - COALESCE(uso.total_aprobado, 0), 0)
        END AS total_disponible,
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
        lr.motivo_rechazo,
        COALESCE(uso.reportes_pendientes, 0) AS reportes_pendientes
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        JOIN clientes c ON con.id_cliente = c.id
        LEFT JOIN usuarios coord ON con.coordinador_responsable_id = coord.id
        LEFT JOIN modulo m ON ra.id_modulo = m.id
        LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
        LEFT JOIN LATERAL (
          SELECT rh.estado_reporte, rh.motivo_rechazo, rh.id_cuenta_cobro
          FROM reporte_horas rh
          WHERE rh.id_registro_asignacion = ra.id
          ORDER BY rh.created_at DESC
          LIMIT 1
        ) lr ON true
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(CASE WHEN rh.estado_reporte = 'Aprobado' THEN rh.horas_reportadas ELSE 0 END), 0) AS horas_aprobadas,
            COALESCE(SUM(CASE WHEN rh.estado_reporte = 'Aprobado' THEN rh.cantidad_dias_reportados ELSE 0 END), 0) AS dias_aprobados,
            COALESCE(SUM(CASE WHEN rh.estado_reporte = 'Aprobado' THEN rh.total_cobrar ELSE 0 END), 0) AS total_aprobado,
            COALESCE(SUM(CASE WHEN rh.estado_reporte <> 'Rechazado' THEN rh.horas_reportadas ELSE 0 END), 0) AS horas_comprometidas,
            COALESCE(SUM(CASE WHEN rh.estado_reporte <> 'Rechazado' THEN rh.cantidad_dias_reportados ELSE 0 END), 0) AS dias_comprometidos,
            COALESCE(SUM(CASE WHEN rh.estado_reporte <> 'Rechazado' THEN rh.total_cobrar ELSE 0 END), 0) AS total_comprometido,
            COUNT(*) FILTER (WHERE rh.estado_reporte = 'Pendiente')::int AS reportes_pendientes
          FROM reporte_horas rh
          WHERE rh.id_registro_asignacion = ra.id
        ) uso ON true
      WHERE (
        ($1::text IS NULL AND $2::int IS NULL)
        OR ra.consultor_responsable_id = (SELECT id FROM c_consultor)
        OR ra.consultor_responsable_id IN (
          SELECT u.id
          FROM usuarios u
          WHERE u.activo = true
            AND u.id_consultor_principal = (SELECT id FROM c_consultor)
        )
      )
        AND (
          LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempo y costo fijo%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempoycostofijo%'
          OR
          lr.estado_reporte IS NULL
          OR lr.estado_reporte = 'Rechazado'
          OR lr.estado_reporte = 'Aprobado'
        )
        AND ra.estado IN ($3::tipo_estado_asignacion, $4::tipo_estado_asignacion)
        AND NOT (
          COALESCE(con.id_tipo_asignacion, 0) IN (5, 6)
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%mesa%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%service desk%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%servicedesk%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%fabrica%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%fábrica%'
        )
        AND (
          LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%horas por demanda%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%horaspordemanda%'
          OR (
            COALESCE(ra.es_costo_total, false) = true
            AND (
              ra.total_pagar IS NOT NULL
              AND ra.total_pagar > COALESCE(
                CASE
                  WHEN (
                    LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempo y costo fijo%'
                    OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempoycostofijo%'
                  ) THEN uso.total_comprometido
                  ELSE uso.total_aprobado
                END,
                0
              )
            )
          )
          OR (
            (
              LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%full%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%part%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%mensual%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempo completo%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempocompleto%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%medio tiempo%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%mediotiempo%'
            )
            AND COALESCE(ra.es_costo_total, false) = false
            AND (ra.cantidad_dias IS NULL OR ra.cantidad_dias > COALESCE(uso.dias_aprobados, 0))
          )
          OR (
            (
              LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempo y costo fijo%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempoycostofijo%'
            )
            AND COALESCE(ra.es_costo_total, false) = false
            AND (ra.horas_asignadas IS NULL OR ra.horas_asignadas > COALESCE(uso.horas_comprometidas, 0))
          )
          OR (
            COALESCE(ra.es_costo_total, false) = false
            AND
            NOT (
              LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%full%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%part%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%mensual%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempo completo%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempocompleto%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%medio tiempo%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%mediotiempo%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempo y costo fijo%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%tiempoycostofijo%'
            )
            AND (ra.horas_asignadas IS NULL OR ra.horas_asignadas > COALESCE(uso.horas_aprobadas, 0))
          )
        )
      ORDER BY ra.id DESC
    `, [consultor_id || null, userId, estados.abierto, estados.proceso]);
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
    const horasReportadasInput = toNullableNumber(horas_reportadas);
    const diasReportadosInput = toNullableNumber(cantidad_dias_reportados);
    const totalCobrarNum = toNullableNumber(total_cobrar);

    if (!id_registro_asignacion) {
      return res.status(400).json({ error: "Falta id_registro_asignacion" });
    }

    const metaConsulta = await pool.query(
      `
      WITH c_asignacion AS (SELECT id FROM registro_asignaciones WHERE public_id = $1)
      SELECT
        ra.id,
        ra.estado AS estado_asignacion,
        ra.id_modulo,
        ra.horas_asignadas,
        ra.cantidad_dias,
        ra.valor_hora,
        ra.valor_dia,
        ra.total_pagar,
        ra.es_costo_total,
        ra.consultor_responsable_id,
        con.id_cliente,
        con.id_tipo_asignacion,
        con.coordinador_responsable_id,
        ta.titulo AS tipo_asignacion_titulo,
        ur.ultimo_reporte_id,
        ur.ultimo_reporte_estado
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
        LEFT JOIN LATERAL (
          SELECT
            rh.id AS ultimo_reporte_id,
            rh.estado_reporte AS ultimo_reporte_estado
          FROM reporte_horas rh
          WHERE rh.id_registro_asignacion = ra.id
          ORDER BY rh.updated_at DESC NULLS LAST, rh.id DESC
          LIMIT 1
        ) ur ON true
      WHERE ra.id = (SELECT id FROM c_asignacion)
      `,
      [id_registro_asignacion]
    );

    if (metaConsulta.rows.length === 0) {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }

    const info = metaConsulta.rows[0];
    const registroAsignacionId = info.id;
    if (!info.consultor_responsable_id) {
      return res.status(400).json({ error: "La asignación no tiene consultor responsable." });
    }
    if (req.user?.id) {
      const permiso = await pool.query(
        `SELECT 1
         FROM usuarios u
         WHERE u.id = $1
           AND (u.id = $2 OR u.id_consultor_principal = $2)
         LIMIT 1`,
        [info.consultor_responsable_id, req.user.id]
      );
      if (permiso.rows.length === 0) {
        return res.status(403).json({ error: "No tienes permisos para reportar esta asignación" });
      }
    }
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
    const esMesaOFabrica = Boolean(
      getMesaFabricaScope(tipoAsignacionId, tipoAsignacionTitulo, info)
    );
    if (esMesaOFabrica) {
      return res.status(400).json({
        error: "Las asignaciones de Mesa/Fábrica se registran en el módulo de Mesa/Fábrica, no en Registro Horas."
      });
    }

    const esMensual =
      isTipoAsignacionMensual(tipoAsignacionTitulo);
    const esTiempoCostoFijo = isTipoAsignacionTiempoCostoFijo(tipoAsignacionTitulo);
    const permitirParcialesAcumulados = esTiempoCostoFijo;
    const esCostoTotal = esTiempoCostoFijo && toBooleanInput(info.es_costo_total, false);
    const esHorasPorDemanda = isTipoAsignacionHorasPorDemanda(tipoAsignacionTitulo);
    const ultimoReporteId = Number(info.ultimo_reporte_id || 0) || null;
    const ultimoReporteEstado = String(info.ultimo_reporte_estado || "").trim() || null;
    if (!permitirParcialesAcumulados && ultimoReporteEstado === "Pendiente") {
      return res.status(400).json({ error: "Ya hay un reporte pendiente para esta asignación" });
    }
    let cantidadSolicitada = 0;
    let horasReportadasFinal = 0;
    let diasReportadosFinal = 0;
    let totalCobrarFinal = totalCobrarNum;

    if (esCostoTotal) {
      const totalAsignado = toNullableNumber(info.total_pagar);
      if (totalAsignado === null) {
        return res.status(400).json({ error: "La asignación no tiene presupuesto total configurado." });
      }
      cantidadSolicitada = Number(totalCobrarNum || 0);
      if (!(cantidadSolicitada > 0)) {
        return res.status(400).json({ error: "Debes reportar un valor mayor a 0 para costo total" });
      }
      totalCobrarFinal = Math.round((cantidadSolicitada + Number.EPSILON) * 100) / 100;
    } else {
      if (esMensual && diasReportadosInput !== null && !Number.isInteger(diasReportadosInput)) {
        return res.status(400).json({ error: "Los días reportados deben ser un número entero" });
      }
      cantidadSolicitada = esMensual
        ? Number(diasReportadosInput || 0)
        : Number(horasReportadasInput || 0);
      horasReportadasFinal = esMensual ? 0 : Number(horasReportadasInput || 0);
      diasReportadosFinal = esMensual ? Math.trunc(diasReportadosInput || 0) : 0;
      const valorHoraAsignado = toNullableNumber(info.valor_hora);
      const valorDiaAsignado = toNullableNumber(info.valor_dia);
      if (esMensual) {
        const tarifaDia = valorDiaAsignado ?? (valorHoraAsignado !== null ? Number(valorHoraAsignado) / 20 : null);
        if (tarifaDia !== null) {
          totalCobrarFinal = Number(tarifaDia) * Number(diasReportadosFinal || 0);
        }
      } else if (valorHoraAsignado !== null) {
        totalCobrarFinal = Number(valorHoraAsignado) * Number(horasReportadasFinal || 0);
      }
      if (totalCobrarFinal !== null) {
        totalCobrarFinal = Math.round((Number(totalCobrarFinal) + Number.EPSILON) * 100) / 100;
      }
      if (!(cantidadSolicitada > 0)) {
        return res.status(400).json({ error: esMensual ? "Debes reportar días mayores a 0" : "Debes reportar horas mayores a 0" });
      }
    }

    if (!esHorasPorDemanda) {
      const uso = await pool.query(
        `
        SELECT
          COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN horas_reportadas ELSE 0 END), 0) AS horas_aprobadas,
          COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN cantidad_dias_reportados ELSE 0 END), 0) AS dias_aprobados,
          COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN total_cobrar ELSE 0 END), 0) AS total_aprobado,
          COALESCE(SUM(CASE WHEN estado_reporte <> 'Rechazado' THEN horas_reportadas ELSE 0 END), 0) AS horas_comprometidas,
          COALESCE(SUM(CASE WHEN estado_reporte <> 'Rechazado' THEN cantidad_dias_reportados ELSE 0 END), 0) AS dias_comprometidos,
          COALESCE(SUM(CASE WHEN estado_reporte <> 'Rechazado' THEN total_cobrar ELSE 0 END), 0) AS total_comprometido
        FROM reporte_horas
        WHERE id_registro_asignacion = $1
        `,
        [registroAsignacionId]
      );
      if (esCostoTotal) {
        const totalAprobado = Number(uso.rows[0]?.total_aprobado || 0);
        const totalComprometido = Number(uso.rows[0]?.total_comprometido || 0);
        const totalAsignado = toNullableNumber(info.total_pagar);
        if (totalAsignado !== null) {
          const totalUsado = permitirParcialesAcumulados ? totalComprometido : totalAprobado;
          const disponibles = Math.max(totalAsignado - totalUsado, 0);
          if (cantidadSolicitada > disponibles) {
            return res.status(400).json({ error: `Excede presupuesto disponible de la asignación (${disponibles})` });
          }
        }
      } else {
        const horasAprobadas = Number(uso.rows[0]?.horas_aprobadas || 0);
        const diasAprobadas = Number(uso.rows[0]?.dias_aprobadas || 0);
        const horasComprometidas = Number(uso.rows[0]?.horas_comprometidas || 0);
        const diasComprometidas = Number(uso.rows[0]?.dias_comprometidos || 0);
        const horasAsignadas = toNullableNumber(info.horas_asignadas);
        const diasAsignados = toNullableNumber(info.cantidad_dias);

        if (esMensual && diasAsignados !== null) {
          const diasUsados = permitirParcialesAcumulados ? diasComprometidas : diasAprobadas;
          const disponibles = Math.max(diasAsignados - diasUsados, 0);
          if (cantidadSolicitada > disponibles) {
            return res.status(400).json({ error: `Excede dias disponibles de la asignacion (${disponibles})` });
          }
        } else if (!esMensual && horasAsignadas !== null) {
          const horasUsadas = permitirParcialesAcumulados ? horasComprometidas : horasAprobadas;
          const disponibles = Math.max(horasAsignadas - horasUsadas, 0);
          if (cantidadSolicitada > disponibles) {
            return res.status(400).json({ error: `Excede horas disponibles de la asignación (${disponibles})` });
          }
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
    if (ultimoReporteEstado === "Rechazado" && ultimoReporteId) {
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
          horasReportadasFinal,
          diasReportadosFinal,
          totalCobrarFinal,
          tipo_servicio || null,
          nro_caso_int_ext || null,
          info.id_cliente,
          info.id_tipo_asignacion,
          info.id_modulo,
          info.coordinador_responsable_id,
          consultorId,
          consultorPrincipalId,
          ultimoReporteId
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
          horasReportadasFinal,
          diasReportadosFinal,
          totalCobrarFinal,
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
          `Detalle: ${buildReporteResumen({ horas_reportadas: horasReportadasFinal, cantidad_dias_reportados: diasReportadosFinal, total_cobrar: totalCobrarFinal })}\n` +
          `Revisar: ${portalUrl}\n`,
        html: buildEmailLayout({
          title: "Aprobación pendiente de reporte",
          intro: `Hola <strong>${correoRow.coordinador_nombre || "Coordinador"}</strong>, el consultor <strong>${correoRow.consultor_nombre || "N/A"}</strong> registró horas y requiere validación.`,
          blocks: [
            { label: "Cliente", value: correoRow.cliente || "N/A" },
            { label: "Tipo de asignación", value: correoRow.tipo_asignacion || "N/A" },
            { label: "Resumen", value: buildReporteResumen({ horas_reportadas: horasReportadasFinal, cantidad_dias_reportados: diasReportadosFinal, total_cobrar: totalCobrarFinal }) }
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
        con.id_tipo_asignacion AS tipo_asignacion_internal_id,
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
        rh.created_at AS fecha_ingreso_reporte,
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
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%mesa%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%service desk%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%servicedesk%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%fabrica%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%fábrica%'
        )
      ORDER BY ra.id DESC, rh.created_at DESC NULLS LAST, rh.id DESC
      `,
      [userId, estados.abierto, estados.proceso]
    );
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const ticketRows = rows.map((row) => {
      const rowScope = getMesaFabricaScope(
        row?.tipo_asignacion_internal_id,
        row?.tipo_asignacion,
        row
      );
      const withCases = applyTicketCaseFields(row);
      const {
        tipo_asignacion_internal_id: _tipoAsignacionInternalId,
        ...safeRow
      } = withCases;
      return {
        ...safeRow,
        scope_mesa_fabrica: rowScope
      };
    });
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
    fecha_inicio,
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
    wricef,
    scope: scopeInput
  } = req.body || {};

  const client = await pool.connect();
  let txStarted = false;
  try {
    const ocultarMonto = isAsociadoUser(req);
    await client.query("BEGIN");
    txStarted = true;
    const meta = await client.query(
      `
      WITH
        c_asignacion AS (SELECT id FROM registro_asignaciones WHERE public_id = $1::uuid),
        c_reporte AS (SELECT id FROM reporte_horas WHERE public_id = $3::uuid)
      SELECT
        ra.id,
        ra.estado AS estado_asignacion,
        ra.id_modulo,
        ra.id_consultoria,
        ra.nro_caso_cliente,
        ra.nro_caso_interno,
        ra.tipo_servicio AS ra_tipo_servicio,
        ra.observacion AS ra_observacion,
        ra.fecha_inicio AS ra_fecha_inicio,
        ra.fecha_fin,
        ra.total_pagar,
        ra.consultor_responsable_id,
        ucons.id_consultor_principal AS consultor_principal_rel_id,
        con.id_cliente,
        con.id_tipo_asignacion,
        con.coordinador_responsable_id,
        ta.titulo AS tipo_asignacion_titulo,
        (SELECT id FROM c_asignacion) AS diag_asignacion
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
        LEFT JOIN usuarios ucons ON ucons.id = ra.consultor_responsable_id
      WHERE ra.id = (SELECT id FROM c_asignacion)
        AND ra.consultor_responsable_id = $2
      `,
      [id, req.user?.id, reporte_id || null]
    );
    if (!meta.rows.length) {
      await client.query("ROLLBACK");
      // Could also distinguish on `diag_asignacion` but 404 is fine
      return res.status(404).json({ error: "Ticket no encontrado" });
    }

    const info = meta.rows[0];
    const registroId = info.id;
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
    const esMesaOFabrica = Boolean(
      getMesaFabricaScope(tipoAsignacionId, tipoAsignacionTitulo, info)
    );
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
      wricef,
      scope: scopeInput
    }, scopeInput);
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
      `WITH 
         c_asignacion AS (SELECT id FROM registro_asignaciones WHERE public_id = $1::uuid),
         c_reporte AS (SELECT id, estado_reporte, nro_caso_int_ext, perfil_fabrica, created_at FROM reporte_horas WHERE public_id = $2::uuid)
       SELECT id, estado_reporte, nro_caso_int_ext, perfil_fabrica, created_at
       FROM c_reporte
       WHERE ($2::uuid IS NOT NULL)
         AND estado_reporte IN ('Revisión', 'Rechazado')
       UNION ALL
       SELECT id, estado_reporte, nro_caso_int_ext, perfil_fabrica, created_at
       FROM reporte_horas
       WHERE $2::uuid IS NULL
         AND id_registro_asignacion = (SELECT id FROM c_asignacion)
         AND estado_reporte IN ('Revisión', 'Rechazado')
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [id, reporte_id || null]
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
    const finalFechaInicio =
      normalizeDateOnlyInput(fecha_inicio) ||
      normalizeDateOnlyInput(editableRow?.created_at) ||
      normalizeDateOnlyInput(info.ra_fecha_inicio) ||
      null;
    const finalFechaCierre = fecha_cierre_mesa_fab || info.fecha_fin || null;
    const finalHoras = toNullableNumber(horas_reportadas);
    const finalTotalInput = ocultarMonto ? null : toNullableNumber(total_cobrar);
    const finalTotal = finalTotalInput ?? info.total_pagar ?? null;
    const finalRequerimiento = (requerimiento || "").toString().trim() || null;
    const perfilInputRaw = String(perfil_fabrica || "").trim();
    const perfilInputNormalizado = normalizePerfilFabricaInput(perfil_fabrica);
    const perfilEditable = normalizePerfilFabricaInput(editableRow?.perfil_fabrica);
    const perfilAsignado = scope === "fabrica"
      ? (perfilEditable || await getAssignedPerfilFabrica(client, info.id, editableRow?.id || null))
      : null;
    if (scope === "fabrica" && perfilInputRaw && !perfilInputNormalizado) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Perfil de fábrica inválido" });
    }
    if (scope === "fabrica" && perfilAsignado && perfilInputNormalizado && perfilAsignado !== perfilInputNormalizado) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El perfil de fábrica ya está asignado y no puede modificarse." });
    }
    const finalPerfilFabrica = scope === "fabrica" ? (perfilAsignado || perfilInputNormalizado) : null;
    if (scope === "fabrica" && !finalPerfilFabrica) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No hay perfil de fábrica asignado para este ticket. Contacta al coordinador." });
    }
    const finalWricef = (wricef || "").toString().trim() || null;

    let saved;
    if (reporte_id && editableRow) {
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
             created_at = COALESCE($12::timestamp, created_at),
             cliente_id = COALESCE(cliente_id, $13),
             tipo_asignacion_id = COALESCE(tipo_asignacion_id, $14),
             modulo_id = COALESCE(modulo_id, $15),
             coordinador_id = COALESCE(coordinador_id, $16),
             consultor_responsable_id = COALESCE(consultor_responsable_id, $17),
             consultor_principal_id = COALESCE($18, consultor_principal_id),
             estado_reporte = 'Pendiente',
             motivo_rechazo = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $19
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
          finalFechaInicio,
          info.id_cliente,
          info.id_tipo_asignacion,
          info.id_modulo,
          info.coordinador_responsable_id,
          info.consultor_responsable_id,
          consultorPrincipalId,
          editableRow.id
        ]
      );
    } else if (reporte_id && !editableRow) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Solicitud no editable o no encontrada" });
    } else {
      const totalTickets = await client.query(
        `SELECT COUNT(1) AS total FROM reporte_horas WHERE id_registro_asignacion = $1`,
        [info.id]
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
           consultor_responsable_id, consultor_principal_id, created_by, created_at, estado_reporte)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'Pendiente')
           RETURNING *`,
        [
          info.id,
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
          req.user?.id || info.consultor_responsable_id,
          finalFechaInicio
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
    txStarted = false;

    // Notificación best-effort: si falla correo, el ticket ya quedó enviado.
    try {
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
            `Revisar: ${portalUrl}\n`,
          html: buildEmailLayout({
            title: "Ticket enviado a aprobación",
            intro: `Hola <strong>${correoRow.coordinador_nombre || "Coordinador"}</strong>, el consultor <strong>${correoRow.consultor_nombre || "N/A"}</strong> envió un ticket de Mesa/Fábrica para validación.`,
            blocks: [
              { label: "Cliente", value: correoRow.cliente || "N/A" },
              { label: "Tipo de asignación", value: correoRow.tipo_asignacion || "N/A" },
              { label: "Resumen", value: buildReporteResumen(saved.rows[0] || {}) }
            ],
            ctaLabel: "Revisar ticket",
            ctaUrl: portalUrl
          })
        });
      }
    } catch (mailErr) {
      console.error("Error notificando ticket a coordinador:", mailErr?.message || mailErr);
    }

    const savedRow = withPublicId(saved.rows[0] || {});
    if (ocultarMonto) savedRow.total_cobrar = null;
    res.json(savedRow);
  } catch (err) {
    if (txStarted) {
      try { await client.query("ROLLBACK"); } catch (_) { }
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
    total_cobrar,
    scope: scopeInput
  } = req.body;

  try {
    const ocultarMonto = isAsociadoUser(req);
    const tipoValido = await pool.query(
      `
      WITH
        c_asignacion AS (SELECT id FROM registro_asignaciones WHERE public_id = $1),
        c_reporte AS (SELECT id, estado_reporte, nro_caso_int_ext, perfil_fabrica, created_at FROM reporte_horas WHERE public_id = $3)
      SELECT
        ra.id AS registro_id,
        con.id_tipo_asignacion,
        ta.titulo AS tipo_asignacion_titulo,
        ra.estado AS estado_asignacion,
        ra.fecha_inicio,
        ra.id_modulo,
        ra.id_consultoria,
        ra.valor_hora,
        con.id_cliente,
        con.coordinador_responsable_id,
        ra.consultor_responsable_id,
        ucons.id_consultor_principal AS consultor_principal_rel_id,
        (SELECT id FROM c_asignacion) AS diag_asignacion,
        (SELECT id FROM c_reporte) AS _reporte_id_resolv
      FROM registro_asignaciones ra
        JOIN consultorias con ON con.id = ra.id_consultoria
        LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
        LEFT JOIN usuarios ucons ON ucons.id = ra.consultor_responsable_id
      WHERE ra.id = (SELECT id FROM c_asignacion)
        AND ra.consultor_responsable_id = $2
      `,
      [id, req.user?.id, reporte_id || null]
    );
    if (!tipoValido.rows.length) {
      if (!tipoValido.rows.diag_asignacion) {
        return res.status(404).json({ error: "Ticket o asignación no encontrado" });
      }
      return res.status(404).json({ error: "Ticket no encontrado" });
    }
    const { registro_id: registroId, _reporte_id_resolv: reporteId } = tipoValido.rows[0];
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
    const esMesaOFabrica = Boolean(
      getMesaFabricaScope(tipoAsignacionId, tipoAsignacionTitulo, tipoValido.rows[0] || {})
    );
    if (!esMesaOFabrica) {
      return res.status(400).json({ error: "Solo se permite actualizar tickets de Mesa/Fábrica en este módulo." });
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
      wricef,
      scope: scopeInput
    }, scopeInput);

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
    const finalWricef = (wricef || "").toString().trim() || null;
    const consultorPrincipalId = tipoValido.rows[0]?.consultor_principal_rel_id || null;
    const editable = await pool.query(
      `WITH c_reporte AS (SELECT id, nro_caso_int_ext, perfil_fabrica, created_at FROM reporte_horas WHERE public_id = $2)
       SELECT id, nro_caso_int_ext, perfil_fabrica, created_at
       FROM c_reporte
       WHERE ($2::text IS NOT NULL)
       UNION ALL
       SELECT id, nro_caso_int_ext, perfil_fabrica, created_at
       FROM reporte_horas
       WHERE $2::text IS NULL
         AND id_registro_asignacion = $1
         AND estado_reporte IN ('Revisión', 'Rechazado')
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [registroId, reporte_id || null]
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
    const perfilInputRaw = String(perfil_fabrica || "").trim();
    const perfilInputNormalizado = normalizePerfilFabricaInput(perfil_fabrica);
    const perfilEditable = normalizePerfilFabricaInput(editable.rows[0]?.perfil_fabrica);
    const perfilAsignado = scope === "fabrica"
      ? (perfilEditable || await getAssignedPerfilFabrica(pool, registroId, reporteId || null))
      : null;
    if (scope === "fabrica" && perfilInputRaw && !perfilInputNormalizado) {
      return res.status(400).json({ error: "Perfil de fábrica inválido" });
    }
    if (scope === "fabrica" && perfilAsignado && perfilInputNormalizado && perfilAsignado !== perfilInputNormalizado) {
      return res.status(400).json({ error: "El perfil de fábrica ya está asignado y no puede modificarse." });
    }
    const finalPerfilFabrica = scope === "fabrica" ? (perfilAsignado || perfilInputNormalizado) : null;
    if (scope === "fabrica" && !finalPerfilFabrica) {
      return res.status(400).json({ error: "No hay perfil de fábrica asignado para este ticket. Contacta al coordinador." });
    }
    const finalFechaInicio =
      normalizeDateOnlyInput(fecha_inicio) ||
      normalizeDateOnlyInput(editable.rows[0]?.created_at) ||
      normalizeDateOnlyInput(tipoValido.rows[0]?.fecha_inicio) ||
      null;
    if (!reporte_id) {
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
    if (reporte_id && editable.rows.length > 0) {
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
              created_at = COALESCE($13::timestamp, created_at),
              updated_at = CURRENT_TIMESTAMP
         WHERE id = $14`,
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
          finalFechaInicio,
          editable.rows[0].id
        ]
      );
    } else if (reporte_id && editable.rows.length === 0) {
      return res.status(404).json({ error: "Solicitud no editable o no encontrada" });
    } else {
      await pool.query(
        `INSERT INTO reporte_horas
          (id_registro_asignacion, horas_reportadas, total_cobrar, tipo_servicio, nro_caso_int_ext,
           observacion_mesa_fabrica, fecha_cierre_mesa_fab, estado_mesa_servicio, estado_fabrica,
           requerimiento, perfil_fabrica, wricef, cliente_id, tipo_asignacion_id, modulo_id, coordinador_id,
           consultor_responsable_id, consultor_principal_id, created_by, created_at, estado_reporte)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'Revisión')`,
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
          req.user?.id || null,
          finalFechaInicio
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
    const role = normalizeValue(req.user?.rol);
    const result = await pool.query(
      `
      WITH c_consultor AS (SELECT id FROM usuarios WHERE public_id = $1)
      SELECT
        rh.public_id AS id,
        rh.total_cobrar,
        rh.horas_reportadas,
        rh.cantidad_dias_reportados,
        rh.created_at,
        rh.nro_caso_int_ext,
        rh.requerimiento,
        c.titulo AS cliente,
        ta.titulo AS tipo_asignacion,
        (SELECT id FROM c_consultor) AS _consultor_id
      FROM reporte_horas rh
        LEFT JOIN clientes c ON rh.cliente_id = c.id
        LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
      WHERE rh.estado_reporte = 'Aprobado'
        AND rh.id_cuenta_cobro IS NULL
        AND (
          rh.consultor_responsable_id = (SELECT id FROM c_consultor)
          OR rh.consultor_principal_id = (SELECT id FROM c_consultor)
          OR rh.consultor_responsable_id IN (
            SELECT u.id
            FROM usuarios u
            WHERE u.activo = true
              AND u.id_consultor_principal = (SELECT id FROM c_consultor)
          )
        )
      ORDER BY rh.id DESC
      `,
      [consultorId]
    );

    const checkRows = result.rows;
    if (checkRows.length > 0 && !["administrador", "coordinador"].includes(role) && String(req.user?.id) !== String(checkRows[0]._consultor_id)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    const responseRows = checkRows.map(({ _consultor_id, ...row }) => {
      const withCases = applyTicketCaseFields(row);
      return {
        ...withCases,
        nro_caso_cliente: withCases.nro_caso_cliente || null,
        nro_caso_interno: withCases.nro_caso_interno || null
      };
    });
    res.json(responseRows);
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
    if (normalizeValue(req.user?.tipo_consultor) === "asociado") {
      return res.status(403).json({ error: "Acceso denegado" });
    }

    const meta = await pool.query(
      `
      WITH
        c_consultor AS (SELECT id, moneda_cobro FROM usuarios WHERE public_id = $1),
        c_reportes AS (SELECT id FROM reporte_horas WHERE public_id = ANY($2::uuid[]))
      SELECT
        COUNT(rh.id) AS count,
        COALESCE(SUM(rh.total_cobrar), 0) AS total,
        MIN(rh.created_at)::date AS min_fecha,
        MAX(rh.created_at)::date AS max_fecha,
        (SELECT id FROM c_consultor) AS _consultor_id,
        COALESCE((SELECT moneda_cobro FROM c_consultor), 'COP') AS moneda
      FROM reporte_horas rh
      WHERE rh.id IN (SELECT id FROM c_reportes)
        AND rh.estado_reporte = 'Aprobado'
        AND rh.id_cuenta_cobro IS NULL
        AND (
          rh.consultor_responsable_id = (SELECT id FROM c_consultor)
          OR rh.consultor_principal_id = (SELECT id FROM c_consultor)
          OR rh.consultor_responsable_id IN (
            SELECT u.id
            FROM usuarios u
            WHERE u.activo = true
              AND u.id_consultor_principal = (SELECT id FROM c_consultor)
          )
        )
      `,
      [consultor_id, ids_reportes]
    );

    const info = meta.rows[0];

    if (!info._consultor_id) {
      return res.status(404).json({ error: "Consultor no encontrado" });
    }

    if (String(req.user?.id) !== String(info._consultor_id)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }

    // 3. Validar que todos los registros sean válidos
    if (Number(info.count) !== ids_reportes.length) {
      return res.status(400).json({
        error: "Algunos registros no son válidos para cobro"
      });
    }

    // 4. Convertir a letras
    const total = Number(info.total || 0);
    const total_letras = buildTotalLetras(total, info.moneda);

    // 5. Retornar respuesta
    res.json({
      total: total,
      total_letras: total_letras,
      moneda: info.moneda,
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
    if (normalizeValue(req.user?.tipo_consultor) === "asociado") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    await client.query("BEGIN");
    txStarted = true;

    const meta = await client.query(
      `
      WITH
        c_consultor AS (SELECT id, moneda_cobro FROM usuarios WHERE public_id = $1),
        c_reportes AS (
          SELECT id, total_cobrar, created_at
          FROM reporte_horas
          WHERE public_id = ANY($2::uuid[])
            AND estado_reporte = 'Aprobado'
            AND id_cuenta_cobro IS NULL
            AND (
              consultor_responsable_id = (SELECT id FROM c_consultor)
              OR consultor_principal_id = (SELECT id FROM c_consultor)
              OR consultor_responsable_id IN (
                SELECT u.id
                FROM usuarios u
                WHERE u.activo = true
                  AND u.id_consultor_principal = (SELECT id FROM c_consultor)
              )
            )
        )
      SELECT
        COUNT(id) AS count,
        COALESCE(SUM(total_cobrar), 0) AS total,
        MIN(created_at)::date AS min_fecha,
        MAX(created_at)::date AS max_fecha,
        COALESCE((SELECT moneda_cobro FROM c_consultor), 'COP') AS moneda,
        ARRAY_AGG(id) AS used_ids,
        (SELECT id FROM c_consultor) AS _consultor_id
      FROM c_reportes
      `,
      [consultor_id, ids_reportes]
    );

    const info = meta.rows[0];
    if (!info._consultor_id) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Consultor no encontrado" });
    }
    if (String(req.user?.id) !== String(info._consultor_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (Number(info.count) !== ids_reportes.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Algunos registros no son válidos para cobro" });
    }

    if (total_numeros !== undefined && Number(total_numeros) !== Number(info.total || 0)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El total no coincide con los reportes aprobados" });
    }

    const totalLetrasFinal = buildTotalLetras(Number(info.total || 0), info.moneda);
    const descripcionFinal =
      (typeof req.body.descripcion === "string" && req.body.descripcion.trim()) ||
      `Cuenta de cobro ${fecha_inicio} - ${fecha_fin}`;

    const estadosAsignacion = await getEstadoAsignacionValues();

    const insert = await client.query(
      `
      WITH
        c_insert AS (
          INSERT INTO cuenta_cobro
            (descripcion, fecha_correspondiente, fecha_periodo_inicio, fecha_periodo_fin, total_cuenta_cobro, total_letras, ciudad_cobro, created_by)
          VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
          RETURNING *
        ),
        c_upd_rep AS (
          UPDATE reporte_horas
          SET id_cuenta_cobro = (SELECT id FROM c_insert)
          WHERE id = ANY($8::int[])
          RETURNING id_registro_asignacion
        ),
        c_upd_ra AS (
          UPDATE registro_asignaciones ra
          SET estado = $9::tipo_estado_asignacion
          FROM consultorias con
          LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
          WHERE ra.id_consultoria = con.id
            AND ra.id IN (SELECT id_registro_asignacion FROM c_upd_rep)
            AND NOT (
              COALESCE(con.id_tipo_asignacion, 0) IN (5, 6)
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%mesa%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%service desk%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%servicedesk%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%fabrica%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%fábrica%'
            )
        )
      SELECT * FROM c_insert
      `,
      [
        descripcionFinal,
        fecha_inicio,
        fecha_fin,
        info.total,
        totalLetrasFinal,
        ciudad_cobro,
        info._consultor_id,
        info.used_ids || [],
        estadosAsignacion.cerrado
      ]
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
        [info._consultor_id]
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
    const role = normalizeValue(req.user?.rol);
    const params = [userId];
    let whereFecha = "";
    if (fecha_inicio && fecha_fin) {
      params.push(fecha_inicio, fecha_fin);
      whereFecha = "AND cc.fecha_correspondiente BETWEEN $2 AND $3";
    }
    const result = await pool.query(
      `
      WITH c_consultor AS (SELECT id FROM usuarios WHERE public_id = $1)
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
        cc.created_at,
        (SELECT id FROM c_consultor) AS _consultor_id
      FROM cuenta_cobro cc
      WHERE cc.created_by = (SELECT id FROM c_consultor)
        ${whereFecha}
      ORDER BY cc.id DESC
      `,
      params
    );
    const checkRows = result.rows;
    if (checkRows.length > 0 && !["administrador", "coordinador"].includes(role) && String(req.user?.id) !== String(checkRows[0]._consultor_id)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    res.json(checkRows.map(({ _consultor_id, ...row }) => row));
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
        AND ($1::uuid IS NULL OR u.public_id = $1::uuid)
      ORDER BY cc.id DESC
      `,
      [consultor_id || null]
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
    const role = normalizeValue(req.user?.rol);
    const meta = await pool.query("SELECT id, created_by FROM cuenta_cobro WHERE public_id = $1", [cuentaId]);
    if (!meta.rows.length) return res.status(404).json({ error: "Cuenta no encontrada" });
    const cuentaInfo = meta.rows[0];

    if (!["administrador", "coordinador"].includes(role)) {
      if (String(cuentaInfo.created_by) !== String(req.user?.id)) {
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
      [cuentaInfo.id]
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
      WHERE cc.public_id = $1
      `,
      [id]
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
      [JSON.stringify(adjuntos), cuenta.id]
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
    const meta = await pool.query("SELECT id, created_by FROM cuenta_cobro WHERE public_id = $1", [id]);
    if (!meta.rows.length) return res.status(404).json({ error: "Cuenta no encontrada" });
    const cuentaInternalId = meta.rows[0].id;
    await assertCuentaCobroOwnerAccess(meta.rows[0].created_by, req);
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
    const meta = await pool.query("SELECT id, created_by FROM cuenta_cobro WHERE public_id = $1", [id]);
    if (!meta.rows.length) return res.status(404).json({ error: "Cuenta no encontrada" });
    const cuentaInternalId = meta.rows[0].id;
    await assertCuentaCobroOwnerAccess(meta.rows[0].created_by, req);

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
      WHERE cc.public_id = $1
      LIMIT 1
      `,
      [id]
    );

    const cuenta = cuentaResult.rows[0] || null;
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });
    await assertCuentaCobroOwnerAccess(cuenta.created_by, req);

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
      WHERE cc.public_id = $1
      LIMIT 1
      `,
      [id]
    );

    const cuenta = cuentaResult.rows[0] || null;
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });
    await assertCuentaCobroOwnerAccess(cuenta.created_by, req);
    const cuentaInternalId = cuenta.id;

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

async function uploadContratoFirmadoToOneDrive(proceso, pdfBuffer, fileName) {
  const token = await getGraphAccessToken();
  const encodedUser = encodeURIComponent(ONEDRIVE_TARGET_USER);
  await graphGet(`/v1.0/users/${encodedUser}/drive`, token);

  const fechaStr = new Date().toISOString().slice(0, 10);
  const nombreCarpeta = sanitizePathSegment(
    `${proceso.nombre_persona}_${fechaStr}`,
    `Contrato_${fechaStr}`
  );

  let targetPath = sanitizePathSegment(CONTRATOS_ONEDRIVE_FOLDER, "ContratosFirmados");
  targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, "", targetPath);
  targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, nombreCarpeta);
  let folderWebUrl = "";
  try {
    const folderMeta = await graphGet(
      `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(targetPath)}`,
      token
    );
    folderWebUrl = String(folderMeta?.webUrl || "").trim();
  } catch (folderErr) {
    console.warn("No se pudo resolver URL de carpeta OneDrive para contrato:", folderErr?.message || folderErr);
  }

  const safeName = sanitizePdfFileName(fileName || `Contrato_${proceso.nombre_persona}.pdf`, "Contrato.pdf");
  const uploadPath = `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(`${targetPath}/${safeName}`)}:/content`;
  const uploaded = await graphPutBinaryWithRetry(uploadPath, token, pdfBuffer, "application/pdf");

  return {
    carpeta: targetPath,
    carpeta_url: folderWebUrl || null,
    archivo: {
      id: uploaded.id || "",
      nombre: uploaded.name || safeName,
      url: uploaded.webUrl || ""
    }
  };
}

function contratoDocNeedsReconciliation(doc = {}) {
  const status = normalizeDocStatus(doc?.estado);
  const hasIdentifiers = Boolean(
    String(doc?.request_id || "").trim() ||
    String(doc?.contract_id || "").trim() ||
    String(doc?.signature_id || "").trim()
  );
  if (!hasIdentifiers) return false;
  if (status === "rejected") return false;
  if (status === "signed" && String(doc?.onedrive_url || "").trim()) return false;
  return true;
}

async function reconcileContratoDocsForProcess(proceso, { docIndex = null, reason = "manual" } = {}) {
  const targetIndex = Number(docIndex);
  const filterByIndex = Number.isInteger(targetIndex) && targetIndex > 0;
  const docsActuales = normalizeDocsFirmaListCompat(proceso?.docs_firma);
  if (!docsActuales.length) {
    return {
      proceso: {
        ...proceso,
        docs_firma: docsActuales,
        estado: proceso?.estado || "en_proceso"
      },
      docs_firma: docsActuales,
      estado: proceso?.estado || "en_proceso",
      changed: false,
      reconciled: []
    };
  }

  let changed = false;
  const reconciled = [];
  const nextDocs = [];

  for (const doc of docsActuales) {
    const currentIndex = Number(doc?.doc_index || 0);
    let nextDoc = { ...doc };

    if (filterByIndex && currentIndex !== targetIndex) {
      nextDocs.push(nextDoc);
      continue;
    }

    if (!contratoDocNeedsReconciliation(doc)) {
      nextDocs.push(nextDoc);
      continue;
    }

    const requestId = String(doc?.request_id || "").trim();
    const contractId = String(doc?.contract_id || "").trim();
    const signatureId = String(doc?.signature_id || "").trim();
    if (!requestId && !contractId && !signatureId) {
      nextDocs.push(nextDoc);
      continue;
    }

    try {
      const snapshot = await fetchClickSignSignatureSnapshot({ requestId, contractId, signatureId });
      const event = snapshot?.event && typeof snapshot.event === "object" ? snapshot.event : {};
      const snapshotSignatureId = String(extractClickSignSignatureId(event) || "").trim();
      const previousStatus = normalizeDocStatus(doc?.estado);
      const rawStatus = String(snapshot?.rawStatus || snapshot?.status || doc?.ultimo_evento || doc?.estado || "pending").trim();
      let nextStatus = normalizeClickSignStatus(rawStatus);
      let oneDriveInfo = null;
      let signedPdfSource = "";
      let uploadCompleted = Boolean(String(doc?.onedrive_url || "").trim());

      if (!nextStatus) nextStatus = previousStatus || "pending";
      if (previousStatus === "signed" && nextStatus !== "rejected") {
        nextStatus = "signed";
      }

      if (nextStatus === "signed" || nextStatus === "pending" || !nextStatus) {
        const artifacts = await resolveClickSignArtifacts({
          event,
          requestId,
          contractId,
          publicId: "",
          signatureId: signatureId || snapshotSignatureId
        });
        const resolvedPdf = artifacts?.signedPdf || null;
        if (resolvedPdf && isPdfBuffer(resolvedPdf.buffer)) {
          signedPdfSource = resolvedPdf.source || "";
          if (!String(doc?.onedrive_url || "").trim()) {
            try {
              oneDriveInfo = await uploadContratoFirmadoToOneDrive(proceso, resolvedPdf.buffer, resolvedPdf.fileName);
              uploadCompleted = Boolean(oneDriveInfo?.archivo?.url);
            } catch (uploadErr) {
              console.error("Error subiendo contrato reconciliado a OneDrive:", uploadErr?.message || uploadErr);
            }
          }
          if (uploadCompleted || previousStatus === "signed") {
            nextStatus = "signed";
          } else {
            nextStatus = "pending";
          }
        } else if (nextStatus === "signed" && previousStatus !== "signed") {
          // Mantener pendiente hasta que el PDF firmado pueda descargarse y subirse a OneDrive.
          nextStatus = "pending";
        }
      }

      const nowIso = new Date().toISOString();
      nextDoc = {
        ...doc,
        signature_id: signatureId || snapshotSignatureId || doc?.signature_id || null,
        estado: nextStatus || doc?.estado || "pending",
        ultimo_evento: rawStatus || doc?.ultimo_evento || null,
        reconciliado_en: nowIso,
        reconciliado_origen: reason,
        clicksign_origen: snapshot?.source || doc?.clicksign_origen || null
      };
      if (nextStatus === "signed" && !nextDoc.firmado_en) {
        nextDoc.firmado_en = nowIso;
      }
      if (oneDriveInfo?.archivo?.url) {
        nextDoc.onedrive_url = oneDriveInfo.archivo.url || null;
        nextDoc.onedrive_carpeta = oneDriveInfo.carpeta || null;
        nextDoc.onedrive_carpeta_url = oneDriveInfo.carpeta_url || null;
        nextDoc.onedrive_id = oneDriveInfo.archivo.id || null;
        nextDoc.onedrive_nombre = oneDriveInfo.archivo.nombre || null;
      }

      if (JSON.stringify(doc) !== JSON.stringify(nextDoc)) {
        changed = true;
      }

      reconciled.push({
        doc_index: currentIndex || null,
        request_id: requestId || null,
        contract_id: contractId || null,
        estado: nextDoc.estado || null,
        onedrive_url: nextDoc.onedrive_url || null,
        source: snapshot?.source || signedPdfSource || null
      });
    } catch (err) {
      console.error("Error reconciliando documento de contrato:", {
        proceso_id: proceso?.id || null,
        doc_index: currentIndex || null,
        message: err?.message || err
      });
      reconciled.push({
        doc_index: currentIndex || null,
        request_id: requestId || null,
        contract_id: contractId || null,
        error: err?.message || String(err)
      });
    }

    nextDocs.push(nextDoc);
  }

  const nextEstado =
    nextDocs.length > 0 && nextDocs.every((item) => normalizeDocStatus(item?.estado) === "signed")
      ? "completado"
      : (proceso?.estado === "expirado" ? "expirado" : "en_proceso");

  if (changed || nextEstado !== proceso?.estado) {
    await pool.query(
      `UPDATE tokens_firma_contrato
       SET docs_firma = $1::jsonb,
           estado = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(nextDocs), nextEstado, proceso.id]
    );
  }

  if (nextEstado === "completado") {
    try {
      await notifyContratoFirmaCompletada(proceso.id);
    } catch (notifyErr) {
      console.error("Error notificando contrato completado:", notifyErr?.message || notifyErr);
    }
  }

  return {
    proceso: {
      ...proceso,
      docs_firma: nextDocs,
      estado: nextEstado
    },
    docs_firma: nextDocs,
    estado: nextEstado,
    changed: changed || nextEstado !== proceso?.estado,
    reconciled
  };
}

async function handleClickSignContratoWebhook({ event, requestId, contractId, status, rawStatus }) {
  if (status !== "signed" && status !== "rejected") return;

  try {
    // Buscar el proceso por request_id o contract_id en docs_firma
    let proceso = null;
    let docIndex = null;
    let matchedDoc = null;

    if (requestId) {
      const r = await pool.query(
        `SELECT id, nombre_persona, correo_personal, docs_firma
         FROM tokens_firma_contrato
         WHERE docs_firma @> $1::jsonb AND estado = 'en_proceso'
         LIMIT 1`,
        [JSON.stringify([{ request_id: requestId }])]
      );
      if (r.rowCount > 0) {
        proceso = r.rows[0];
        matchedDoc = normalizeDocsFirmaListCompat(proceso.docs_firma).find((d) => d.request_id === requestId) || null;
        docIndex = matchedDoc?.doc_index || null;
      }
    }

    if (!proceso && contractId) {
      const r = await pool.query(
        `SELECT id, nombre_persona, correo_personal, docs_firma
         FROM tokens_firma_contrato
         WHERE docs_firma @> $1::jsonb AND estado = 'en_proceso'
         LIMIT 1`,
        [JSON.stringify([{ contract_id: contractId }])]
      );
      if (r.rowCount > 0) {
        proceso = r.rows[0];
        matchedDoc = normalizeDocsFirmaListCompat(proceso.docs_firma).find((d) => d.contract_id === contractId) || null;
        docIndex = matchedDoc?.doc_index || null;
      }
    }

    if (!proceso) {
      console.warn("Webhook contrato: no se encontró proceso para", { requestId, contractId });
      return;
    }
    if (!docIndex && contractId) {
      const match = String(contractId || "").match(/_(\d+)$/);
      if (match?.[1]) {
        docIndex = Number(match[1]);
      }
    }

    let oneDriveInfo = null;
    const signatureId = String(
      extractClickSignSignatureId(event) ||
      matchedDoc?.signature_id ||
      ""
    ).trim();
    if (status === "signed") {
      const artifacts = await resolveClickSignArtifacts({
        event,
        requestId,
        contractId,
        publicId: "",
        signatureId
      });
      const resolvedPdf = artifacts?.signedPdf || null;

      if (!resolvedPdf || !isPdfBuffer(resolvedPdf.buffer)) {
        console.warn("Webhook contrato: PDF no disponible aún, reintentando en 30s", { requestId, contractId });
        setTimeout(async () => {
          try {
            const r = await pool.query(
              `SELECT id, nombre_persona, correo_personal, docs_firma FROM tokens_firma_contrato WHERE id = $1 LIMIT 1`,
              [proceso.id]
            );
            if (r.rows[0]) await reconcileContratoDocsForProcess(r.rows[0], { docIndex, reason: "webhook_retry" });
          } catch (retryErr) {
            console.error("Error en reconcile diferido de contrato:", retryErr?.message || retryErr);
          }
        }, 30000);
        return;
      }
      try {
        oneDriveInfo = await uploadContratoFirmadoToOneDrive(proceso, resolvedPdf.buffer, resolvedPdf.fileName);
      } catch (upErr) {
        console.error("Error subiendo contrato firmado a OneDrive:", upErr.message);
        setTimeout(async () => {
          try {
            const r = await pool.query(
              `SELECT id, nombre_persona, correo_personal, docs_firma FROM tokens_firma_contrato WHERE id = $1 LIMIT 1`,
              [proceso.id]
            );
            if (r.rows[0]) await reconcileContratoDocsForProcess(r.rows[0], { docIndex, reason: "webhook_retry" });
          } catch (retryErr) {
            console.error("Error en reconcile diferido de contrato:", retryErr?.message || retryErr);
          }
        }, 30000);
      }
    }

    const nowIso = new Date().toISOString();
    const docsActuales = normalizeDocsFirmaListCompat(proceso.docs_firma);
    let docMatched = false;
    const nuevaLista = docsActuales.map((d) => {
      if (d.request_id === requestId || d.contract_id === contractId) {
        const finalStatus =
          status === "rejected"
            ? "rejected"
            : (String(oneDriveInfo?.archivo?.url || d.onedrive_url || "").trim() ? "signed" : "pending");
        docMatched = true;
        return {
          ...d,
          signature_id: signatureId || d.signature_id || null,
          estado: finalStatus,
          firmado_en: finalStatus === "signed" ? (d.firmado_en || nowIso) : d.firmado_en || null,
          ultimo_evento: rawStatus || d.ultimo_evento || null,
          onedrive_url: oneDriveInfo?.archivo?.url || d.onedrive_url || null,
          onedrive_carpeta: oneDriveInfo?.carpeta || d.onedrive_carpeta || null,
          onedrive_carpeta_url: oneDriveInfo?.carpeta_url || d.onedrive_carpeta_url || null
        };
      }
      return d;
    });

    let finalDocs = nuevaLista;
    if (!docMatched && docIndex) {
      const fallbackKey = LEGACY_DOC_INDEX_TO_KEY.get(Number(docIndex)) || null;
      const fallbackDef = getContratoDocDefinition(fallbackKey);
      const fallbackStatus =
        status === "rejected"
          ? "rejected"
          : (String(oneDriveInfo?.archivo?.url || "").trim() ? "signed" : "pending");
      finalDocs = upsertDocFirmaEntry(finalDocs, {
        doc_index: Number(docIndex),
        doc_key: fallbackDef?.doc_key || fallbackKey,
        titulo: fallbackDef?.titulo || `Documento ${docIndex}`,
        template_file: fallbackDef?.template_file || null,
        empresa_key: fallbackDef?.empresa_key || null,
        request_id: requestId || null,
        contract_id: contractId || null,
        signature_id: signatureId || null,
        estado: fallbackStatus,
        firmado_en: fallbackStatus === "signed" ? nowIso : null,
        ultimo_evento: rawStatus || null,
        onedrive_url: oneDriveInfo?.archivo?.url || null,
        onedrive_carpeta: oneDriveInfo?.carpeta || null,
        onedrive_carpeta_url: oneDriveInfo?.carpeta_url || null
      });
    }

    const todosFirmados = finalDocs.length > 0 && finalDocs.every((d) => normalizeDocStatus(d.estado) === "signed");

    await pool.query(
      `UPDATE tokens_firma_contrato
       SET docs_firma = $1::jsonb,
           estado = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(finalDocs), todosFirmados ? "completado" : "en_proceso", proceso.id]
    );

    if (todosFirmados) {
      try {
        await notifyContratoFirmaCompletada(proceso.id);
      } catch (notifyErr) {
        console.error("Error notificando contrato completado desde webhook:", notifyErr?.message || notifyErr);
      }
    }

    console.log(`Contrato doc${docIndex || "?"} estado ${status} para proceso ${proceso.id}. Completado: ${todosFirmados}`);
  } catch (err) {
    console.error("Error procesando webhook de contrato:", err.message);
  }
}

// Reportes pendientes para coordinador
app.get("/aprobaciones/pendientes", requireAccess({ roles: ["Coordinador"] }), async (req, res) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(`
      SELECT
        rh.public_id AS id,
        rh.created_at AS fecha_reporte,
        rh.nro_caso_int_ext,
        rh.tipo_servicio,
        rh.observacion_mesa_fabrica AS observacion_ticket,
        rh.requerimiento,
        rh.perfil_fabrica,
        rh.wricef,
        rh.id_registro_asignacion,
        rh.total_cobrar,
        rh.horas_reportadas,
        rh.cantidad_dias_reportados,
        c.titulo AS nombre_cliente,
        u.nombre_usuario AS nombre_consultor,
        u.email AS email_consultor,
        m.titulo AS nombre_modulo,
        ta.titulo AS nombre_tipo_asignacion,
        ra.public_id AS asignacion_id,
        ra.nro_caso_cliente AS asignacion_nro_caso_cliente,
        ra.nro_caso_interno AS asignacion_nro_caso_interno,
        ra.fecha_inicio AS asignacion_fecha_inicio,
        ra.fecha_fin AS asignacion_fecha_fin,
        ra.observacion AS asignacion_observacion
      FROM reporte_horas rh
        LEFT JOIN clientes c ON rh.cliente_id = c.id
        LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
        LEFT JOIN modulo m ON rh.modulo_id = m.id
        LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
        LEFT JOIN registro_asignaciones ra ON rh.id_registro_asignacion = ra.id
      WHERE rh.estado_reporte = 'Pendiente'
        AND rh.coordinador_id = $1
      ORDER BY rh.created_at DESC
    `, [userId]);
    const rows = (result.rows || []).map((row) => {
      const withCases = applyTicketCaseFields(row);
      return {
        ...withCases,
        nro_caso_cliente:
          withCases.nro_caso_cliente || row?.asignacion_nro_caso_cliente || null,
        nro_caso_interno:
          withCases.nro_caso_interno || row?.asignacion_nro_caso_interno || null
      };
    });
    res.json(rows);
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
    if (!estado) {
      return res.status(400).json({ error: "Falta estado" });
    }

    const propiedad = await pool.query(
      `SELECT rh.id
       FROM reporte_horas rh
       JOIN registro_asignaciones ra ON ra.id = rh.id_registro_asignacion
       JOIN consultorias con ON con.id = ra.id_consultoria
       WHERE rh.public_id = $1::uuid AND con.coordinador_responsable_id = $2::int`,
      [id, req.user?.id || null]
    );

    if (propiedad.rows.length === 0) {
      return res.status(404).json({ error: "Reporte no encontrado" });
    }

    const result = await pool.query(
      `
       WITH c_reporte AS (SELECT id FROM reporte_horas WHERE public_id = $3::uuid)
       UPDATE reporte_horas
       SET estado_reporte = $1,
           motivo_rechazo = $2
       WHERE id = (SELECT id FROM c_reporte)
       RETURNING *`,
      [estado, motivo || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Reporte no encontrado" });
    }

    const reporteId = result.rows[0]?.id || null;
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
            ra.cantidad_dias,
            ra.total_pagar,
            ra.es_costo_total
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
            const tipoNorm = normalizeTipoAsignacionTitulo(meta.tipo_asignacion_titulo);
            const esMensual = isTipoAsignacionMensual(tipoNorm);
            const esTiempoCostoFijo = isTipoAsignacionTiempoCostoFijo(tipoNorm);
            const esCostoTotal = esTiempoCostoFijo && toBooleanInput(meta.es_costo_total, false);
            const esHorasPorDemanda = isTipoAsignacionHorasPorDemanda(tipoNorm);
            if (esHorasPorDemanda) {
              // Para horas por demanda se cierra al aprobar para evitar reprocesos
              // del mismo bloque antes de pasar a cuenta de cobro.
              estadoAprobadoDestino = estados.cerrado || estados.proceso;
            } else {
              const uso = await pool.query(
                `
                SELECT
                  COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN horas_reportadas ELSE 0 END), 0) AS horas_aprobadas,
                  COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN cantidad_dias_reportados ELSE 0 END), 0) AS dias_aprobados,
                  COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN total_cobrar ELSE 0 END), 0) AS total_aprobado
                FROM reporte_horas
                WHERE id_registro_asignacion = $1
                `,
                [registroId]
              );
              const horasAsignadas = toNullableNumber(meta.horas_asignadas);
              const diasAsignados = toNullableNumber(meta.cantidad_dias);
              const totalAsignado = toNullableNumber(meta.total_pagar);
              const horasAprobadas = Number(uso.rows[0]?.horas_aprobadas || 0);
              const diasAprobadas = Number(uso.rows[0]?.dias_aprobadas || 0);
              const totalAprobado = Number(uso.rows[0]?.total_aprobado || 0);
              const agotadoPorHoras = !esMensual && horasAsignadas !== null && horasAprobadas >= horasAsignadas;
              const agotadoPorDias = false; // mensual no tiene tope de días
              const agotadoPorTotal = esCostoTotal && totalAsignado !== null && totalAprobado >= totalAsignado;
              if (agotadoPorHoras || agotadoPorDias || agotadoPorTotal) {
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
      const esMesaOFabrica = isTipoAsignacionMesaOFabrica(tipoNorm);
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
   SERVIDOR (CAMBIO CRÍTICO PARA AZURE)
=============================== */

// 1. Usar process.env.PORT (Obligatorio para Azure)
// 2. Mantener 4000 como fallback para tu entorno local
const port = process.env.PORT || process.env.BACK_PORT || 4000;

// 3. A?adir "0.0.0.0" asegura que el contenedor acepte conexiones externas
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});

// ── Job: reconciliación server-side de cuentas en firma ──────────────────────
// Busca cuentas que llevan más de 20 min en estado "En Firma" y tienen IDs de
// Click&Sign guardados. Las cuentas migradas sin esos IDs se ignoran.
const RECONCILIACION_JOB_INTERVAL_MS = 10 * 60 * 1000; // cada 10 minutos
const RECONCILIACION_MIN_EDAD_MIN = 20; // solo cuentas con más de 20 min sin actualizar
const RECONCILIACION_BATCH = 10; // máximo por ciclo

async function jobReconciliarCuentasEnFirma() {
  if (isShuttingDown) return;
  try {
    const estadoEnFirma = await getCuentaCobroEstadoEnFirma();
    // Fix #2: filtrar IDs vacíos con NULLIF+BTRIM para no agarrar cuentas migradas con ""
    const result = await pool.query(
      `SELECT cc.id, cc.public_id, cc.created_by, cc.fecha_correspondiente,
              cc.created_at, cc.datos_adjuntos, u.nombre_usuario, u.email
       FROM cuenta_cobro cc
       LEFT JOIN usuarios u ON u.id = cc.created_by
       WHERE cc.estado = $1::tipo_estado_reporte
         AND cc.updated_at < NOW() - ($2 || ' minutes')::INTERVAL
         AND (
           NULLIF(BTRIM(cc.datos_adjuntos->'firma'->>'request_id'), '') IS NOT NULL
           OR NULLIF(BTRIM(cc.datos_adjuntos->'firma'->>'contract_id'), '') IS NOT NULL
         )
         AND COALESCE(cc.datos_adjuntos->'firma'->'documento_firmado'->>'url', '') = ''
       ORDER BY cc.updated_at ASC
       LIMIT $3`,
      [estadoEnFirma, String(RECONCILIACION_MIN_EDAD_MIN), RECONCILIACION_BATCH]
    );

    const cuentas = result.rows || [];
    if (cuentas.length === 0) return;

    console.log(`[reconciliar-job] ${cuentas.length} cuenta(s) en firma pendientes de reconciliar.`);

    for (const cuenta of cuentas) {
      if (isShuttingDown) break;
      try {
        const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object" ? cuenta.datos_adjuntos : {};
        const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object" ? prevAdjuntos.firma : {};
        const prevSoportes = prevAdjuntos.soportes && typeof prevAdjuntos.soportes === "object" ? prevAdjuntos.soportes : {};

        const requestId = String(prevFirma.request_id || "").trim();
        const contractId = String(prevFirma.contract_id || "").trim();
        const signatureId = String(prevFirma.signature_id || "").trim();

        const snapshot = await fetchClickSignSignatureSnapshot({ requestId, contractId, signatureId });
        const event = snapshot.event && typeof snapshot.event === "object" ? snapshot.event : {};
        const rawStatus = snapshot.rawStatus || prevFirma.ultimo_evento || "pending";
        let status = normalizeClickSignStatus(rawStatus);
        const nowIso = new Date().toISOString();

        let documentoFirmado = null;
        let documentoFirmadoError = "";
        let uploadedExtras = [];
        let resolvedPdfForEmail = null;

        if (status === "signed" || !status || status === "pending") {
          const artifacts = await resolveClickSignArtifacts({
            event,
            requestId,
            contractId,
            publicId: String(cuenta.public_id || ""),
            signatureId: signatureId || extractClickSignSignatureId(event) || ""
          });
          const resolvedPdf = artifacts?.signedPdf || null;
          if (resolvedPdf && isPdfBuffer(resolvedPdf.buffer)) {
            resolvedPdfForEmail = resolvedPdf;
            try {
              const uploadResult = await uploadSignedPdfToOneDrive(cuenta, resolvedPdf.buffer, resolvedPdf.fileName);
              documentoFirmado = {
                ...uploadResult.archivo,
                carpeta: uploadResult.carpeta,
                origen: resolvedPdf.source || "clicksign",
                actualizado_en: nowIso
              };
              status = "signed";
              try {
                const extrasResult = await uploadClickSignExtraFilesToOneDrive(cuenta, artifacts?.extraFiles || [], uploadResult.carpeta || "");
                uploadedExtras = extrasResult.uploaded || [];
              } catch (extraErr) {
                console.warn(`[reconciliar-job] Extras no subidos para ${cuenta.public_id}:`, extraErr?.message);
              }
            } catch (uploadErr) {
              documentoFirmadoError = `Error OneDrive: ${uploadErr.message || "desconocido"}`;
            }
          } else if (status === "signed") {
            // Fix #5: dejar error observable cuando Click&Sign dice firmado pero no hay PDF
            documentoFirmadoError = "No se encontró PDF firmado en API de Click&Sign (job).";
          }
        }

        const firma = {
          ...prevFirma,
          estado: status || prevFirma.estado || "pending",
          actualizado_en: nowIso,
          ultimo_evento: rawStatus || status || "reconciliar-job"
        };
        if (documentoFirmado?.url) firma.documento_firmado = documentoFirmado;
        if (documentoFirmadoError) firma.documento_firmado_error = documentoFirmadoError;
        else if (status === "signed") firma.documento_firmado_error = null;

        const adjuntos = { ...prevAdjuntos, firma };
        if (documentoFirmado?.url) {
          const cuentaFirmadaUrl = documentoFirmado.url;
          adjuntos.soportes = {
            ...prevSoportes,
            carpeta: documentoFirmado.carpeta || prevSoportes.carpeta || "",
            actualizado_en: nowIso,
            cuenta_cobro_firmada: {
              id: documentoFirmado.id || prevSoportes?.cuenta_cobro_firmada?.id || null,
              nombre: documentoFirmado.nombre || prevSoportes?.cuenta_cobro_firmada?.nombre || "CuentaCobroFirmada.pdf",
              url: cuentaFirmadaUrl
            }
          };
          // Fix #4: replicar todos los extras igual que el webhook/manual
          const extraSeguridad = uploadedExtras.find((x) => x.kind === "seguridad_social_firma" && x.url);
          const extraEvidencia = uploadedExtras.find((x) => x.kind === "evidencia_firma" && x.url);
          const extraAnexo = uploadedExtras.find((x) => x.kind === "anexo_firma" && x.url);
          if (extraSeguridad && !sameResourceUrl(extraSeguridad.url, cuentaFirmadaUrl)) {
            adjuntos.soportes.seguridad_social_firma = { id: extraSeguridad.id || null, nombre: extraSeguridad.nombre || "SeguridadSocial.pdf", url: extraSeguridad.url };
            if (!adjuntos.soportes.seguridad_social?.url) adjuntos.soportes.seguridad_social = { ...adjuntos.soportes.seguridad_social_firma };
          }
          if (extraEvidencia && !sameResourceUrl(extraEvidencia.url, cuentaFirmadaUrl)) {
            adjuntos.soportes.evidencia_firma = { id: extraEvidencia.id || null, nombre: extraEvidencia.nombre || "EvidenciaFirma.pdf", url: extraEvidencia.url };
          }
          if (extraAnexo && !sameResourceUrl(extraAnexo.url, cuentaFirmadaUrl)) {
            adjuntos.soportes.anexo_firma = { id: extraAnexo.id || null, nombre: extraAnexo.nombre || "AnexoFirma.pdf", url: extraAnexo.url };
          }
        }

        let estadoDestino = null;
        if (status === "signed") {
          const estadoAprobado = await getCuentaCobroEstadoAprobado();
          estadoDestino = documentoFirmado?.url ? estadoAprobado : estadoEnFirma;
        } else if (status === "rejected") {
          estadoDestino = "Rechazado";
        }

        // UPDATE condicional: no pisar si el webhook ganó la carrera.
        // Doble guard: URL vacía (caso firmado-con-PDF) + estado sigue en EnFirma
        // (cubre el caso rechazado-sin-URL que el check de URL no detecta).
        let updateResult;
        if (estadoDestino) {
          updateResult = await pool.query(
            `UPDATE cuenta_cobro
             SET datos_adjuntos = $1::jsonb, estado = $2::tipo_estado_reporte, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
               AND estado = $4::tipo_estado_reporte
               AND COALESCE(datos_adjuntos->'firma'->'documento_firmado'->>'url', '') = ''`,
            [JSON.stringify(adjuntos), estadoDestino, cuenta.id, estadoEnFirma]
          );
        } else {
          updateResult = await pool.query(
            `UPDATE cuenta_cobro
             SET datos_adjuntos = $1::jsonb, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
               AND estado = $3::tipo_estado_reporte
               AND COALESCE(datos_adjuntos->'firma'->'documento_firmado'->>'url', '') = ''`,
            [JSON.stringify(adjuntos), cuenta.id, estadoEnFirma]
          );
        }

        // Fix #1 y #3: solo notificar si el UPDATE ganó la carrera, y persistir resultado
        if (updateResult.rowCount > 0 && status === "signed" && documentoFirmado?.url) {
          // Fix #4: pasar el PDF real al correo igual que webhook/manual
          const attachments = buildCuentaCobroEmailAttachments({
            cuenta,
            signedPdf: resolvedPdfForEmail
              ? { buffer: resolvedPdfForEmail.buffer, fileName: resolvedPdfForEmail.fileName }
              : null,
            extraFiles: uploadedExtras
          });
          try {
            const notificacion = await notifyCuentaCobroFirmadaToProveedores({
              cuenta,
              documentoFirmado,
              attachments,
              prevNotification: prevFirma.notificacion_proveedores || {},
              nowIso
            });
            // Fix #3: persistir el resultado de la notificación
            if (notificacion) {
              await pool.query(
                `UPDATE cuenta_cobro
                 SET datos_adjuntos = jsonb_set(datos_adjuntos, '{firma,notificacion_proveedores}', $1::jsonb),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [JSON.stringify(notificacion), cuenta.id]
              );
            }
          } catch (notifErr) {
            console.warn(`[reconciliar-job] Notificación fallida para ${cuenta.public_id}:`, notifErr?.message);
          }
        } else if (updateResult.rowCount === 0) {
          console.log(`[reconciliar-job] ${cuenta.public_id} omitida — ya fue resuelta por webhook.`);
        }

        console.log(`[reconciliar-job] ${cuenta.public_id} → estado: ${estadoDestino || status || "sin cambio"}`);
      } catch (cuentaErr) {
        console.error(`[reconciliar-job] Error procesando ${cuenta.public_id}:`, cuentaErr?.message || cuentaErr);
      }
    }
  } catch (err) {
    console.error("[reconciliar-job] Error en ciclo:", err?.message || err);
  }
}

// Primer ciclo a los 2 min del arranque para no sobrecargar el inicio
let reconciliarJobInterval = null;
setTimeout(() => {
  if (isShuttingDown) return;
  void jobReconciliarCuentasEnFirma();
  reconciliarJobInterval = setInterval(() => { void jobReconciliarCuentasEnFirma(); }, RECONCILIACION_JOB_INTERVAL_MS);
}, 2 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (reconciliarJobInterval) clearInterval(reconciliarJobInterval);
  console.log(`[shutdown] Se?al recibida: ${signal}. Cerrando API...`);

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

module.exports = {
  ...(module.exports || {}),
  sendEmailSafe,
  buildCuentaCobroEmailAttachments,
  notifyCuentaCobroFirmadaToProveedores,
  handleClickSignAnexoIndividualWebhook,
  pickStringByPaths,
  extractClickSignSignatureId,
  sameResourceUrl,
  uploadSignedPdfToOneDrive,
  resolveClickSignArtifacts,
  uploadClickSignExtraFilesToOneDrive,
  getCuentaCobroEstadoEnFirma,
  getCuentaCobroEstadoAprobado,
  normalizeClickSignStatus,
  handleClickSignContratoWebhook,
  isPdfBuffer,
  toBooleanInput,
  withPublicId,
  getGraphContext,
  buildPortalUrl,
  buildEmailLayout,
  getEstadoAsignacionValues,
  getMesaFabricaScope,
  normalizeTipoServicioInput,
  resolveEstadoAsignacionInput,
  resolveInternalIdFromPublicIdOrId,
  toNullableInteger,
  toNullableNumber,
  ID_TABLES
};
