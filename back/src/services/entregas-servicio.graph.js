const https = require("https");
const { getGraphAccessToken } = require("../email");

const ONEDRIVE_TARGET_USER = String(process.env.ONEDRIVE_TARGET_USER || "").trim();
const ONEDRIVE_ENTREGAS_ROOT_FOLDER = String(
  process.env.ONEDRIVE_ENTREGAS_ROOT_FOLDER || "EntregaDeServicios"
).trim();

function sanitizePathSegment(value, fallback = "elemento") {
  const sanitized = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#%]/g, "-")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return sanitized || fallback;
}

function encodeGraphPath(pathValue) {
  return String(pathValue || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function graphRequest({ method = "GET", path, accessToken, jsonBody = null, binaryBody = null, contentType = null }) {
  const body = binaryBody || (jsonBody == null ? null : Buffer.from(JSON.stringify(jsonBody), "utf8"));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "graph.microsoft.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(body ? {
          "Content-Type": contentType || (binaryBody ? "application/octet-stream" : "application/json"),
          "Content-Length": body.length
        } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (_) {
          parsed = { raw };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const error = new Error(
          parsed?.error?.message || `Microsoft Graph respondió ${res.statusCode}.`
        );
        error.statusCode = res.statusCode;
        error.graphCode = parsed?.error?.code || null;
        error.graphPayload = parsed;
        reject(error);
      });
    });
    req.setTimeout(45_000, () => req.destroy(new Error("Microsoft Graph agotó el tiempo de espera.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getDriveRoot(accessToken, userEmail) {
  return graphRequest({
    path: `/v1.0/users/${encodeURIComponent(userEmail)}/drive/root?$select=id,name,webUrl,parentReference`,
    accessToken
  });
}

async function getDriveItemByPath(accessToken, userEmail, pathValue) {
  try {
    return await graphRequest({
      path: `/v1.0/users/${encodeURIComponent(userEmail)}/drive/root:/${encodeGraphPath(pathValue)}?$select=id,name,webUrl,parentReference,folder`,
      accessToken
    });
  } catch (error) {
    if (error.statusCode === 404 || error.graphCode === "itemNotFound") return null;
    throw error;
  }
}

async function ensureFolderPath(accessToken, userEmail, segments) {
  let parent = await getDriveRoot(accessToken, userEmail);
  let currentPath = "";

  for (const rawSegment of segments) {
    const segment = sanitizePathSegment(rawSegment, "carpeta");
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    let item = await getDriveItemByPath(accessToken, userEmail, currentPath);
    if (!item) {
      try {
        item = await graphRequest({
          method: "POST",
          path: `/v1.0/users/${encodeURIComponent(userEmail)}/drive/items/${encodeURIComponent(parent.id)}/children`,
          accessToken,
          jsonBody: {
            name: segment,
            folder: {},
            "@microsoft.graph.conflictBehavior": "fail"
          }
        });
      } catch (error) {
        if (![409, 412].includes(error.statusCode)) throw error;
        item = await getDriveItemByPath(accessToken, userEmail, currentPath);
        if (!item) throw error;
      }
    }
    parent = item;
  }
  return parent;
}

function serviceTypeFolder(tipoServicio) {
  return {
    PROYECTO: "Proyectos",
    MESA_SERVICIO: "MesasDeServicio",
    OUTSOURCING: "Outsourcing"
  }[tipoServicio] || "Otros";
}

async function uploadEntregaPdf({ cliente, tipoServicio, nombreServicio, entregaPublicId, file }) {
  if (!ONEDRIVE_TARGET_USER) {
    const error = new Error("Falta configurar ONEDRIVE_TARGET_USER.");
    error.code = "ONEDRIVE_NOT_CONFIGURED";
    throw error;
  }
  if (!ONEDRIVE_ENTREGAS_ROOT_FOLDER) {
    const error = new Error("Falta configurar ONEDRIVE_ENTREGAS_ROOT_FOLDER.");
    error.code = "ONEDRIVE_NOT_CONFIGURED";
    throw error;
  }

  const accessToken = await getGraphAccessToken();
  const shortId = String(entregaPublicId || "").split("-")[0] || "entrega";
  const folder = await ensureFolderPath(accessToken, ONEDRIVE_TARGET_USER, [
    ...ONEDRIVE_ENTREGAS_ROOT_FOLDER.split("/").filter(Boolean),
    sanitizePathSegment(cliente, "Cliente"),
    serviceTypeFolder(tipoServicio),
    `${sanitizePathSegment(nombreServicio, "Servicio")}-${shortId}`
  ]);

  const safeName = sanitizePathSegment(file.nombre, "propuesta.pdf");
  const finalName = /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`;
  const uploaded = await graphRequest({
    method: "PUT",
    path: `/v1.0/users/${encodeURIComponent(ONEDRIVE_TARGET_USER)}/drive/items/${encodeURIComponent(folder.id)}:/${encodeURIComponent(finalName)}:/content`,
    accessToken,
    binaryBody: file.buffer,
    contentType: "application/pdf"
  });

  return {
    nombre_archivo: uploaded.name || finalName,
    web_url: uploaded.webUrl,
    graph_drive_id: uploaded.parentReference?.driveId || folder.parentReference?.driveId || null,
    graph_item_id: uploaded.id || null,
    folder_web_url: folder.webUrl || null
  };
}

module.exports = {
  encodeGraphPath,
  ensureFolderPath,
  sanitizePathSegment,
  uploadEntregaPdf
};
