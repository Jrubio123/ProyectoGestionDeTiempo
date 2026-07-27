/**
 * FASE 0 - Diagnostico de firmas Click&Sign para cuentas de cobro.
 *
 * SOLO LECTURA: ejecuta unicamente GET_SIGNATURE_STATUS, GET_SIGNATURE,
 * GET_FILE_LIST y (opcional, con --descargar) GET_FILE. No escribe en la
 * base de datos, no cancela ni inicia firmas, no sube nada a OneDrive.
 *
 * Todos los archivos de salida (reporte JSON y PDFs descargados) se escriben
 * FUERA del repositorio, en el directorio temporal del sistema, salvo que se
 * indique otra carpeta con --salida.
 *
 * Objetivo: comparar casos legitimos (Jovanny) contra falsos positivos
 * (Luis, Marisol) y definir con datos reales:
 *   1. Que devuelve exactamente `signature_status` (campo oficial) en cada caso.
 *   2. Que `file_group` reales entrega Click&Sign por archivo.
 *   3. Si GET_FILE_LIST acepta el parametro `file_group` en el plan contratado.
 *   4. Cual archivo contiene realmente la firma (con --descargar, para abrirlos).
 *
 * Uso (desde back/):
 *   node scripts/diagnostico-firma-clicksign.js --cuenta <public_id> [--cuenta <public_id> ...]
 *   node scripts/diagnostico-firma-clicksign.js --manual "Jovanny|<request_id>|<contract_id>|<signature_id>"
 *   Flags opcionales:
 *     --descargar                 Descarga cada archivo hallado (a <salida>/pdfs).
 *     --salida <carpeta>          Carpeta base de salida (default: temp del sistema).
 *     --grupos SIGNED,SIGNED_ONCE Sobrescribe la lista de grupos a consultar.
 *
 * Con NODE_ENV=production carga .env_produccion (igual que src/index.js).
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");

const envFile = process.env.NODE_ENV === "production" ? ".env_produccion" : ".env";
require("dotenv").config({ path: path.resolve(process.cwd(), envFile) });

const CLICKSIGN_API_BASE = String(process.env.CLICKSIGN_API_BASE || "https://api.lleida.net/cs/v1").trim().replace(/\/+$/, "");
const CLICKSIGN_API_KEY = String(process.env.CLICKSIGN_API_KEY || "").trim();
const CLICKSIGN_USER = String(process.env.CLICKSIGN_USER || "").trim();

// Grupos candidatos segun documentacion oficial (https://api.lleida.net/dtd/clickandsign/v1/en/).
// La salida de este script define la allowlist definitiva.
const GRUPOS_CANDIDATOS = [
  "SIGNED",
  "SIGNED_ONCE",
  "SIGNATURE_STAMP",
  "SIGNATORY_STAMP",
  "SIGNATURE_PKI",
  "SIGNATURE_BIOMETRIC"
];

if (!CLICKSIGN_API_KEY || !CLICKSIGN_USER) {
  console.error("Faltan variables CLICKSIGN_API_KEY o CLICKSIGN_USER en el entorno.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const args = {
    cuentas: [],
    manuales: [],
    descargar: false,
    salida: path.join(os.tmpdir(), "diagnostico-firma-clicksign", timestamp),
    grupos: GRUPOS_CANDIDATOS
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cuenta" && argv[i + 1]) {
      args.cuentas.push(String(argv[++i]).trim());
    } else if (arg === "--manual" && argv[i + 1]) {
      const [label, requestId, contractId, signatureId] = String(argv[++i]).split("|").map((s) => String(s || "").trim());
      args.manuales.push({ label: label || "manual", request_id: requestId || "", contract_id: contractId || "", signature_id: signatureId || "" });
    } else if (arg === "--descargar") {
      args.descargar = true;
    } else if (arg === "--salida" && argv[i + 1]) {
      args.salida = path.resolve(String(argv[++i]).trim());
    } else if (arg === "--grupos" && argv[i + 1]) {
      args.grupos = String(argv[++i]).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else {
      console.error(`Argumento no reconocido: ${arg}`);
      process.exit(1);
    }
  }
  if (args.cuentas.length === 0 && args.manuales.length === 0) {
    console.error("Debe indicar al menos un --cuenta <public_id> o --manual \"label|request_id|contract_id|signature_id\".");
    process.exit(1);
  }
  return args;
}

// ---------------------------------------------------------------------------
// HTTP minimo (replica jsonRequest/binaryRequest de src/index.js, sin importarlo)
// ---------------------------------------------------------------------------
function buildAuthHeaders() {
  return {
    Authorization: `x-api-key ${CLICKSIGN_API_KEY}`,
    "x-api-key": CLICKSIGN_API_KEY,
    "Content-Type": "application/json; charset=utf-8",
    Accept: "application/json"
  };
}

function postRaw(pathName, body, timeoutMs = 25000) {
  const url = `${CLICKSIGN_API_BASE}/${String(pathName).replace(/^\/+/, "")}`;
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const payload = Buffer.from(JSON.stringify(body || {}), "utf8");
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: { ...buildAuthHeaders(), "Content-Length": payload.length }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          let data = null;
          try { data = JSON.parse(buffer.toString("utf8")); } catch (_) { /* binario o no-JSON */ }
          resolve({ httpStatus: res.statusCode, data, buffer });
        });
      }
    );
    req.on("error", (err) => resolve({ httpStatus: 0, error: err.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("timeout")); });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Inspeccion de respuestas
// ---------------------------------------------------------------------------
// Recorre el objeto y reporta TODO campo cuyo nombre contenga "status",
// para distinguir el `status` HTTP ("Success") del `signature_status` oficial.
function collectStatusFields(source, basePath = "", depth = 0, out = []) {
  if (!source || typeof source !== "object" || depth > 6 || out.length >= 40) return out;
  for (const [key, value] of Object.entries(source)) {
    const current = basePath ? `${basePath}.${key}` : key;
    if (/status/i.test(key) && (typeof value === "string" || typeof value === "number")) {
      out.push({ path: current, value: String(value) });
    }
    if (value && typeof value === "object") collectStatusFields(value, current, depth + 1, out);
  }
  return out;
}

// Extrae entradas de archivos reportando el campo de grupo/tipo CRUDO, sin heuristicas de nombre.
function collectFileEntries(source) {
  const listas = [
    ["file_list.files", source?.file_list?.files],
    ["data.file_list.files", source?.data?.file_list?.files],
    ["result.file_list.files", source?.result?.file_list?.files],
    ["signature.file", source?.signature?.file],
    ["signature.files", source?.signature?.files],
    ["data.signature.file", source?.data?.signature?.file],
    ["data.signature.files", source?.data?.signature?.files],
    ["file", source?.file],
    ["files", source?.files]
  ];
  const entries = [];
  for (const [origen, value] of listas) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      entries.push({
        lista: origen,
        file_id: String(item.file_id || item.id || "").trim(),
        file_group_crudo: String(item.file_group || item.group || "").trim(),
        file_type_crudo: String(item.file_type || item.type || "").trim(),
        filename: String(item.filename || item.file_name || item.name || "").trim()
      });
    }
  }
  return entries;
}

function pickSignatureStatusOficial(source) {
  // UNICAMENTE paths del campo oficial signature_status. Nunca "status" generico.
  const paths = [
    source?.signature_status,
    source?.signature?.signature_status,
    source?.data?.signature_status,
    source?.data?.signature?.signature_status,
    source?.result?.signature_status,
    source?.result?.signature?.signature_status
  ];
  for (const value of paths) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Consultas por candidato
// ---------------------------------------------------------------------------
function reqId(prefix) {
  return `diag-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

async function consultarSignatureStatus(candidato) {
  const sid = /^\d+$/.test(candidato.signature_id) ? candidato.signature_id : "";
  if (!sid) {
    return { disponible: false, nota: "Sin signature_id numerico: GET_SIGNATURE_STATUS no aplicable." };
  }
  const res = await postRaw("get_signature_status", {
    request: "GET_SIGNATURE_STATUS",
    request_id: reqId("status"),
    user: CLICKSIGN_USER,
    signature_id: sid
  });
  return {
    disponible: true,
    http_status: res.httpStatus,
    error: res.error || null,
    signature_status_oficial: pickSignatureStatusOficial(res.data),
    todos_los_campos_status: collectStatusFields(res.data),
    archivos_en_respuesta: collectFileEntries(res.data)
  };
}

async function consultarGetSignature(candidato) {
  const intentos = [];
  if (candidato.contract_id) intentos.push({ signature: { contract_id: candidato.contract_id } });
  if (candidato.request_id) intentos.push({ signature: { request_id: candidato.request_id } });
  for (const extra of intentos) {
    const res = await postRaw("get_signature", {
      request: "GET_SIGNATURE",
      request_id: reqId("sig"),
      user: CLICKSIGN_USER,
      ...extra
    });
    const statusFields = collectStatusFields(res.data);
    const archivos = collectFileEntries(res.data);
    if (res.httpStatus >= 200 && res.httpStatus < 300 && (statusFields.length || archivos.length)) {
      return {
        variante: JSON.stringify(extra),
        http_status: res.httpStatus,
        signature_status_oficial: pickSignatureStatusOficial(res.data),
        todos_los_campos_status: statusFields,
        archivos_en_respuesta: archivos
      };
    }
  }
  return { nota: "GET_SIGNATURE sin respuesta util en ninguna variante." };
}

async function consultarFileList(candidato, fileGroup = "") {
  const sid = /^\d+$/.test(candidato.signature_id) ? candidato.signature_id : "";
  const bodies = [];
  const base = { request: "GET_FILE_LIST", user: CLICKSIGN_USER };
  if (sid) bodies.push({ ...base, request_id: reqId("fl"), signature_id: sid });
  if (candidato.contract_id) bodies.push({ ...base, request_id: reqId("fl"), contract_id: candidato.contract_id });
  if (candidato.request_id) bodies.push({ ...base, request_id: reqId("fl"), request_id_search: candidato.request_id });

  const resultados = [];
  for (const body of bodies) {
    const finalBody = fileGroup ? { ...body, file_group: fileGroup } : body;
    const res = await postRaw("get_file_list", finalBody);
    const archivos = collectFileEntries(res.data);
    resultados.push({
      variante: Object.keys(finalBody).filter((k) => !["request", "request_id", "user"].includes(k)).join(","),
      http_status: res.httpStatus,
      error: res.error || null,
      status_fields: collectStatusFields(res.data).slice(0, 6),
      archivos
    });
    if (archivos.length > 0) break; // primera variante con datos es suficiente para el reporte
  }
  return resultados;
}

async function descargarArchivo(fileId, destino, nombreBase) {
  const res = await postRaw("get_file", {
    request: "GET_FILE",
    request_id: reqId("file"),
    user: CLICKSIGN_USER,
    file_id: fileId
  });
  let buffer = null;
  if (res.buffer && res.buffer.slice(0, 5).toString("latin1").startsWith("%PDF-")) {
    buffer = res.buffer;
  } else if (res.data) {
    const rawBase64 =
      res.data?.file?.content || res.data?.file?.file_content || res.data?.content ||
      res.data?.data?.file?.content || res.data?.data?.content || "";
    if (rawBase64) {
      try { buffer = Buffer.from(String(rawBase64), "base64"); } catch (_) { }
    }
  }
  if (!buffer || buffer.length === 0) {
    return { descargado: false, http_status: res.httpStatus };
  }
  const esPdf = buffer.slice(0, 5).toString("latin1").startsWith("%PDF-");
  const nombre = `${nombreBase}`.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || `archivo_${fileId.slice(-8)}`;
  const ruta = path.join(destino, nombre.endsWith(".pdf") ? nombre : `${nombre}.pdf`);
  fs.writeFileSync(ruta, buffer);
  return { descargado: true, es_pdf: esPdf, bytes: buffer.length, ruta };
}

// ---------------------------------------------------------------------------
// Candidatos desde BD (firma activa + reseteos, incluyendo anidados)
// ---------------------------------------------------------------------------
function extraerCandidatos(adjuntos = {}) {
  const out = [];
  const push = (firma, origen) => {
    if (!firma || typeof firma !== "object") return;
    const candidato = {
      origen,
      request_id: String(firma.request_id || "").trim(),
      contract_id: String(firma.contract_id || "").trim(),
      signature_id: String(firma.signature_id || "").trim(),
      estado_registrado: firma.estado || null,
      ultimo_evento: firma.ultimo_evento || null,
      no_reconciliar: firma.no_reconciliar === true
    };
    if (candidato.request_id || candidato.contract_id || candidato.signature_id) out.push(candidato);
    if (firma.firma_original && typeof firma.firma_original === "object") {
      push(firma.firma_original, `${origen}.firma_original`);
    }
  };
  push(adjuntos.firma, "firma");
  const reseteos = Array.isArray(adjuntos.firma_reseteos) ? adjuntos.firma_reseteos : [];
  reseteos.forEach((f, i) => push(f, `firma_reseteos[${i}]`));
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const casos = [];

  if (args.cuentas.length > 0) {
    const { pool } = require("../src/db");
    try {
      for (const publicId of args.cuentas) {
        const result = await pool.query(
          `SELECT cc.public_id, cc.estado, cc.updated_at, u.nombre_usuario, cc.datos_adjuntos
           FROM cuenta_cobro cc
           LEFT JOIN usuarios u ON u.id = cc.created_by
           WHERE cc.public_id = $1`,
          [publicId]
        );
        const row = result.rows[0];
        if (!row) {
          console.warn(`[AVISO] Cuenta no encontrada en BD: ${publicId}`);
          continue;
        }
        casos.push({
          label: `${row.nombre_usuario || "?"} (${String(row.public_id).split("-")[0]}, estado=${row.estado})`,
          candidatos: extraerCandidatos(row.datos_adjuntos || {})
        });
      }
    } finally {
      await pool.end();
    }
  }

  for (const manual of args.manuales) {
    casos.push({ label: manual.label, candidatos: [{ origen: "manual", ...manual, no_reconciliar: false }] });
  }

  // Toda la salida va FUERA del repositorio (temp del sistema o --salida).
  fs.mkdirSync(args.salida, { recursive: true });
  const carpetaPdfs = path.join(args.salida, "pdfs");
  if (args.descargar) fs.mkdirSync(carpetaPdfs, { recursive: true });

  const reporte = {
    generado_en: new Date().toISOString(),
    api_base: CLICKSIGN_API_BASE,
    grupos_consultados: args.grupos,
    casos: []
  };

  for (const caso of casos) {
    console.log(`\n${"=".repeat(70)}\nCASO: ${caso.label}\n${"=".repeat(70)}`);
    const casoOut = { label: caso.label, candidatos: [] };

    if (caso.candidatos.length === 0) {
      console.log("  Sin identificadores de firma (ni activa ni en reseteos).");
    }

    for (const candidato of caso.candidatos) {
      console.log(`\n--- Candidato [${candidato.origen}] request_id=${candidato.request_id || "-"} contract_id=${candidato.contract_id || "-"} signature_id=${candidato.signature_id || "-"}`);
      const salida = { ...candidato };

      // 1. Estado oficial
      salida.signature_status = await consultarSignatureStatus(candidato);
      if (salida.signature_status.disponible) {
        console.log(`  GET_SIGNATURE_STATUS -> HTTP ${salida.signature_status.http_status}`);
        console.log(`    signature_status oficial: "${salida.signature_status.signature_status_oficial || "(vacio)"}"`);
        for (const f of salida.signature_status.todos_los_campos_status) {
          console.log(`    campo status: ${f.path} = "${f.value}"`);
        }
      } else {
        console.log(`  GET_SIGNATURE_STATUS: ${salida.signature_status.nota}`);
      }

      // 2. GET_SIGNATURE (comparacion / casos sin signature_id)
      salida.get_signature = await consultarGetSignature(candidato);
      if (salida.get_signature.http_status) {
        console.log(`  GET_SIGNATURE (${salida.get_signature.variante}) -> HTTP ${salida.get_signature.http_status}`);
        console.log(`    signature_status oficial: "${salida.get_signature.signature_status_oficial || "(vacio)"}"`);
        for (const f of (salida.get_signature.todos_los_campos_status || []).slice(0, 10)) {
          console.log(`    campo status: ${f.path} = "${f.value}"`);
        }
      }

      // 3. GET_FILE_LIST sin filtro (lo que ve el codigo actual)
      salida.file_list_sin_filtro = await consultarFileList(candidato, "");
      const sinFiltro = salida.file_list_sin_filtro.find((r) => r.archivos.length > 0);
      console.log(`  GET_FILE_LIST sin file_group: ${sinFiltro ? `${sinFiltro.archivos.length} archivo(s)` : "sin archivos"}`);
      for (const a of sinFiltro?.archivos || []) {
        console.log(`    - file_id=${a.file_id} group="${a.file_group_crudo}" type="${a.file_type_crudo}" nombre="${a.filename}"`);
      }

      // 4. GET_FILE_LIST por cada grupo candidato (acepta el parametro el plan contratado?)
      salida.file_list_por_grupo = {};
      for (const grupo of args.grupos) {
        const porGrupo = await consultarFileList(candidato, grupo);
        salida.file_list_por_grupo[grupo] = porGrupo;
        const conDatos = porGrupo.find((r) => r.archivos.length > 0);
        const resumen = conDatos
          ? `${conDatos.archivos.length} archivo(s)`
          : `sin archivos (HTTP ${porGrupo[0]?.http_status ?? "?"})`;
        console.log(`  GET_FILE_LIST file_group=${grupo}: ${resumen}`);
        for (const a of conDatos?.archivos || []) {
          console.log(`    - file_id=${a.file_id} group="${a.file_group_crudo}" nombre="${a.filename}"`);
        }
      }

      // 5. Descarga opcional para inspeccion visual
      if (args.descargar) {
        salida.descargas = [];
        const vistos = new Set();
        const todos = [
          ...(sinFiltro?.archivos || []),
          ...Object.values(salida.file_list_por_grupo).flatMap((rs) => rs.flatMap((r) => r.archivos))
        ];
        for (const a of todos) {
          if (!a.file_id || vistos.has(a.file_id)) continue;
          vistos.add(a.file_id);
          const etiqueta = `${caso.label.split(" ")[0]}_${candidato.origen}_${a.file_group_crudo || a.file_type_crudo || "sin-grupo"}_${a.file_id.slice(-8)}_${a.filename}`;
          const dl = await descargarArchivo(a.file_id, carpetaPdfs, etiqueta);
          salida.descargas.push({ file_id: a.file_id, ...dl });
          console.log(`  Descarga ${a.file_id.slice(-8)}: ${dl.descargado ? `${dl.bytes} bytes -> ${dl.ruta}` : `fallo (HTTP ${dl.http_status})`}`);
        }
      }

      casoOut.candidatos.push(salida);
    }
    reporte.casos.push(casoOut);
  }

  const dumpPath = path.join(args.salida, "diagnostico-firma.json");
  fs.writeFileSync(dumpPath, JSON.stringify(reporte, null, 2), "utf8");
  console.log(`\n${"=".repeat(70)}\nReporte JSON completo: ${dumpPath}`);
  console.log("Recordatorio: el campo confiable es signature_status; el \"status\" generico puede ser solo el resultado HTTP (Success).");
}

main().catch((err) => {
  console.error("Error en diagnostico:", err?.message || err);
  process.exit(1);
});
