const path = require("path");
const envFile =
  process.env.NODE_ENV === "production" ? ".env_produccion" : ".env";
require("dotenv").config({ path: path.resolve(process.cwd(), envFile) });
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const https = require("https");
const PDFDocument = require("pdfkit");
const { NumerosALetras } = require("numero-a-letras");
const { sendEmail, getGraphAccessToken } = require("./email");


const app = express();

console.log("[startup] DEBUG_AUTH:", process.env.DEBUG_AUTH);

/* ===============================
   CONFIGURACIÃ“N
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
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "35mb" }));
app.options('*', cors(corsOptions));

/* ===============================
   BASE DE DATOS
=============================== */
const dbHost = String(process.env.DB_HOST || "").toLowerCase().trim();
const dbSslEnv = String(process.env.DB_SSL || "").toLowerCase().trim();
const localDbHosts = new Set(["localhost", "127.0.0.1", "db"]);
const shouldUseSsl =
  dbSslEnv
    ? ["1", "true", "yes", "require"].includes(dbSslEnv)
    : !localDbHosts.has(dbHost);

const poolConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT
};

if (shouldUseSsl) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);
let estadoAsignacionCache = null;

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
    estadoAsignacionCache = {
      labels: ["Abierto", "Cerrado", "Proceso"],
      abierto: "Abierto",
      proceso: "Proceso",
      cerrado: "Cerrado",
      inactivo: null,
      cancelado: null
    };
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

function buildTotalLetras(numero, moneda = 'COP') {
  const parteEntera = Math.floor(numero);
  const centavos = Math.round((numero - parteEntera) * 100);

  // Obtener texto y limpiar "00/100" si existe
  let textoNumeros = NumerosALetras(parteEntera).toUpperCase();

  // Eliminar " 00/100" si estÃ¡ presente
  textoNumeros = textoNumeros.replace(/\s*00\/100\s*/g, '');
  // TambiÃ©n eliminar "M.N." si existe
  textoNumeros = textoNumeros.replace(/\s*M\.N\.\s*/g, '');

  const nombreMoneda = moneda === 'USD' ? 'DÃ“LARES' : 'PESOS';

  if (centavos > 0) {
    return `${textoNumeros} CON ${centavos}/100 ${nombreMoneda}`;
  } else {
    return `${textoNumeros} ${nombreMoneda}`;
  }
}

async function sendEmailSafe({ to, subject, text, html, cc, bcc, graphAccessToken, graphUserEmail }) {
  try {
    await sendEmail({ to, subject, text, html, cc, bcc, graphAccessToken, graphUserEmail });
  } catch (err) {
    console.error("Error enviando correo:", err.message);
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
const ONEDRIVE_ROOT_FOLDER = process.env.ONEDRIVE_ROOT_FOLDER || "CuentasCobro";

function buildPortalUrl(hashRoute = "inicio") {
  const base = String(FRONT_PORTAL_BASE || "").trim();
  if (!base) return "#";
  const safeHash = String(hashRoute || "inicio").replace(/^#/, "");
  return `${base}#${safeHash}`;
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
  const match = raw.match(/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
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
    if (!String(err.message || "").includes("nameAlreadyExists")) {
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
  const match = String(message || "").match(/Graph error (\d{3})/);
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

const requireAccess = ({ roles = [], tipos = [] } = {}) => (req, res, next) => {
  if (!roles.length && !tipos.length) return next();
  if (!req.user) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "No autorizado" });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Token invÃ¡lido" });
    }
  }
  if (!hasAccess(req, { roles, tipos })) {
    return res.status(403).json({ error: "Acceso denegado" });
  }
  return next();
};

/* ===============================
   SERVIR ARCHIVOS DEL FRONTEND
=============================== */
// Ajusta esta ruta si tu carpeta 'front' estÃ¡ en otro nivel relativo
// Frontend se sirve por separado (no estÃ¡ en este contenedor)

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
    const result = await pool.query("SELECT * FROM clientes WHERE activo = true ORDER BY id DESC");
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
      "INSERT INTO clientes (titulo, nit, prefijo, correlativo, activo) VALUES ($1, $2, $3, $4, true) RETURNING *",
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
    const result = await pool.query(
      "UPDATE clientes SET titulo = $1, nit = $2, prefijo = $3 WHERE id = $4 RETURNING *",
      [titulo, nit, prefijo, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar" });
  }
});

// 4. ELIMINAR CLIENTE (Soft Delete)
app.delete("/clientes/:id", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  const { id } = req.params;

  try {
    // Validar dependencias (Ejemplo: si tienes tabla consultorias)
    // const check = await pool.query("SELECT id FROM consultorias WHERE id_cliente = $1", [id]);
    // if (check.rows.length > 0) return res.status(400).json({ tiene_consultorias: true });

    await pool.query("UPDATE clientes SET activo = false WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar" });
  }
});

/* ===============================
   API - CATÃLOGOS
=============================== */

// Consultores activos
app.get("/consultores", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
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
        u.id,
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
    const result = await pool.query(
      `
      SELECT
        u.id,
        u.nombre_usuario,
        u.email
      FROM usuarios u
      WHERE u.activo = true
        AND u.id_consultor_principal = $1
        AND LOWER(u.tipo_consultor::text) = 'asociado'
      ORDER BY u.nombre_usuario ASC
      `,
      [principalId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener consultores asociados" });
  }
});

// Consultores disponibles para asociar
app.get("/sub-consultores/disponibles/:principalId", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { principalId } = req.params;
  try {
    if (!principalId) return res.json([]);
    const result = await pool.query(
      `
      SELECT
        u.id,
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
      [principalId]
    );
    res.json(result.rows);
  } catch (err) {
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

    const principal = await pool.query(
      "SELECT id, tipo_consultor FROM usuarios WHERE id = $1 AND activo = true",
      [principal_id]
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
      [asociado_id]
    );
    if (asociado.rows.length === 0) {
      return res.status(404).json({ error: "Consultor asociado no encontrado" });
    }
    if (String(asociado.rows[0].id_consultor_principal || "") !== "") {
      return res.status(400).json({ error: "El consultor ya estÃ¡ asociado a otro principal" });
    }

    await pool.query(
      `UPDATE usuarios
       SET id_consultor_principal = $1,
           tipo_consultor = 'Asociado',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [principal_id, asociado_id]
    );

    res.json({ ok: true });
  } catch (err) {
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

    const asociado = await pool.query(
      "SELECT id, id_consultor_principal FROM usuarios WHERE id = $1 AND activo = true",
      [asociadoId]
    );
    if (asociado.rows.length === 0) {
      return res.status(404).json({ error: "Consultor asociado no encontrado" });
    }
    if (String(asociado.rows[0].id_consultor_principal || "") !== String(principal_id)) {
      return res.status(403).json({ error: "No autorizado para desvincular" });
    }

    await pool.query(
      `UPDATE usuarios
       SET id_consultor_principal = NULL,
           tipo_consultor = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [asociadoId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al desvincular consultor" });
  }
});

// Módulos activos
app.get("/modulos", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, titulo
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

// Tipos de asignación activos
app.get("/tipos-asignacion", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, titulo
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
        s.id,
        s.coordinador_id,
        s.cliente_id,
        s.modulo_id,
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
        u.nombre_usuario AS solicitante
      FROM solicitudes_rrhh s
        LEFT JOIN clientes c ON s.cliente_id = c.id
        LEFT JOIN modulo m ON s.modulo_id = m.id
        LEFT JOIN usuarios u ON s.coordinador_id = u.id
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
      RETURNING *
      `,
      [
        req.user?.id,
        cliente_id,
        modulo_id,
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
    const created = result.rows[0];

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
          [created.id]
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
      WHERE s.id = $1
      `,
      [id]
    );

    if (solicitudInfo.rows.length === 0) {
      return res.status(404).json({ error: "Solicitud no encontrada" });
    }

    const before = solicitudInfo.rows[0];
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

    values.push(id);
    const result = await pool.query(
      `
      UPDATE solicitudes_rrhh
      SET ${fields.join(", ")}
      WHERE id = $${idx}
      RETURNING *
      `,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Solicitud no encontrada" });
    }
    const updated = result.rows[0];

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
    console.error(err);
    res.status(500).json({ error: "Error al actualizar solicitud" });
  }
});
/* ===============================
   AUTH
=============================== */

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

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
      return res.status(400).json({ error: "El correo ya estÃ¡ registrado" });
    }

    const rolRes = await pool.query(
      "SELECT id FROM roles WHERE titulo = 'Consultor' LIMIT 1"
    );
    const rolId = rolRes.rows[0]?.id || null;

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (nombre_usuario, email, password_hash, rol_usuario_id, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, nombre_usuario, email, rol_usuario_id`,
      [nombre_usuario, email, hash, rolId]
    );

    res.json({ ok: true, user: result.rows[0] });
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
      `SELECT u.id, u.nombre_usuario, u.email, u.password_hash, u.rol_usuario_id, u.tipo_consultor, r.titulo AS rol
         FROM usuarios u
         LEFT JOIN roles r ON u.rol_usuario_id = r.id
         WHERE u.email = $1 AND u.activo = true`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Credenciales invÃ¡lidas" });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ error: "Credenciales invÃ¡lidas" });
    }

    const payload = {
      id: user.id,
      nombre_usuario: user.nombre_usuario,
      email: user.email,
      rol: user.rol || "",
      rol_usuario_id: user.rol_usuario_id,
      tipo_consultor: user.tipo_consultor || null
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
    res.json({ token, user: payload });
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
      `SELECT u.id, u.nombre_usuario, u.email, u.rol_usuario_id, u.tipo_consultor, r.titulo AS rol
         FROM usuarios u
         LEFT JOIN roles r ON u.rol_usuario_id = r.id
         WHERE u.id = $1 AND u.activo = true`,
      [decoded.id]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Usuario no vÃ¡lido" });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(401).json({ error: "Token invÃ¡lido" });
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
    if (process.env.DEBUG_AUTH === "true") {
      console.log("[ms_auth] token aud invalido:", aud, "scp:", scope || "-");
    }
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

      if (process.env.DEBUG_AUTH === "true") {
        console.log(
          "[ms_auth] user:",
          email,
          "oid:",
          oid,
          "allowedGroups:",
          allowedGroups,
          "allowedGroupIds:",
          allowedGroupIds.length,
          "allowedGroupNames:",
          allowedGroupNames.length,
          "memberGroupsFound:",
          groups.length,
          "allowed:",
          allowed,
          "matchedGroup:",
          matchedGroup || null
        );
      }
      if (!allowed) {
        if (process.env.DEBUG_AUTH === "true") {
          return res.status(403).json({
            error: "Usuario sin acceso al grupo permitido",
            debug: {
              email,
              oid,
              allowed_groups_config: allowedGroups,
              member_groups_count: groups.length,
              member_groups_sample: groups.slice(0, 20)
            }
          });
        }
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
      `SELECT u.id, u.nombre_usuario, u.email, u.rol_usuario_id, u.tipo_consultor, u.azure_oid, r.titulo AS rol
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
         RETURNING id, nombre_usuario, email, rol_usuario_id`,
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
      nombre_usuario: userRow.nombre_usuario || nombre,
      email: userRow.email || email,
      rol: userRow.rol || rolTitulo,
      rol_usuario_id: userRow.rol_usuario_id || rolId,
      tipo_consultor: userRow.tipo_consultor || null
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
    res.json({ token, user: payload });
  } catch (err) {
    const status = parseGraphErrorStatus(err.message);
    if (status === 401 || status === 403) {
      if (process.env.DEBUG_AUTH === "true") {
        console.error("Error auth microsoft (graph):", err.message);
      }
      return res.status(401).json({
        error: "Token Microsoft inválido o sin permisos en Graph (revisa consentimiento de User.Read)."
      });
    }
    if (process.env.DEBUG_AUTH === "true") {
      console.error("Error auth microsoft (interno):", {
        message: err.message,
        code: err.code || null,
        detail: err.detail || null,
        constraint: err.constraint || null
      });
    } else {
      console.error("Error auth microsoft (interno):", err.message);
    }

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
      return res.status(500).json({ error: "Falta una columna requerida en la tabla usuarios (revisa migraciones)" });
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

const authMiddleware = (req, res, next) => {
  const publicPaths = ["/", "/auth/login", "/auth/register", "/auth/me", "/auth/microsoft"];
  if (publicPaths.includes(req.path) || req.path.startsWith("/auth/")) return next();
  if (req.method === "OPTIONS") return next();

  const auth = req.headers.authorization || "";
  if (req.path === "/clientes") {
    console.log("[AUTH] path:", req.path, "origin:", req.headers.origin || "-", "auth:", auth ? "present" : "missing");
  }
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (process.env.DEBUG_AUTH === "true") {
    console.log("[AUTH] path:", req.path, "hasAuth:", Boolean(auth));
  }

  if (!token) return res.status(401).json({ error: "No autorizado" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Token invÃ¡lido" });
  }
};

app.use(authMiddleware);

// Coordinadores activos
app.get("/coordinadores", requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
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
      return res.status(400).json({ error: "Faltan parÃ¡metros requeridos" });
    }
    const result = await pool.query(
      `SELECT obtener_tarifa_consultor($1, $2, $3, $4) AS valor_tarifa`,
      [consultor_id, cliente_id, modulo_id || null, tipo_asignacion_id || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
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
        tc.id,
        tc.id_cliente AS cliente_id,
        tc.consultor_id,
        tc.modulo_id,
        tc.id_tipo_asignacion AS tipo_asignacion_id,
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

    const result = await pool.query(
      `INSERT INTO tarifa_consultor 
        (id_cliente, consultor_id, modulo_id, id_tipo_asignacion, valor_tarifa, activo)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [
        cliente_id,
        consultor_id,
        modulo_id || null,
        tipo_asignacion_id || null,
        valor
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar tarifa" });
  }
});

// Actualizar tarifa
app.put("/tarifas/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;
  const { cliente_id, consultor_id, modulo_id, tipo_asignacion_id, valor } = req.body;

  try {
    const result = await pool.query(
      `UPDATE tarifa_consultor
       SET id_cliente = $1,
           consultor_id = $2,
           modulo_id = $3,
           id_tipo_asignacion = $4,
           valor_tarifa = $5
       WHERE id = $6
       RETURNING *`,
      [
        cliente_id,
        consultor_id,
        modulo_id || null,
        tipo_asignacion_id || null,
        valor,
        id
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar tarifa" });
  }
});

// Eliminar tarifa (soft delete)
app.delete("/tarifas/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("UPDATE tarifa_consultor SET activo = false WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar tarifa" });
  }
});

/* ===============================
   API - CONSULTORÃAS (ASIGNACIÃ“N COORDINADORES)
=============================== */

// Obtener consultorías
app.get("/consultorias", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  try {
    const coordinadorId = req.query.coordinador_id || null;
    const result = await pool.query(`
      SELECT
        c.id,
        c.id_cliente AS cliente_id,
        c.coordinador_responsable_id AS coordinador_id,
        c.id_tipo_asignacion AS tipo_asignacion_id,
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

    const result = await pool.query(
      `INSERT INTO consultorias
        (id_cliente, coordinador_responsable_id, id_tipo_asignacion, descripcion_consultoria, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [
        cliente_id,
        coordinador_id,
        tipo_asignacion_id,
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
      [cliente_id, tipo_asignacion_id, coordinador_id]
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
    console.error(err);
    res.status(500).json({ error: "Error al guardar consultoría" });
  }
});

// Actualizar consultoría
app.put("/consultorias/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;
  const { cliente_id, coordinador_id, tipo_asignacion_id, descripcion_consultoria } = req.body;

  try {
    const result = await pool.query(
      `UPDATE consultorias
       SET id_cliente = $1,
           coordinador_responsable_id = $2,
           id_tipo_asignacion = $3,
           descripcion_consultoria = $4
       WHERE id = $5
       RETURNING *`,
      [
        cliente_id,
        coordinador_id,
        tipo_asignacion_id,
        descripcion_consultoria || null,
        id
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar consultoría" });
  }
});

// Eliminar consultoría (soft delete)
app.delete("/consultorias/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("UPDATE consultorias SET activo = false WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
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
          ra.id,
          con.id AS consultoria_id,
          c.id AS cliente_id,
          c.titulo AS cliente,
          u.nombre_usuario AS consultor_responsable,
          coord.nombre_usuario AS coordinador,
          m.titulo AS modulo,
          ta.titulo AS tipo_asignacion,
          con.id_tipo_asignacion AS tipo_asignacion_id,
          con.descripcion_consultoria,
          ra.consultor_responsable_id,
          ra.id_modulo,
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
        ra.id,
        con.id AS consultoria_id,
        c.id AS cliente_id,
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
      WHERE ($1::int IS NULL OR ra.consultor_responsable_id = $1)
        AND lr.estado_reporte = 'Aprobado'
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
        ra.id,
        con.id AS consultoria_id,
        c.id AS cliente_id,
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
      WHERE ($1::int IS NULL OR ra.consultor_responsable_id = $1)
        AND (lr.estado_reporte IS NULL OR lr.estado_reporte = 'Rechazado')
        AND ra.estado IN ($2::tipo_estado_asignacion, $3::tipo_estado_asignacion)
        AND NOT (
          COALESCE(con.id_tipo_asignacion, 0) IN (5, 6)
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) IN ('mesa de servicio', 'fabrica', 'fábrica')
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
    if (!id_registro_asignacion) {
      return res.status(400).json({ error: "Falta id_registro_asignacion" });
    }

    const existente = await pool.query(
      `SELECT id, estado_reporte
         FROM reporte_horas
         WHERE id_registro_asignacion = $1
           AND estado_reporte IN ('Pendiente', 'Rechazado')
         ORDER BY updated_at DESC NULLS LAST, id DESC
         LIMIT 1`,
      [id_registro_asignacion]
    );
    const existenteRow = existente.rows[0];
    if (existenteRow?.estado_reporte === "Pendiente") {
      return res.status(400).json({ error: "Ya hay un reporte pendiente para esta asignación" });
    }

    const meta = await pool.query(`
      SELECT
        ra.id,
        ra.id_modulo,
        ra.consultor_responsable_id,
        con.id_cliente,
        con.id_tipo_asignacion,
        con.coordinador_responsable_id,
        ta.titulo AS tipo_asignacion_titulo
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
      WHERE ra.id = $1
    `, [id_registro_asignacion]);

    if (meta.rows.length === 0) {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }

    const info = meta.rows[0];
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
          horas_reportadas || null,
          cantidad_dias_reportados || null,
          total_cobrar || null,
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
          id_registro_asignacion,
          horas_reportadas || null,
          cantidad_dias_reportados || null,
          total_cobrar || null,
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
      [id_registro_asignacion, estados.proceso]
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
      [id_registro_asignacion, consultorId]
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
          `Detalle: ${buildReporteResumen({ horas_reportadas, cantidad_dias_reportados, total_cobrar })}\n` +
          `Revisar: ${portalUrl}\n`,
        html: buildEmailLayout({
          title: "Aprobación pendiente de reporte",
          intro: `Hola <strong>${correoRow.coordinador_nombre || "Coordinador"}</strong>, el consultor <strong>${correoRow.consultor_nombre || "N/A"}</strong> registró horas y requiere validación.`,
          blocks: [
            { label: "Cliente", value: correoRow.cliente || "N/A" },
            { label: "Tipo de asignación", value: correoRow.tipo_asignacion || "N/A" },
            { label: "Resumen", value: buildReporteResumen({ horas_reportadas, cantidad_dias_reportados, total_cobrar }) }
          ],
          ctaLabel: "Revisar y aprobar",
          ctaUrl: portalUrl
        })
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al reportar horas" });
  }
});

/* ===============================
   API - MESA/FÃBRICA
=============================== */

// Listar tickets mesa/fÃ¡brica del consultor
app.get("/mesa-fabrica", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(
      `
      SELECT
        ra.id,
        ra.nro_caso_interno,
        ra.nro_caso_cliente,
        ra.estado,
        ra.aprobar_coordinador,
        ra.tipo_servicio,
        ra.observacion,
        ra.fecha_inicio,
        ra.fecha_fin,
        c.id AS cliente_id,
        c.titulo AS nombre_cliente,
        m.id AS modulo_id,
        m.titulo AS nombre_modulo,
        ta.titulo AS tipo_asignacion,
        coord.nombre_usuario AS nombre_coordinador,
        lr.estado_reporte AS estado_reporte,
        lr.motivo_rechazo,
        lr.total_cobrar,
        lr.horas_reportadas,
        lr.nro_caso_int_ext
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        JOIN clientes c ON con.id_cliente = c.id
        LEFT JOIN usuarios coord ON con.coordinador_responsable_id = coord.id
        LEFT JOIN modulo m ON ra.id_modulo = m.id
        LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
        LEFT JOIN LATERAL (
          SELECT rh.estado_reporte, rh.motivo_rechazo, rh.total_cobrar, rh.horas_reportadas, rh.nro_caso_int_ext
          FROM reporte_horas rh
          WHERE rh.id_registro_asignacion = ra.id
          ORDER BY rh.updated_at DESC NULLS LAST, rh.id DESC
          LIMIT 1
        ) lr ON true
      WHERE ra.consultor_responsable_id = $1
        AND (
          COALESCE(con.id_tipo_asignacion, 0) IN (5, 6)
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) IN ('mesa de servicio', 'fabrica', 'fábrica')
        )
      ORDER BY ra.id DESC
      `,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tickets" });
  }
});

// Enviar ticket mesa/fábrica a aprobación de coordinador
app.post("/mesa-fabrica/:id/enviar-aprobacion", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  const { id } = req.params;
  const {
    horas_reportadas,
    total_cobrar,
    tipo_servicio,
    nro_caso_int_ext,
    observacion_mesa_fabrica,
    fecha_cierre_mesa_fab,
    estado_mesa_servicio,
    estado_fabrica,
    requerimiento
  } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const meta = await client.query(
      `
      SELECT
        ra.id,
        ra.id_modulo,
        ra.id_consultoria,
        ra.nro_caso_cliente,
        ra.nro_caso_interno,
        ra.tipo_servicio AS ra_tipo_servicio,
        ra.observacion AS ra_observacion,
        ra.fecha_fin,
        ra.total_pagar,
        ra.consultor_responsable_id,
        con.id_cliente,
        con.id_tipo_asignacion,
        con.coordinador_responsable_id,
        ta.titulo AS tipo_asignacion_titulo
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
      WHERE ra.id = $1
        AND ra.consultor_responsable_id = $2
      `,
      [id, req.user?.id]
    );
    if (!meta.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Ticket no encontrado" });
    }

    const info = meta.rows[0];
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

    const last = await client.query(
      `SELECT id, estado_reporte
       FROM reporte_horas
       WHERE id_registro_asignacion = $1
       ORDER BY updated_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [id]
    );
    const lastRow = last.rows[0];
    if (lastRow?.estado_reporte === "Pendiente") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Este ticket ya está pendiente de aprobación." });
    }

    const finalTipoServicio = normalizeTipoServicioInput(tipo_servicio || info.ra_tipo_servicio || "Servicio") || null;
    const finalNroCaso = (nro_caso_int_ext || info.nro_caso_cliente || info.nro_caso_interno || "").toString().trim() || null;
    const finalObservacion = (observacion_mesa_fabrica || info.ra_observacion || "").toString().trim() || null;
    const finalFechaCierre = fecha_cierre_mesa_fab || info.fecha_fin || null;
    const finalHoras = horas_reportadas ?? null;
    const finalTotal = total_cobrar ?? info.total_pagar ?? null;

    let saved;
    if (lastRow) {
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
             cliente_id = COALESCE(cliente_id, $10),
             tipo_asignacion_id = COALESCE(tipo_asignacion_id, $11),
             modulo_id = COALESCE(modulo_id, $12),
             coordinador_id = COALESCE(coordinador_id, $13),
             consultor_responsable_id = COALESCE(consultor_responsable_id, $14),
             consultor_principal_id = COALESCE(consultor_principal_id, $15),
             estado_reporte = 'Pendiente',
             motivo_rechazo = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $16
         RETURNING *`,
        [
          finalHoras,
          finalTotal,
          finalTipoServicio,
          finalNroCaso,
          finalObservacion,
          finalFechaCierre,
          estado_mesa_servicio || null,
          estado_fabrica || null,
          requerimiento || null,
          info.id_cliente,
          info.id_tipo_asignacion,
          info.id_modulo,
          info.coordinador_responsable_id,
          info.consultor_responsable_id,
          info.consultor_responsable_id,
          lastRow.id
        ]
      );
    } else {
      saved = await client.query(
        `INSERT INTO reporte_horas
          (id_registro_asignacion, horas_reportadas, total_cobrar, tipo_servicio, nro_caso_int_ext,
           observacion_mesa_fabrica, fecha_cierre_mesa_fab, estado_mesa_servicio, estado_fabrica,
           requerimiento, cliente_id, tipo_asignacion_id, modulo_id, coordinador_id,
           consultor_responsable_id, consultor_principal_id, created_by, estado_reporte)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'Pendiente')
         RETURNING *`,
        [
          id,
          finalHoras,
          finalTotal,
          finalTipoServicio,
          finalNroCaso,
          finalObservacion,
          finalFechaCierre,
          estado_mesa_servicio || null,
          estado_fabrica || null,
          requerimiento || null,
          info.id_cliente,
          info.id_tipo_asignacion,
          info.id_modulo,
          info.coordinador_responsable_id,
          info.consultor_responsable_id,
          info.consultor_responsable_id,
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
      [id, estados.proceso]
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

    res.json(saved.rows[0] || {});
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Error al enviar ticket a aprobación" });
  } finally {
    client.release();
  }
});

// Actualizar ticket mesa/fÃ¡brica
app.put("/mesa-fabrica/:id", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  const { id } = req.params;
  const {
    nro_caso_interno,
    nro_caso_cliente,
    tipo_servicio,
    estado,
    observacion,
    fecha_cierre
  } = req.body;

  try {
    const tipoValido = await pool.query(
      `
      SELECT con.id_tipo_asignacion, ta.titulo AS tipo_asignacion_titulo
      FROM registro_asignaciones ra
        JOIN consultorias con ON con.id = ra.id_consultoria
        LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
      WHERE ra.id = $1
        AND ra.consultor_responsable_id = $2
      `,
      [id, req.user?.id]
    );
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

    const estados = await getEstadoAsignacionValues();
    const estadoNormalizado = resolveEstadoAsignacionInput(estado, estados);
    if (estado && !estadoNormalizado) {
      return res.status(400).json({ error: "Estado de ticket inválido" });
    }
    const tipoServicioNormalizado = normalizeTipoServicioInput(tipo_servicio);
    if (tipo_servicio && !tipoServicioNormalizado) {
      return res.status(400).json({ error: "Tipo de servicio inválido" });
    }

    const result = await pool.query(
      `
      UPDATE registro_asignaciones
      SET nro_caso_interno = $1,
          nro_caso_cliente = $2,
          tipo_servicio = $3,
          estado = $4,
          observacion = $5,
          fecha_fin = $6
      WHERE id = $7
        AND consultor_responsable_id = $8
      RETURNING *
      `,
      [
        nro_caso_interno || null,
        nro_caso_cliente || null,
        tipoServicioNormalizado,
        estadoNormalizado,
        observacion || null,
        fecha_cierre || null,
        id,
        req.user?.id
      ]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
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
    if (!["administrador", "coordinador"].includes(role) && String(req.user?.id) !== String(consultorId)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (!consultorId) return res.json([]);
    const result = await pool.query(
      `
      SELECT
        rh.id,
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
        AND (rh.consultor_principal_id = $1 OR rh.consultor_responsable_id = $1)
      ORDER BY rh.id DESC
      `,
      [consultorId]
    );
    res.json(result.rows);
  } catch (err) {
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
    if (String(req.user?.id) !== String(consultor_id)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    // 1. Obtener moneda del consultor
    const monedaRes = await pool.query(
      "SELECT moneda_cobro FROM usuarios WHERE id = $1",
      [consultor_id]
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
        AND (consultor_principal_id = $2 OR consultor_responsable_id = $2)`,
      [ids_reportes, consultor_id]
    );

    const info = meta.rows[0];

    // 3. Validar que todos los registros sean vÃ¡lidos
    if (Number(info.count) !== ids_reportes.length) {
      return res.status(400).json({
        error: "Algunos registros no son vÃ¡lidos para cobro"
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
    console.error('âŒ Error en /cuentas-cobro/preview:', error);
    res.status(500).json({
      error: 'Error al calcular preview',
      detalle: error.message
    });
  }
});

// Crear cuenta de cobro
app.post("/cuentas-cobro", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), async (req, res) => {
  const { consultor_id, fecha_inicio, fecha_fin, total_letras, ciudad_cobro, total_numeros, ids_reportes } = req.body;
  if (!consultor_id || !fecha_inicio || !fecha_fin || !total_letras || !ciudad_cobro || !Array.isArray(ids_reportes) || ids_reportes.length === 0) {
    return res.status(400).json({ error: "Faltan datos para generar la cuenta" });
  }

  const client = await pool.connect();
  try {
    if (normalizeValue(req.user?.tipo_consultor) === "asociado") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (String(req.user?.id) !== String(consultor_id)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    await client.query("BEGIN");

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
        AND (consultor_principal_id = $2 OR consultor_responsable_id = $2)
      `,
      [ids_reportes, consultor_id]
    );

    const info = meta.rows[0];
    if (Number(info.count) !== ids_reportes.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Algunos registros no son vÃ¡lidos para cobro" });
    }

    if (total_numeros !== undefined && Number(total_numeros) !== Number(info.total || 0)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El total no coincide con los reportes aprobados" });
    }

    const monedaRes = await client.query(
      "SELECT moneda_cobro FROM usuarios WHERE id = $1",
      [consultor_id]
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
        consultor_id
      ]
    );

    const cuentaId = insert.rows[0].id;

    await client.query(
      `
      UPDATE reporte_horas
      SET id_cuenta_cobro = $1
      WHERE id = ANY($2)
      `,
      [cuentaId, ids_reportes]
    );

    const estados = await getEstadoAsignacionValues();
    await client.query(
      `
      UPDATE registro_asignaciones
      SET estado = $2::tipo_estado_asignacion
      WHERE id IN (
        SELECT id_registro_asignacion
        FROM reporte_horas
        WHERE id = ANY($1)
      )
      `,
      [ids_reportes, estados.cerrado]
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
        [consultor_id]
      );
      const consultor = userInfo.rows[0];
      await sendEmailSafe({
        ...getGraphContext(req),
        to: contabilidadEmail,
        subject: `Nueva cuenta de cobro #${cuenta.id}`,
        text:
          `Se generó una cuenta de cobro.\n` +
          `Consultor: ${consultor?.nombre_usuario || ""} (${consultor?.email || ""})\n` +
          `Periodo: ${cuenta.fecha_periodo_inicio} a ${cuenta.fecha_periodo_fin}\n` +
          `Total: ${cuenta.total_cuenta_cobro}\n` +
          `Descripción: ${cuenta.descripcion || ""}\n`
      });
    }

    res.json({ ok: true, cuenta });
  } catch (err) {
    await client.query("ROLLBACK");
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
    if (!["administrador", "coordinador"].includes(role) && String(req.user?.id) !== String(userId)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (!userId) return res.json([]);
    const params = [userId];
    let whereFecha = "";
    if (fecha_inicio && fecha_fin) {
      params.push(fecha_inicio, fecha_fin);
      whereFecha = "AND cc.fecha_correspondiente BETWEEN $2 AND $3";
    }
    const result = await pool.query(
      `
      SELECT
        cc.id,
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
    console.error(err);
    res.status(500).json({ error: "Error al obtener historial de cobros" });
  }
});

// Detalle de cuenta de cobro
app.get("/cuentas-cobro/detalle/:cuentaId", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"], tipos: ["Asociado"] }), async (req, res) => {
  const { cuentaId } = req.params;
  try {
    const role = normalizeValue(req.user?.rol);
    if (!["administrador", "coordinador"].includes(role)) {
      const owner = await pool.query(
        "SELECT created_by FROM cuenta_cobro WHERE id = $1",
        [cuentaId]
      );
      const createdBy = owner.rows[0]?.created_by;
      if (!createdBy || String(createdBy) !== String(req.user?.id)) {
        return res.status(403).json({ error: "Acceso denegado" });
      }
    }
    const result = await pool.query(
      `
        SELECT
          rh.id,
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
      [cuentaId]
    );
    res.json(result.rows);
  } catch (err) {
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

  try {
    const ownerResult = await pool.query(
      `
      SELECT
        cc.id,
        cc.created_by,
        cc.fecha_correspondiente,
        cc.created_at,
        cc.datos_adjuntos,
        u.nombre_usuario
      FROM cuenta_cobro cc
      JOIN usuarios u ON u.id = cc.created_by
      WHERE cc.id = $1
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

    const token = await getGraphAccessToken();
    const fechaBase = String(cuenta.fecha_correspondiente || cuenta.created_at || new Date().toISOString()).slice(0, 10);
    const consultorFolder = sanitizePathSegment(cuenta.nombre_usuario || `Consultor_${cuenta.created_by}`, `Consultor_${cuenta.created_by}`);
    const cuentaFolderName = `CuentaCobro_${cuenta.id}_${fechaBase}`;

    let targetPath = sanitizePathSegment(ONEDRIVE_ROOT_FOLDER, "CuentasCobro");
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, "", targetPath);
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, consultorFolder);
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, cuentaFolderName);

    const encodedUser = encodeURIComponent(ONEDRIVE_TARGET_USER);

    const cuentaFileName = sanitizePdfFileName(
      cuenta_pdf_nombre || `CuentaCobroFirmada_${cuenta.id}.pdf`,
      `CuentaCobroFirmada_${cuenta.id}.pdf`
    );
    const seguridadFileName = sanitizePdfFileName(
      seguridad_social_nombre || `SeguridadSocial_${cuenta.id}.pdf`,
      `SeguridadSocial_${cuenta.id}.pdf`
    );

    const cuentaPath = `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(`${targetPath}/${cuentaFileName}`)}:/content`;
    const seguridadPath = `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(`${targetPath}/${seguridadFileName}`)}:/content`;

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
      [JSON.stringify(adjuntos), id]
    );

    res.json({
      ok: true,
      mensaje: "Soportes cargados exitosamente",
      soportes: adjuntos.soportes
    });
  } catch (err) {
    console.error("DEBUG upload cuenta adjuntos:", err.message);
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
    const role = normalizeValue(req.user?.rol);
    if (!["administrador", "coordinador"].includes(role)) {
      const owner = await pool.query(
        "SELECT created_by FROM cuenta_cobro WHERE id = $1",
        [id]
      );
      const createdBy = owner.rows[0]?.created_by;
      if (!createdBy || String(createdBy) !== String(req.user?.id)) {
        return res.status(403).json({ error: "Acceso denegado" });
      }
    }
    const cuentaRes = await pool.query(
      `
      SELECT
        cc.*,
        u.nombre_usuario,
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
      [id]
    );

    const cuenta = cuentaRes.rows[0];
    if (!cuenta) {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }

    const detallesRes = await pool.query(
      `
      SELECT
        rh.id,
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
      [id]
    );

    const detalles = detallesRes.rows || [];
    const formatNumber = (val) =>
      new Intl.NumberFormat("es-CO", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(Number(val || 0));

    const formatDate = (d) => {
      if (!d) return "";
      const date = new Date(d);
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
    };

    const totalNumeros = Number(cuenta.total_cuenta_cobro || 0);
    const totalLetras = cuenta.total_letras || buildTotalLetras(totalNumeros, cuenta.moneda_cobro || "COP");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="CuentaCobro_${id}.pdf"`);

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    doc.fontSize(12).text(`Cuenta de Cobro NÂ° ${cuenta.id}`, { align: "right" });
    doc.moveDown(1);
    doc.fontSize(11).text(`${formatDate(cuenta.created_at)}, ${cuenta.ciudad_cobro || ""}`);
    doc.moveDown(1.5);

    doc.fontSize(12).font("Helvetica-Bold").text("SILVER CONSULTING S.A.S.", { align: "center" });
    doc.text("NIT 901.149.190-0", { align: "center" });
    doc.moveDown(1.5);

    doc.font("Helvetica-Bold").text("DEBE A:", { align: "center" });
    doc.font("Helvetica").text(cuenta.nombre_usuario || "", { align: "center" });
    doc.text(`${cuenta.tipo_documento || "Documento"}: ${cuenta.cedula || ""}`, { align: "center" });
    doc.moveDown(1);

    doc.font("Helvetica-Bold").text("LA SUMA DE:", { align: "center" });
    doc.font("Helvetica-Bold").text(`${formatNumber(totalNumeros)} (${totalLetras})`, { align: "center" });
    doc.moveDown(1.5);

    doc.font("Helvetica-Bold").text("Por concepto de:", { continued: true });
    doc.font("Helvetica").text(
      ` Honorarios de Consultorías: ${cuenta.descripcion || "Cuenta de cobro"} del ${cuenta.fecha_periodo_inicio || ""} al ${cuenta.fecha_periodo_fin || ""}`
    );
    doc.moveDown(1);

    doc.font("Helvetica").text(`Dirección: ${cuenta.direccion || "—"}`);
    doc.text(`Teléfono: ${cuenta.telefono || "—"}`);
    doc.text(`No de Cuenta Bancaria: ${cuenta.nro_cuenta_bancaria || "—"}`);
    doc.text(`Banco: ${cuenta.banco || "—"}`);
    doc.text(`Tipo de Cuenta: ${cuenta.tipo_cuenta || "—"}`);
    doc.text(`Titular: ${cuenta.nombre_usuario || "—"}`);
    doc.text(`${cuenta.tipo_documento || "Documento"}: ${cuenta.cedula || "—"}`);
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
    detalles.forEach((d) => {
      doc.text(d.cliente || "â€”", colX.cliente, y, { width: 120 });
      doc.text(d.consultor_responsable || "â€”", colX.consultor, y, { width: 120 });
      doc.text(d.tipo_asignacion || "â€”", colX.tipo, y, { width: 90 });
      doc.text(d.nro_caso_int_ext || "â€”", colX.caso, y, { width: 60 });
      const cantidad = d.cantidad_dias_reportados > 0
        ? `${d.cantidad_dias_reportados} D`
        : `${Number(d.horas_reportadas || 0)} H`;
      doc.text(cantidad, colX.cant, y, { width: 40, align: "right" });
      doc.text(formatNumber(d.total_cobrar), colX.total, y, { width: 60, align: "right" });
      y += 14;
      if (y > doc.page.height - 60) {
        doc.addPage();
        y = 50;
      }
    });

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al generar PDF" });
  }
});


// Reportes pendientes para coordinador
app.get("/aprobaciones/pendientes", requireAccess({ roles: ["Coordinador"] }), async (req, res) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(`
      SELECT
        rh.id,
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
    if (!estado) {
      return res.status(400).json({ error: "Falta estado" });
    }
    const result = await pool.query(
      `UPDATE reporte_horas
       SET estado_reporte = $1,
           motivo_rechazo = $2
       WHERE id = $3
       RETURNING *`,
      [estado, motivo || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Reporte no encontrado" });
    }

    const registroId = result.rows[0]?.id_registro_asignacion || null;
    if (registroId) {
      try {
        const estados = await getEstadoAsignacionValues();
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
          [estado, registroId, estados.proceso, estados.abierto]
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
      [id]
    );
    const info = detalle.rows[0];
    if (info?.consultor_email) {
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
          `Detalle: ${buildReporteResumen(info)}\n` +
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
            { label: "Resumen", value: buildReporteResumen(info) },
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

    res.json(result.rows[0]);
  } catch (err) {
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
           estado = $11,
           observacion = $12,
           total_pagar = $13
       WHERE id = $14
       RETURNING *`,
      [
        consultor_responsable_id || null,
        id_modulo || null,
        fecha_inicio || null,
        fecha_fin || null,
        cantidad_dias || null,
        valor_hora || null,
        valor_dia || null,
        nro_caso_interno || null,
        nro_caso_cliente || null,
        tipoServicioNormalizado,
        estadoNormalizado,
        observacion || null,
        total_pagar || null,
        id
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar asignación" });
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
    const estados = await getEstadoAsignacionValues();
    if (!id_consultoria || !consultor_responsable_id || !id_modulo) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }
    const tipoServicioNormalizado = normalizeTipoServicioInput(tipo_servicio || "Servicio");
    if (!tipoServicioNormalizado) {
      return res.status(400).json({ error: "Tipo de servicio inválido" });
    }

    const meta = await pool.query(
      "SELECT id_cliente, id_tipo_asignacion FROM consultorias WHERE id = $1 AND activo = true",
      [id_consultoria]
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
      [consultor_responsable_id, id_modulo, clienteId, tipoAsignacionId, estados.abierto, estados.proceso]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe asignación para este consultor, cliente y módulo" });
    }

    const result = await pool.query(
      `INSERT INTO registro_asignaciones
        (id_consultoria, id_modulo, consultor_responsable_id, fecha_inicio, fecha_fin,
         cantidad_dias, horas_asignadas, valor_hora, valor_dia, tipo_servicio, total_pagar, estado, aprobar_coordinador)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::tipo_estado_asignacion,'Pendiente')
       RETURNING *`,
      [
        id_consultoria,
        id_modulo,
        consultor_responsable_id,
        fecha_inicio || null,
        fecha_fin || null,
        cantidad_dias || null,
        horas_asignadas || null,
        valor_hora || null,
        valor_dia || null,
        tipoServicioNormalizado,
        total_pagar || null,
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
      [consultor_responsable_id, id_modulo, id_consultoria]
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

    res.json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear asignación" });
  }
});


// Ruta Default para SPA (Siempre al final)
app.get("/", (req, res) => {
  res.json({ ok: true, message: "API activo. Abre el frontend en http://localhost:3000" });
});

/*const PORT = process.env.BACK_PORT || 4000;
app.listen(PORT, () => {
  console.log(`âœ… Backend listo en http://localhost:${PORT}`);
});
*/

/* ===============================
   SERVIDOR (CAMBIO CRÃTICO PARA AZURE)
=============================== */

// 1. Usar process.env.PORT (Obligatorio para Azure)
// 2. Mantener 4000 como fallback para tu entorno local
const port = process.env.PORT || 4000;

// 3. AÃ±adir "0.0.0.0" asegura que el contenedor acepte conexiones externas
app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});

