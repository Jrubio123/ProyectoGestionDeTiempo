const http = require("http");
const https = require("https");

const SIGNED_FILE_GROUPS_KNOWN = new Set([
  "SIGNED",
  "SIGNED_ONCE",
  "SIGNATURE_STAMP",
  "SIGNATORY_STAMP",
  "SIGNATURE_PKI",
  "SIGNATURE_BIOMETRIC"
]);

const REJECTED_STATUS_VALUES = new Set([
  "rejected",
  "declined",
  "cancelled",
  "canceled",
  "expired",
  "failed",
  "error",
  "rechazado",
  "cancelado",
  "expirado"
]);

let allowlistInvalidLogged = false;

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
  } catch (_) {
    return { raw: String(rawText || "") };
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

function parseBase64Buffer(rawValue) {
  const normalized = normalizeBase64Input(rawValue);
  if (!normalized) return null;
  try {
    const buffer = Buffer.from(normalized, "base64");
    return buffer.length ? buffer : null;
  } catch (_) {
    return null;
  }
}

function sanitizePdfFileName(value, fallback = "DocumentoClickSign.pdf") {
  const safe = String(value || fallback)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*#%{}~]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.+/g, ".")
    .trim();
  const name = safe || fallback;
  return name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
}

function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.slice(0, 4).toString("utf8") === "%PDF";
}

function buildApiUrl(config, pathName) {
  const base = String(config.apiBase || process.env.CLICKSIGN_API_BASE || "https://api.lleida.net/cs/v1")
    .trim()
    .replace(/\/+$/, "");
  const suffix = String(pathName || "").replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

function buildAuthHeaders(config, includeJsonHeaders = true) {
  const apiKey = String(config.apiKey || process.env.CLICKSIGN_API_KEY || "").trim();
  const headers = {
    Authorization: `x-api-key ${apiKey}`,
    "x-api-key": apiKey
  };
  if (includeJsonHeaders) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    headers.Accept = "application/json";
  }
  return headers;
}

function defaultJsonRequest({ method = "POST", url, headers = {}, body = null, timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body === null || body === undefined
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error("HTTP_TIMEOUT")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function defaultBinaryRequest({ method = "POST", url, headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body === null || body === undefined
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
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const status = Number(res.statusCode || 0);
          const buffer = Buffer.concat(chunks);
          if (status >= 200 && status < 300) {
            resolve({ status, buffer, headers: res.headers || {} });
            return;
          }
          const err = new Error(`HTTP ${status} ${method} ${parsed.pathname}`);
          err.status = status;
          err.response = parseJsonSafe(buffer.toString("utf8"));
          reject(err);
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("HTTP_TIMEOUT")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getResponseBody(response) {
  if (
    response &&
    typeof response === "object" &&
    !Buffer.isBuffer(response) &&
    typeof response.status === "number" &&
    Object.prototype.hasOwnProperty.call(response, "data")
  ) {
    return response.data || {};
  }
  return response || {};
}

function normalizeOfficialSignatureStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "signed") return "signed";
  if (REJECTED_STATUS_VALUES.has(raw)) return "rejected";
  return "pending";
}

function pickOfficialSignatureStatus(source) {
  return pickStringByPaths(source, [
    "signature_status",
    "signature.signature_status",
    "data.signature_status",
    "data.signature.signature_status",
    "result.signature_status",
    "result.signature.signature_status",
    "result.data.signature_status",
    "result.data.signature.signature_status"
  ]);
}

function extractSignatureId(source) {
  return pickStringByPaths(source, [
    "signature_id",
    "signature.signature_id",
    "signature.id",
    "data.signature_id",
    "data.signature.signature_id",
    "data.signature.id",
    "result.signature_id",
    "result.signature.signature_id",
    "result.signature.id"
  ]);
}

function buildRequestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function buildGetSignatureRequests({ signatureId = "", requestId = "", contractId = "" }, config) {
  const user = String(config.user || process.env.CLICKSIGN_USER || "").trim();
  const sid = /^\d+$/.test(String(signatureId || "").trim()) ? String(signatureId).trim() : "";
  const requests = [];
  if (sid) {
    requests.push({
      path: "get_signature",
      body: { request: "GET_SIGNATURE", request_id: buildRequestId("signature-sid"), user, signature_id: sid }
    });
    requests.push({
      path: "get_signature",
      body: { request: "GET_SIGNATURE", request_id: buildRequestId("signature-sid"), user, signature: { signature_id: sid } }
    });
  }
  if (contractId) {
    requests.push({
      path: "get_signature",
      body: { request: "GET_SIGNATURE", request_id: buildRequestId("signature-cid"), user, contract_id: contractId }
    });
    requests.push({
      path: "get_signature",
      body: { request: "GET_SIGNATURE", request_id: buildRequestId("signature-cid"), user, signature: { contract_id: contractId } }
    });
  }
  if (requestId) {
    requests.push({
      path: "get_signature",
      body: { request: "GET_SIGNATURE", request_id: buildRequestId("signature-rid"), user, request_id_search: requestId }
    });
    requests.push({
      path: "get_signature",
      body: { request: "GET_SIGNATURE", request_id: buildRequestId("signature-rid"), user, signature: { request_id: requestId } }
    });
  }
  return requests;
}

function parseSignedFileGroups(rawValue, logger) {
  const values = String(rawValue || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  const invalid = values.filter((item) => !SIGNED_FILE_GROUPS_KNOWN.has(item));
  if (values.length === 0 || invalid.length > 0) {
    if (!allowlistInvalidLogged) {
      allowlistInvalidLogged = true;
      logger?.error?.("[firma-cuenta] CLICKSIGN_SIGNED_FILE_GROUPS invalida o vacia; autocierre por firma verificada bloqueado.");
    }
    return {
      valid: false,
      groups: [],
      reason: "allowlist_invalida",
      invalid
    };
  }
  return {
    valid: true,
    groups: [...new Set(values)],
    reason: "",
    invalid: []
  };
}

function normalizeFileEntries(source) {
  const candidates = [
    getByPath(source, "file_list.files"),
    getByPath(source, "data.file_list.files"),
    getByPath(source, "result.file_list.files"),
    getByPath(source, "files"),
    getByPath(source, "data.files"),
    getByPath(source, "result.files"),
    getByPath(source, "file"),
    getByPath(source, "data.file"),
    getByPath(source, "result.file")
  ];
  const entries = [];
  for (const candidate of candidates) {
    const items = Array.isArray(candidate) ? candidate : (candidate && typeof candidate === "object" ? [candidate] : []);
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const fileId = String(item.file_id || item.fileId || item.id || item.file?.file_id || "").trim();
      const fileGroup = String(item.file_group || item.fileGroup || item.group || item.file?.file_group || item.file?.group || "")
        .trim()
        .replace(/\s+/g, "_")
        .toUpperCase();
      const fileType = String(item.file_type || item.fileType || item.type || item.file?.file_type || item.file?.type || "")
        .trim()
        .replace(/\s+/g, "_")
        .toLowerCase();
      const fileName = sanitizePdfFileName(
        item.filename || item.file_name || item.fileName || item.name || item.file?.filename || "DocumentoClickSign.pdf",
        "DocumentoClickSign.pdf"
      );
      if (!fileId) continue;
      entries.push({ fileId, fileGroup, fileType, fileName });
    }
  }
  return entries;
}

function normalizeLooseFileNameKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function summarizeFileCatalogEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    file_group: entry.fileGroup || "",
    file_name: entry.fileName || "",
    file_id_tail: String(entry.fileId || "").slice(-8)
  }));
}

function extractPdfBufferFromResponse(response) {
  const rawBuffer = Buffer.isBuffer(response)
    ? response
    : (Buffer.isBuffer(response?.buffer) ? response.buffer : null);
  if (isPdfBuffer(rawBuffer)) return rawBuffer;
  if (!rawBuffer) return null;
  const data = parseJsonSafe(rawBuffer.toString("utf8"));
  const rawBase64 = pickStringByPaths(data, [
    "file.content",
    "file.file_content",
    "content",
    "data.file.content",
    "data.file.file_content",
    "data.content",
    "result.file.content",
    "result.content"
  ]);
  const buffer = parseBase64Buffer(rawBase64);
  return isPdfBuffer(buffer) ? buffer : null;
}

function normalizeCancelStatusValue(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function isCancelSuccessBody(body) {
  const rawStatus = pickStringByPaths(body, [
    "signature_status",
    "signature.signature_status",
    "data.signature_status",
    "data.signature.signature_status",
    "result.signature_status",
    "result.signature.signature_status",
    "status",
    "data.status",
    "result.status",
    "message",
    "data.message",
    "result.message"
  ]);
  const normalized = normalizeCancelStatusValue(rawStatus);
  if (["cancelled", "canceled", "cancelado", "expired", "expirado", "success", "ok"].includes(normalized)) {
    return true;
  }
  const text = JSON.stringify(body || {}).toLowerCase();
  return text.includes("already cancelled") ||
    text.includes("already canceled") ||
    text.includes("ya cancel") ||
    text.includes("expired") ||
    text.includes("expirad");
}

function summarizeCancelResponse(body, fallbackError = "") {
  const rawStatus = pickStringByPaths(body, [
    "signature_status",
    "signature.signature_status",
    "data.signature_status",
    "data.signature.signature_status",
    "status",
    "data.status",
    "result.status",
    "message",
    "data.message",
    "result.message"
  ]);
  return {
    rawStatus: rawStatus || null,
    message: pickStringByPaths(body, ["message", "data.message", "result.message", "error", "data.error"]) || fallbackError || null
  };
}

function createClickSignFirmaVerificadaService(deps = {}) {
  const logger = deps.logger || console;
  const config = {
    apiBase: deps.config?.apiBase || process.env.CLICKSIGN_API_BASE || "https://api.lleida.net/cs/v1",
    apiKey: deps.config?.apiKey || process.env.CLICKSIGN_API_KEY || "",
    user: deps.config?.user || process.env.CLICKSIGN_USER || "",
    signedFileGroups: deps.config?.signedFileGroups ?? process.env.CLICKSIGN_SIGNED_FILE_GROUPS ?? ""
  };
  const httpClient = {
    jsonRequest: deps.httpClient?.jsonRequest || defaultJsonRequest,
    binaryRequest: deps.httpClient?.binaryRequest || defaultBinaryRequest
  };

  async function postJson(pathName, body) {
    return getResponseBody(await httpClient.jsonRequest({
      method: "POST",
      url: buildApiUrl(config, pathName),
      headers: buildAuthHeaders(config),
      body
    }));
  }

  async function postBinary(pathName, body) {
    return httpClient.binaryRequest({
      method: "POST",
      url: buildApiUrl(config, pathName),
      headers: buildAuthHeaders(config),
      body
    });
  }

  async function consultarSignatureStatusOficial({ signatureId = "", requestId = "", contractId = "" } = {}) {
    const user = String(config.user || "").trim();
    const sid = /^\d+$/.test(String(signatureId || "").trim()) ? String(signatureId).trim() : "";
    const diagnostics = [];

    if (sid) {
      const statusRequests = [
        { request: "GET_SIGNATURE_STATUS", request_id: buildRequestId("signature-status"), user, signature_id: sid },
        { request: "GET_SIGNATURE_STATUS", request_id: buildRequestId("signature-status"), user, signature: { signature_id: sid } }
      ];
      for (const body of statusRequests) {
        try {
          const response = await postJson("get_signature_status", body);
          const rawStatus = pickOfficialSignatureStatus(response);
          const resolvedSignatureId = extractSignatureId(response) || sid;
          if (rawStatus) {
            return {
              status: normalizeOfficialSignatureStatus(rawStatus),
              normalizedStatus: normalizeOfficialSignatureStatus(rawStatus),
              rawStatus,
              signatureId: resolvedSignatureId || sid || null,
              source: "get_signature_status",
              diagnostics
            };
          }
          diagnostics.push({ source: "get_signature_status", reason: "sin_signature_status" });
        } catch (err) {
          diagnostics.push({ source: "get_signature_status", reason: err?.message || "error" });
        }
      }
    }

    const signatureRequests = buildGetSignatureRequests({ signatureId: sid, requestId, contractId }, config);
    for (const request of signatureRequests) {
      try {
        const response = await postJson(request.path, request.body);
        const rawStatus = pickOfficialSignatureStatus(response);
        const resolvedSignatureId = extractSignatureId(response) || sid || "";
        if (rawStatus) {
          return {
            status: normalizeOfficialSignatureStatus(rawStatus),
            normalizedStatus: normalizeOfficialSignatureStatus(rawStatus),
            rawStatus,
            signatureId: resolvedSignatureId || null,
            source: "get_signature",
            diagnostics
          };
        }
        diagnostics.push({ source: "get_signature", reason: "sin_signature_status" });
      } catch (err) {
        diagnostics.push({ source: "get_signature", reason: err?.message || "error" });
      }
    }

    return {
      status: "pending",
      normalizedStatus: "pending",
      rawStatus: "",
      signatureId: sid || null,
      source: "",
      diagnostics
    };
  }

  async function listarArchivosFirmados({ signatureId = "", requestId = "", contractId = "", allowlist = null } = {}) {
    const allow = parseSignedFileGroups(allowlist ?? config.signedFileGroups, logger);
    if (!allow.valid) {
      return { files: [], allowlistValida: false, reason: "allowlist_invalida", catalogEntries: [] };
    }

    const user = String(config.user || "").trim();
    const sid = /^\d+$/.test(String(signatureId || "").trim()) ? String(signatureId).trim() : "";
    const basePayload = {
      request: "GET_FILE_LIST",
      request_id: buildRequestId("file-list"),
      user
    };
    if (sid) basePayload.signature_id = sid;
    if (requestId) basePayload.request_id_search = requestId;
    if (contractId) basePayload.contract_id = contractId;

    let filteredEntries = [];
    let fallbackNeeded = false;
    for (const group of allow.groups) {
      try {
        const response = await postJson("get_file_list", { ...basePayload, file_group: group });
        const entries = normalizeFileEntries(response);
        const groupEntries = entries.filter((entry) => entry.fileGroup === group);
        if (entries.some((entry) => entry.fileGroup && entry.fileGroup !== group)) {
          fallbackNeeded = true;
        }
        filteredEntries.push(...groupEntries);
      } catch (err) {
        fallbackNeeded = true;
      }
    }

    if (fallbackNeeded || filteredEntries.length === 0) {
      try {
        const response = await postJson("get_file_list", basePayload);
        filteredEntries = normalizeFileEntries(response)
          .filter((entry) => allow.groups.includes(entry.fileGroup));
      } catch (err) {
        if (filteredEntries.length === 0) {
          return { files: [], allowlistValida: true, reason: "get_file_list_error", catalogEntries: [] };
        }
      }
    }

    const unique = [];
    const seen = new Set();
    for (const entry of filteredEntries) {
      if (!entry.fileId || !entry.fileGroup || !allow.groups.includes(entry.fileGroup)) continue;
      if (seen.has(entry.fileId)) continue;
      seen.add(entry.fileId);
      unique.push(entry);
    }

    const files = [];
    for (const entry of unique) {
      const bodyVariants = [
        { request: "GET_FILE", request_id: buildRequestId("file"), user, file_id: entry.fileId },
        { request: "GET_FILE", request_id: buildRequestId("file"), user, file: { file_id: entry.fileId } }
      ];
      for (const body of bodyVariants) {
        try {
          const response = await postBinary("get_file", body);
          const buffer = extractPdfBufferFromResponse(response);
          if (!isPdfBuffer(buffer)) continue;
          files.push({
            buffer,
            fileName: sanitizePdfFileName(entry.fileName, "CuentaCobroFirmada.pdf"),
            fileGroup: entry.fileGroup,
            fileId: entry.fileId,
            source: "file_group_verificado"
          });
          break;
        } catch (err) {
          // Continua con la siguiente variante.
        }
      }
    }

    return {
      files,
      allowlistValida: true,
      reason: files.length ? "" : "firmado_sin_pdf_en_grupos",
      catalogEntries: summarizeFileCatalogEntries(unique)
    };
  }

  async function listarArchivosAdjuntosFirma({
    signatureId = "",
    requestId = "",
    contractId = "",
    signedFileIds = [],
    publicId = ""
  } = {}) {
    try {
      const user = String(config.user || "").trim();
      const sid = /^\d+$/.test(String(signatureId || "").trim()) ? String(signatureId).trim() : "";
      const basePayload = {
        request: "GET_FILE_LIST",
        request_id: buildRequestId("file-list"),
        user
      };
      if (sid) basePayload.signature_id = sid;
      if (requestId) basePayload.request_id_search = requestId;
      if (contractId) basePayload.contract_id = contractId;

      const response = await postJson("get_file_list", basePayload);
      const entries = normalizeFileEntries(response);
      const catalogEntries = summarizeFileCatalogEntries(entries);
      const signedIds = new Set((Array.isArray(signedFileIds) ? signedFileIds : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean));
      const publicKey = normalizeLooseFileNameKey(publicId);
      const byKind = {
        seguridad_social_firma: [],
        evidencia_firma: [],
        anexo_firma: []
      };
      const seenCandidates = new Set();

      const resolveKind = (entry) => {
        const fileGroup = String(entry.fileGroup || "").trim().toLowerCase();
        const fileType = String(entry.fileType || "").trim().toLowerCase();
        if (["uploaded_files", "uploaded", "attached", "attached_files"].includes(fileGroup)) {
          return "seguridad_social_firma";
        }
        if (fileGroup.includes("evidence") || fileType.includes("evidence")) {
          return "evidencia_firma";
        }
        if (["contract_files", "attachment_files", "attachments", "attachment"].includes(fileGroup) ||
          ["contract_files", "attachment_files", "attachments", "attachment"].includes(fileType)) {
          return "anexo_firma";
        }
        return "";
      };

      for (const entry of entries) {
        const fileId = String(entry.fileId || "").trim();
        const fileGroup = String(entry.fileGroup || "").trim().toUpperCase();
        if (!fileId) continue;
        if (signedIds.has(fileId)) continue;
        if (SIGNED_FILE_GROUPS_KNOWN.has(fileGroup)) continue;

        const kind = resolveKind(entry);
        if (!kind) continue;

        if (kind === "seguridad_social_firma") {
          const fileNameKey = normalizeLooseFileNameKey(entry.fileName);
          if (fileNameKey.startsWith("cuentacobro")) continue;
          if (publicKey && fileNameKey.includes(publicKey) && fileNameKey.includes("cuenta")) continue;
        }

        const key = `${kind}|${fileId}`;
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        byKind[kind].push(entry);
      }

      const extraFiles = [];
      for (const kind of ["seguridad_social_firma", "evidencia_firma", "anexo_firma"]) {
        for (const entry of byKind[kind]) {
          const bodyVariants = [
            { request: "GET_FILE", request_id: buildRequestId("file"), user, file_id: entry.fileId },
            { request: "GET_FILE", request_id: buildRequestId("file"), user, file: { file_id: entry.fileId } }
          ];
          let resolved = false;
          for (const body of bodyVariants) {
            try {
              const fileResponse = await postBinary("get_file", body);
              const buffer = extractPdfBufferFromResponse(fileResponse);
              if (!isPdfBuffer(buffer)) continue;
              extraFiles.push({
                kind,
                fileName: sanitizePdfFileName(entry.fileName, `${kind}.pdf`),
                buffer
              });
              resolved = true;
              break;
            } catch (err) {
              // Continua con la siguiente variante/candidato.
            }
          }
          if (resolved) break;
        }
      }

      return { extraFiles, catalogEntries };
    } catch (err) {
      return {
        extraFiles: [],
        catalogEntries: [],
        reason: err?.message || "get_file_list_error"
      };
    }
  }

  function collectCuentaFirmaCandidates(adjuntos = {}) {
    const source = adjuntos && typeof adjuntos === "object" ? adjuntos : {};
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (firma, origen) => {
      if (!firma || typeof firma !== "object") return;
      if (firma.no_reconciliar === true || firma.cancelada_en_clicksign === true) return;
      const candidate = {
        request_id: String(firma.request_id || "").trim(),
        contract_id: String(firma.contract_id || "").trim(),
        signature_id: String(firma.signature_id || "").trim(),
        origen
      };
      if (!candidate.request_id && !candidate.contract_id && !candidate.signature_id) return;
      const key = [
        candidate.request_id.toLowerCase(),
        candidate.contract_id.toLowerCase(),
        candidate.signature_id
      ].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    };

    pushCandidate(source.firma, "firma");
    const reseteos = Array.isArray(source.firma_reseteos) ? source.firma_reseteos : [];
    reseteos.forEach((entry, index) => {
      if (entry?.no_reconciliar === true || entry?.cancelada_en_clicksign === true) return;
      pushCandidate(entry, `firma_reseteos[${index}]`);
      if (entry?.firma_original && typeof entry.firma_original === "object") {
        pushCandidate(entry.firma_original, `firma_reseteos[${index}].firma_original`);
      }
    });

    return candidates;
  }

  function buildDiagnostico(candidate, statusResult, reason, nowIso) {
    return {
      ultimo_check_en: nowIso,
      request_id: candidate?.request_id || null,
      contract_id: candidate?.contract_id || null,
      signature_id: statusResult?.signatureId || candidate?.signature_id || null,
      rawStatus: statusResult?.rawStatus || null,
      normalizedStatus: statusResult?.normalizedStatus || statusResult?.status || null,
      catalogSource: statusResult?.source || null,
      reason: reason || "pending",
      origen: candidate?.origen || null
    };
  }

  async function resolverFirmaCuentaVerificada({ cuenta, prevAdjuntos } = {}) {
    const candidates = collectCuentaFirmaCandidates(prevAdjuntos);
    const diagnostics = [];
    const nowIso = new Date().toISOString();
    if (candidates.length === 0) {
      const diagnostico = {
        ultimo_check_en: nowIso,
        request_id: null,
        contract_id: null,
        signature_id: null,
        rawStatus: null,
        normalizedStatus: null,
        catalogSource: null,
        reason: "sin_identificadores"
      };
      return { signed: false, diagnostics: [diagnostico], diagnostico, rawStatus: "", normalizedStatus: "", reason: "sin_identificadores" };
    }

    for (const candidate of candidates) {
      try {
        const statusResult = await consultarSignatureStatusOficial({
          signatureId: candidate.signature_id,
          requestId: candidate.request_id,
          contractId: candidate.contract_id
        });
        const status = statusResult.status || "pending";
        if (status !== "signed") {
          const reason = status === "rejected" ? "rechazado" : "pending";
          const diagnostico = buildDiagnostico(candidate, statusResult, reason, nowIso);
          diagnostics.push(diagnostico);
          continue;
        }

        const resolvedSignatureId = statusResult.signatureId || candidate.signature_id || "";
        const filesResult = await listarArchivosFirmados({
          signatureId: resolvedSignatureId,
          requestId: candidate.request_id,
          contractId: candidate.contract_id
        });
        if (!filesResult.allowlistValida) {
          const diagnostico = buildDiagnostico(candidate, statusResult, "allowlist_invalida", nowIso);
          diagnostics.push(diagnostico);
          return {
            signed: false,
            diagnostics,
            diagnostico,
            rawStatus: statusResult.rawStatus || "",
            normalizedStatus: "signed",
            reason: "allowlist_invalida",
            requestId: candidate.request_id || null,
            contractId: candidate.contract_id || null,
            signatureId: resolvedSignatureId || null,
            source: candidate.origen
          };
        }

        const signedPdf = filesResult.files[0] || null;
        if (signedPdf && isPdfBuffer(signedPdf.buffer)) {
          let extraFiles = [];
          let catalogEntries = filesResult.catalogEntries || [];
          try {
            const extrasResult = await listarArchivosAdjuntosFirma({
              signatureId: resolvedSignatureId,
              requestId: candidate.request_id,
              contractId: candidate.contract_id,
              signedFileIds: [signedPdf.fileId].filter(Boolean),
              publicId: String(cuenta?.public_id || "")
            });
            extraFiles = extrasResult.extraFiles || [];
            catalogEntries = (extrasResult.catalogEntries || []).length
              ? extrasResult.catalogEntries
              : catalogEntries;
          } catch (extraErr) {
            logger?.warn?.(`[firma-cuenta] No se pudieron resolver adjuntos Click&Sign para ${cuenta?.public_id || "sin_public_id"}:`, extraErr?.message || extraErr);
          }
          return {
            signed: true,
            signedPdf,
            extraFiles,
            requestId: candidate.request_id || null,
            contractId: candidate.contract_id || null,
            signatureId: resolvedSignatureId || null,
            source: candidate.origen,
            rawStatus: statusResult.rawStatus || "signed",
            normalizedStatus: "signed",
            catalogSource: "get_file_list",
            catalogEntries,
            diagnostics
          };
        }

        const diagnostico = buildDiagnostico(candidate, statusResult, "firmado_sin_pdf_en_grupos", nowIso);
        diagnostics.push({
          ...diagnostico,
          catalogSource: "get_file_list"
        });
      } catch (err) {
        diagnostics.push({
          ultimo_check_en: nowIso,
          request_id: candidate.request_id || null,
          contract_id: candidate.contract_id || null,
          signature_id: candidate.signature_id || null,
          rawStatus: err?.message || "error",
          normalizedStatus: null,
          catalogSource: null,
          reason: "error",
          origen: candidate.origen
        });
      }
    }

    const diagnostico = diagnostics.find((item) => item?.origen === "firma") || diagnostics[0] || null;
    return {
      signed: false,
      diagnostics,
      diagnostico,
      rawStatus: diagnostico?.rawStatus || "",
      normalizedStatus: diagnostico?.normalizedStatus || "",
      catalogSource: diagnostico?.catalogSource || "",
      reason: diagnostico?.reason || "pending",
      requestId: diagnostico?.request_id || null,
      contractId: diagnostico?.contract_id || null,
      signatureId: diagnostico?.signature_id || null
    };
  }

  async function cancelarFirmaClickSign({ signatureId = "", requestId = "", contractId = "" } = {}) {
    const user = String(config.user || "").trim();
    const sid = /^\d+$/.test(String(signatureId || "").trim()) ? String(signatureId).trim() : "";
    const bodies = [];
    if (sid) {
      bodies.push({ request: "CANCEL_SIGNATURE", request_id: buildRequestId("cancel-signature"), user, signature_id: sid });
      bodies.push({ request: "CANCEL_SIGNATURE", request_id: buildRequestId("cancel-signature"), user, signature: { signature_id: sid } });
    }
    if (contractId) {
      bodies.push({ request: "CANCEL_SIGNATURE", request_id: buildRequestId("cancel-signature"), user, contract_id: contractId });
      bodies.push({ request: "CANCEL_SIGNATURE", request_id: buildRequestId("cancel-signature"), user, signature: { contract_id: contractId } });
    }
    if (requestId) {
      bodies.push({ request: "CANCEL_SIGNATURE", request_id: buildRequestId("cancel-signature"), user, request_id_search: requestId });
      bodies.push({ request: "CANCEL_SIGNATURE", request_id: buildRequestId("cancel-signature"), user, signature: { request_id: requestId } });
    }
    if (bodies.length === 0) {
      return { ok: false, cancelada: false, reason: "sin_identificadores", resumen: { rawStatus: null, message: "sin_identificadores" } };
    }

    let lastError = null;
    for (const body of bodies) {
      try {
        const response = await postJson("cancel_signature", body);
        const resumen = summarizeCancelResponse(response);
        if (isCancelSuccessBody(response)) {
          return { ok: true, cancelada: true, reason: "cancelada", resumen, response };
        }
        lastError = new Error(resumen.message || "respuesta_cancelacion_desconocida");
        lastError.response = response;
      } catch (err) {
        const statusCode = Number(err?.status || err?.response?.status || 0);
        const body = err?.response || {};
        const resumen = summarizeCancelResponse(body, err?.message || "error");
        if (statusCode > 0 && statusCode < 500 && isCancelSuccessBody(body)) {
          return { ok: true, cancelada: true, reason: "estado_final", resumen, response: body };
        }
        lastError = err;
      }
    }

    return {
      ok: false,
      cancelada: false,
      reason: "cancelacion_fallida",
      resumen: summarizeCancelResponse(lastError?.response || {}, lastError?.message || "error"),
      error: lastError
    };
  }

  return {
    consultarSignatureStatusOficial,
    listarArchivosFirmados,
    listarArchivosAdjuntosFirma,
    resolverFirmaCuentaVerificada,
    cancelarFirmaClickSign,
    normalizeOfficialSignatureStatus,
    parseSignedFileGroups,
    isPdfBuffer,
    collectCuentaFirmaCandidates
  };
}

const defaultService = createClickSignFirmaVerificadaService();

module.exports = {
  SIGNED_FILE_GROUPS_KNOWN,
  createClickSignFirmaVerificadaService,
  consultarSignatureStatusOficial: defaultService.consultarSignatureStatusOficial,
  listarArchivosFirmados: defaultService.listarArchivosFirmados,
  listarArchivosAdjuntosFirma: defaultService.listarArchivosAdjuntosFirma,
  resolverFirmaCuentaVerificada: defaultService.resolverFirmaCuentaVerificada,
  cancelarFirmaClickSign: defaultService.cancelarFirmaClickSign,
  normalizeOfficialSignatureStatus,
  parseSignedFileGroups: defaultService.parseSignedFileGroups,
  isPdfBuffer,
  collectCuentaFirmaCandidates: defaultService.collectCuentaFirmaCandidates
};
