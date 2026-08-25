const { pool } = require("../db");
const { getGraphAccessToken } = require("../email");
const https = require("https");

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

let subscribedSkuCache = {
  expiresAt: 0,
  entries: []
};

async function getSubscribedSkuMap(accessToken) {
  const now = Date.now();
  if (subscribedSkuCache.entries.length && now < subscribedSkuCache.expiresAt) {
    return new Map(subscribedSkuCache.entries);
  }

  const data = await graphGet(
    "/v1.0/subscribedSkus?$select=skuId,skuPartNumber",
    accessToken
  );
  const entries = (data?.value || [])
    .map((item) => [
      String(item?.skuId || "").trim().toLowerCase(),
      String(item?.skuPartNumber || "").trim() || null
    ])
    .filter(([skuId]) => skuId);

  subscribedSkuCache = {
    expiresAt: now + (5 * 60 * 1000),
    entries
  };
  return new Map(entries);
}

function buildUserAssignedLicenses(userData, skuPartNumberById = new Map()) {
  const statesBySku = new Map();
  for (const item of userData?.licenseAssignmentStates || []) {
    const skuId = String(item?.skuId || "").trim().toLowerCase();
    if (!skuId) continue;
    if (!statesBySku.has(skuId)) statesBySku.set(skuId, []);
    statesBySku.get(skuId).push(item);
  }

  const assignedSkuIds = normalizeSkuIdList(
    (userData?.assignedLicenses || []).map((item) => item?.skuId)
  );

  return assignedSkuIds.map((skuIdOriginal) => {
    const skuId = String(skuIdOriginal).toLowerCase();
    const states = statesBySku.get(skuId) || [];
    const directStates = states.filter((item) => !item?.assignedByGroup);
    const groupIds = [...new Set(
      states.map((item) => String(item?.assignedByGroup || "").trim()).filter(Boolean)
    )];
    const stateValues = [...new Set(
      states.map((item) => String(item?.state || "").trim()).filter(Boolean)
    )];

    let assignmentType = "directa";
    if (directStates.length && groupIds.length) assignmentType = "mixta";
    else if (!directStates.length && groupIds.length) assignmentType = "grupo";

    return {
      skuId: skuIdOriginal,
      skuPartNumber: skuPartNumberById.get(skuId) || null,
      assignmentType,
      removable: directStates.length > 0 || states.length === 0,
      groupIds,
      states: stateValues.length ? stateValues : ["Active"]
    };
  });
}

async function getUserAssignedLicenses(accessToken, userId) {
  const encodedUser = encodeURIComponent(userId);
  const [userData, skuPartNumberById] = await Promise.all([
    graphGet(
      `/v1.0/users/${encodedUser}?$select=id,assignedLicenses,licenseAssignmentStates`,
      accessToken
    ),
    getSubscribedSkuMap(accessToken)
  ]);
  return buildUserAssignedLicenses(userData, skuPartNumberById);
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

// Roles por usuario (admin)
/**
 * Obtiene la lista de usuarios activos junto con el rol de sistema asignado
 */
async function listUsuariosRoles(req, res) {
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
}

// ====Gestión de licencias / acceso ============================================================?
/**
 * Lista los usuarios registrados para gestionar su estado de cuenta y accesos
 */
async function listUsuariosLicencias(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        u.public_id      AS id,
        u.nombre_usuario,
        u.email,
        u.activo,
        u.azure_oid,
        u.tipo_consultor,
        u.ultimo_inicio_sesion,
        r.titulo         AS rol
      FROM usuarios u
        LEFT JOIN roles r ON u.rol_usuario_id = r.id
      ORDER BY u.nombre_usuario ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
}

/**
 * Consulta bajo demanda las licencias actuales del usuario en Microsoft Graph.
 */
async function getUsuarioLicenciasActuales(req, res) {
  const { id } = req.params;

  try {
    const userRes = await pool.query(
      `SELECT public_id, nombre_usuario, email, azure_oid
       FROM usuarios
       WHERE public_id = $1`,
      [id]
    );
    if (userRes.rowCount === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const user = userRes.rows[0];
    const graphUserCandidates = buildGraphUserCandidates(user.azure_oid, user.email);
    if (!graphUserCandidates.length) {
      return res.status(400).json({ error: "El usuario no tiene email ni OID de Azure asociado" });
    }

    const token = await getGraphAccessToken();
    const graphResult = await executeGraphUserActionWithFallback(
      graphUserCandidates,
      async (candidateUserId) => getUserAssignedLicenses(token, candidateUserId)
    );
    const licencias = (graphResult.result || [])
      .map((item) => ({
        sku_id: item.skuId,
        nombre: item.skuPartNumber || item.skuId,
        asignacion: item.assignmentType,
        removible: item.removable,
        grupos: item.groupIds,
        estados: item.states
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));

    return res.json({
      usuario: {
        id: user.public_id,
        nombre: user.nombre_usuario,
        email: user.email
      },
      entra_user_id: graphResult.resolvedUserId,
      total: licencias.length,
      total_removibles: licencias.filter((item) => item.removible).length,
      licencias
    });
  } catch (err) {
    console.error("Error consultando licencias actuales en Entra ID:", err?.message || err);
    const details = buildGraphErrorDetails(err, "No se pudieron consultar las licencias");
    const status = details.status === 404 ? 404 : 502;
    return res.status(status).json({
      error: details.status === 404
        ? "El usuario no fue encontrado en Entra ID"
        : "No se pudieron consultar las licencias en Microsoft Graph",
      graph: details,
      hint:
        details.status === 401 || details.status === 403
          ? "Verifica User.Read.All y LicenseAssignment.Read.All como permisos de aplicación, con consentimiento de administrador."
          : null
    });
  }
}

/**
 * Activa o desactiva la cuenta de un usuario y sincroniza con Entra ID
 */
async function patchUsuarioLicenciaEstado(req, res) {
  const { public_id } = req.params;
  const { activo } = req.body;

  if (typeof activo !== "boolean") {
    return res.status(400).json({ error: "El campo activo debe ser booleano" });
  }

  try {
    const userRes = await pool.query(
      `SELECT id, azure_oid, email, nombre_usuario FROM usuarios WHERE public_id = $1`,
      [public_id]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const user = userRes.rows[0];

    await pool.query(
      `UPDATE usuarios SET activo = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [activo, user.id]
    );

    let entraId = user.azure_oid;

    // Si no tiene azure_oid guardado, intentar encontrarlo por email en Entra
    if (!entraId && user.email) {
      try {
        const token = await getGraphAccessToken();
        const busqueda = await graphGet(
          `/v1.0/users?$filter=mail eq '${user.email}'&$select=id`,
          token
        );
        const entraUser = busqueda?.value?.[0];
        if (entraUser?.id) {
          entraId = entraUser.id;
          // Guardar para futuras operaciones
          await pool.query(
            `UPDATE usuarios SET azure_oid = $1 WHERE id = $2`,
            [entraId, user.id]
          );
        }
      } catch (lookupErr) {
        console.error("No se pudo buscar usuario en Entra por email:", lookupErr.message);
      }
    }

    if (entraId) {
      try {
        const token = await getGraphAccessToken();
        await graphPatch(`/v1.0/users/${entraId}`, token, { accountEnabled: activo });
      } catch (graphErr) {
        console.error("Error actualizando estado en Entra ID:", graphErr.message);
        return res.status(207).json({
          warning: "El usuario se actualizó en la BD pero no se pudo sincronizar con Entra ID. Intenta de nuevo.",
          activo
        });
      }
    }

    res.json({
      mensaje: `Usuario ${activo ? "activado" : "desactivado"} correctamente`,
      entra_sincronizado: !!entraId,
      activo
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar estado del usuario" });
  }
}

/**
 * Modifica el rol de sistema que tiene asignado un usuario en la plataforma
 */
async function actualizarRolUsuario(req, res) {
  const { id } = req.params;
  const { rol_id } = req.body || {};
  try {
    if (!rol_id) return res.status(400).json({ error: "Falta rol_id" });

    // CTE para resolver usuario y rol en 1 query
    const result = await pool.query(
      `
      WITH 
        c_usuario AS (SELECT id, nombre_usuario, email FROM usuarios WHERE public_id = $2),
        c_rol AS (SELECT id FROM roles WHERE public_id = $1)
      UPDATE usuarios
      SET rol_usuario_id = (SELECT id FROM c_rol),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM c_usuario)
        AND EXISTS (SELECT 1 FROM c_rol)
      RETURNING public_id AS id, nombre_usuario, email
      `,
      [rol_id, id]
    );

    if (result.rowCount === 0) {
      // Verificar manual (sin error crash) si fue porque no existe el rol o el usuario
      const checkRol = await pool.query("SELECT id FROM roles WHERE public_id = $1", [rol_id]);
      if (checkRol.rowCount === 0) return res.status(404).json({ error: "Rol no encontrado" });

      const checkUser = await pool.query("SELECT id FROM usuarios WHERE public_id = $1", [id]);
      if (checkUser.rowCount === 0) return res.status(404).json({ error: "Usuario no encontrado" });

      return res.status(500).json({ error: "Error desconocido al asignar rol" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar rol de usuario" });
  }
}

// Activar / desactivar usuario en BD y en Entra ID (accountEnabled)
// Requiere permisos de aplicación en Graph:
// - User.EnableDisableAccount.All + User.Read.All (para accountEnabled)
// - User.Read.All + LicenseAssignment.Read.All (para consultar licencias)
// - LicenseAssignment.ReadWrite.All (si se solicita liberar licencias)
/**
 * Modifica el estado de acceso de un usuario y gestiona sus licencias de Office
 */
async function actualizarUsuarioActivo(req, res) {
  const { id } = req.params;
  const {
    activo,
    liberar_licencias = false,
    remove_licenses = null,
    restaurar_licencias = false
  } = req.body || {};

  if (typeof activo !== "boolean") {
    return res.status(400).json({ error: "El campo 'activo' debe ser true o false" });
  }
  if (typeof liberar_licencias !== "boolean") {
    return res.status(400).json({ error: "El campo 'liberar_licencias' debe ser true o false" });
  }
  if (typeof restaurar_licencias !== "boolean") {
    return res.status(400).json({ error: "El campo 'restaurar_licencias' debe ser true o false" });
  }
  if (remove_licenses !== null && !Array.isArray(remove_licenses)) {
    return res.status(400).json({ error: "El campo 'remove_licenses' debe ser un array o null" });
  }
  if (activo && (liberar_licencias || normalizeSkuIdList(remove_licenses || []).length > 0)) {
    return res.status(400).json({
      error: "La liberación de licencias solo aplica cuando activo=false."
    });
  }
  if (!activo && restaurar_licencias) {
    return res.status(400).json({
      error: "La restauración de licencias solo aplica cuando activo=true."
    });
  }

  try {
    const userRes = await pool.query(
      "SELECT id, public_id, email, azure_oid FROM usuarios WHERE public_id = $1",
      [id]
    );
    if (userRes.rowCount === 0) return res.status(404).json({ error: "Usuario no encontrado" });

    const { id: userInternalId, public_id: userPublicId, email, azure_oid } = userRes.rows[0];
    const graphUserCandidates = buildGraphUserCandidates(azure_oid, email);
    const requestedSkusToRemove = normalizeSkuIdList(remove_licenses || []);
    const actorUserId = req.user?.id || null;
    const actorEmail = req.user?.email || null;

    // 1. Actualizar en BD
    await pool.query(
      "UPDATE usuarios SET activo = $1, updated_at = CURRENT_TIMESTAMP WHERE public_id = $2",
      [activo, id]
    );

    // 2. Sincronizar accountEnabled en Entra ID si el usuario tiene OID o email de Azure
    let entraSync = {
      ok: false,
      user_id: null,
      error: null
    };
    let licenciaSync = null;

    if (graphUserCandidates.length) {
      const shouldReleaseLicenses = !activo && (liberar_licencias || requestedSkusToRemove.length > 0);
      const shouldRestoreLicenses = activo && restaurar_licencias;
      try {
        const token = await getGraphAccessToken();
        const patchResult = await executeGraphUserActionWithFallback(
          graphUserCandidates,
          async (candidateUserId) => {
            const encodedUser = encodeURIComponent(candidateUserId);
            await graphPatch(`/v1.0/users/${encodedUser}`, token, { accountEnabled: activo });
            return true;
          }
        );
        entraSync = {
          ok: true,
          user_id: patchResult.resolvedUserId,
          error: null
        };

        if (shouldReleaseLicenses) {
          try {
            const detailsResult = await executeGraphUserActionWithFallback(
              graphUserCandidates,
              async (candidateUserId) => getUserAssignedLicenses(token, candidateUserId)
            );
            const assignedLicenses = Array.isArray(detailsResult.result) ? detailsResult.result : [];
            const assignedBySku = new Map(
              assignedLicenses
                .filter((item) => item?.removable)
                .map((item) => ({
                  skuId: String(item?.skuId || "").trim(),
                  skuPartNumber: String(item?.skuPartNumber || "").trim() || null
                }))
                .filter((item) => item.skuId)
                .map((item) => [item.skuId, item])
            );
            const assignedSkuIds = [...assignedBySku.keys()];

            const source = requestedSkusToRemove.length ? "manual" : "auto";
            const skusToRemove = requestedSkusToRemove.length
              ? requestedSkusToRemove.filter((skuId) => assignedBySku.has(skuId))
              : assignedSkuIds;
            const skippedSkus = requestedSkusToRemove.length
              ? requestedSkusToRemove.filter((skuId) => !assignedBySku.has(skuId))
              : [];

            const licensesToBackup = skusToRemove.map((skuId) => ({
              skuId,
              skuPartNumber: assignedBySku.get(skuId)?.skuPartNumber || null
            }));
            const backupGroupId = await saveUserLicenseBackupSnapshot({
              userInternalId,
              userPublicId,
              azureOid: azure_oid,
              email,
              licenses: licensesToBackup,
              deactivatedByUserId: actorUserId,
              deactivatedByEmail: actorEmail
            });

            if (skusToRemove.length > 0) {
              const assignResult = await executeGraphUserActionWithFallback(
                graphUserCandidates,
                async (candidateUserId) =>
                  assignUserLicense(token, candidateUserId, [], skusToRemove)
              );
              licenciaSync = {
                ok: true,
                mode: "release",
                user_id: assignResult.resolvedUserId,
                backup_group_id: backupGroupId,
                remove_licenses: skusToRemove,
                skipped_remove_licenses: skippedSkus,
                source
              };
            } else {
              licenciaSync = {
                ok: true,
                mode: "release",
                user_id: entraSync.user_id,
                backup_group_id: backupGroupId,
                remove_licenses: [],
                skipped_remove_licenses: skippedSkus,
                source,
                note: "No había licencias directas aplicables para remover"
              };
            }
          } catch (licenseErr) {
            console.error("Error liberando licencias en Entra ID:", licenseErr?.message || licenseErr);
            const status = parseGraphErrorStatus(licenseErr?.message || "");
            licenciaSync = {
              ok: false,
              mode: "release",
              user_id: entraSync.user_id,
              remove_licenses: requestedSkusToRemove,
              ...buildGraphErrorDetails(licenseErr, "No se pudieron liberar las licencias"),
              hint:
                status === 401 || status === 403
                  ? "Verifica permisos de aplicación: LicenseAssignment.ReadWrite.All (o User.ReadWrite.All) y consentimiento de administrador."
                  : null
            };
          }
        } else if (shouldRestoreLicenses) {
          try {
            const pendingSnapshot = await getPendingLicenseBackupSnapshot(userInternalId);
            const skusToAdd = normalizeSkuIdList(
              (pendingSnapshot.licenses || []).map((row) => row?.sku_id)
            );
            if (pendingSnapshot.backupGroupId && skusToAdd.length > 0) {
              const assignResult = await executeGraphUserActionWithFallback(
                graphUserCandidates,
                async (candidateUserId) =>
                  assignUserLicense(token, candidateUserId, skusToAdd, [])
              );
              const restoredRows = await markLicenseBackupSnapshotRestored({
                userInternalId,
                backupGroupId: pendingSnapshot.backupGroupId,
                restoredByUserId: actorUserId,
                restoredByEmail: actorEmail
              });
              licenciaSync = {
                ok: true,
                mode: "restore",
                user_id: assignResult.resolvedUserId,
                backup_group_id: pendingSnapshot.backupGroupId,
                add_licenses: skusToAdd,
                restored_rows: restoredRows
              };
            } else {
              licenciaSync = {
                ok: true,
                mode: "restore",
                user_id: entraSync.user_id,
                backup_group_id: pendingSnapshot.backupGroupId,
                add_licenses: [],
                restored_rows: 0,
                note: "No hay snapshot pendiente de licencias para restaurar"
              };
            }
          } catch (restoreErr) {
            console.error("Error restaurando licencias en Entra ID:", restoreErr?.message || restoreErr);
            const status = parseGraphErrorStatus(restoreErr?.message || "");
            licenciaSync = {
              ok: false,
              mode: "restore",
              user_id: entraSync.user_id,
              ...buildGraphErrorDetails(restoreErr, "No se pudieron restaurar las licencias"),
              hint:
                status === 401 || status === 403
                  ? "Verifica permisos de aplicación: LicenseAssignment.ReadWrite.All (o User.ReadWrite.All) y consentimiento de administrador."
                  : null
            };
          }
        }
      } catch (syncErr) {
        console.error("Error sincronizando accountEnabled en Entra ID:", syncErr?.message || syncErr);
        const status = parseGraphErrorStatus(syncErr?.message || "");
        entraSync = {
          ok: false,
          user_id: null,
          ...buildGraphErrorDetails(syncErr, "No se pudo sincronizar accountEnabled"),
          hint:
            status === 401 || status === 403
              ? "Verifica permisos de aplicación: User.EnableDisableAccount.All + User.Read.All y consentimiento de administrador."
              : null
        };
      }
    }

    // Respuesta: siempre informa el estado de cada operación
    return res.json({
      ok: true,
      activo,
      email,
      entra_sync: graphUserCandidates.length
        ? entraSync
        : { ok: false, error: "El usuario no tiene azure_oid ni email asociado a Entra ID" },
      licencia_sync: licenciaSync
    });
  } catch (err) {
    console.error("Error actualizando estado de usuario:", err?.message || err);
    res.status(500).json({ error: "Error al actualizar el estado del usuario" });
  }
}

// Equivalente a: Set-MgUserLicense -UserId "..." -RemoveLicenses @("sku-id") -AddLicenses @()
/**
 * Agrega o remueve licencias de Entra ID directamente para un usuario
 */
async function asignarLicenciaUsuario(req, res) {
  const { id } = req.params;
  const { add_licenses = [], remove_licenses = [] } = req.body || {};
  try {
    if (!add_licenses.length && !remove_licenses.length) {
      return res.status(400).json({ error: "Debes especificar add_licenses o remove_licenses (array de SkuIds)" });
    }

    const userRes = await pool.query(
      "SELECT email, azure_oid FROM usuarios WHERE public_id = $1",
      [id]
    );
    if (userRes.rowCount === 0) return res.status(404).json({ error: "Usuario no encontrado" });

    const { email, azure_oid } = userRes.rows[0];
    const graphUserCandidates = buildGraphUserCandidates(azure_oid, email);
    if (!graphUserCandidates.length) {
      return res.status(400).json({ error: "El usuario no tiene email ni OID de Azure asociado" });
    }

    const token = await getGraphAccessToken();
    const assignResult = await executeGraphUserActionWithFallback(
      graphUserCandidates,
      async (candidateUserId) =>
        assignUserLicense(token, candidateUserId, add_licenses, remove_licenses)
    );

    res.json({
      ok: true,
      usuario: email,
      user_id: assignResult.resolvedUserId,
      add_licenses,
      remove_licenses
    });
  } catch (err) {
    console.error("Error gestionando licencia en Entra ID:", err?.message || err);
    const status = parseGraphErrorStatus(err?.message || "");
    if (status === 401 || status === 403) {
      return res.status(502).json({
        error: "Sin permisos para modificar licencias en Entra ID. Verifica que la app tenga LicenseAssignment.ReadWrite.All (o User.ReadWrite.All) como permiso de aplicación."
      });
    }
    if (status === 404) {
      return res.status(404).json({
        error: "Usuario no encontrado en Entra ID. Verifica que el email o OID sea correcto."
      });
    }
    res.status(502).json({ error: "No se pudo modificar la licencia en Entra ID." });
  }
}

// Historial de snapshots de licencias para un usuario
/**
 * Retorna el historial de cambios y respaldos de licencias aplicados a un usuario
 */
async function getLicenciasHistorial(req, res) {
  const { id } = req.params;
  try {
    const userRes = await pool.query(
      "SELECT id FROM usuarios WHERE public_id = $1",
      [id]
    );
    if (userRes.rowCount === 0) return res.status(404).json({ error: "Usuario no encontrado" });
    const userInternalId = userRes.rows[0].id;

    const result = await pool.query(
      `
      SELECT
        backup_group_id,
        sku_id,
        sku_part_number,
        fecha_desactivacion,
        desactivado_por_email,
        restaurado,
        fecha_restauracion,
        restaurado_por_email
      FROM usuario_licencias_backup
      WHERE usuario_id = $1
      ORDER BY fecha_desactivacion DESC, sku_id ASC
      `,
      [userInternalId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error obteniendo historial de licencias:", err?.message || err);
    res.status(500).json({ error: "No se pudo obtener el historial de licencias" });
  }
}

module.exports = {
  listUsuariosRoles,
  listUsuariosLicencias,
  getUsuarioLicenciasActuales,
  patchUsuarioLicenciaEstado,
  actualizarRolUsuario,
  actualizarUsuarioActivo,
  asignarLicenciaUsuario,
  getLicenciasHistorial,
  buildUserAssignedLicenses
};
