const https = require("https");
const { pool } = require("../db");
const { getGraphAccessToken } = require("../email");
const {
  MicrosoftIdentitySyncError,
  normalizeCorporateEmail,
  syncMicrosoftIdentity
} = require("./microsoft-identity-sync.service");

const SILVER_EMAIL_DOMAIN = "@silverconsulting.com.co";
const PENDING_SILVER_STATE = "Pendiente Correo Silver";
const ACTIVE_ONBOARDING_STATES = [
  "Pendiente",
  "Pendiente Coordinador",
  "Pendiente Comercial",
  "En Proceso",
  "Pendiente Confirmación Cliente",
  "Pendiente Revision TH",
  PENDING_SILVER_STATE
];

class MicrosoftGroupWebhookError extends Error {
  constructor(message, statusCode = 409, code = "MICROSOFT_GROUP_SYNC_ERROR") {
    super(message);
    this.name = "MicrosoftGroupWebhookError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeFirstValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).find(Boolean) || null;
  }
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      return normalizeFirstValue(JSON.parse(value));
    } catch (_) {}
  }
  return normalizeText(value);
}

function normalizeMatchValue(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildNameFingerprint(value) {
  return normalizeMatchValue(value)
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");
}

function normalizeDocumentNumber(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizeWebhookIdentity(input = {}) {
  const oid = normalizeText(input.id_azure || input.azure_oid || input.oid);
  const email = normalizeCorporateEmail(input.correo || input.email || input.mail);
  const displayName = normalizeText(input.nombre || input.displayName || input.nombre_usuario);
  const personalEmail = normalizeCorporateEmail(normalizeFirstValue(
    input.correo_personal || input.personal_email || input.otherMails
  ));
  const documentNumber = normalizeFirstValue(
    input.numero_documento || input.documento || input.businessPhones
  );
  const phone = normalizeFirstValue(input.telefono_movil || input.mobilePhone || input.telefono);
  const solicitudId = normalizeText(input.solicitud_id || input.solicitud);

  if (!oid || oid.length > 64) {
    throw new MicrosoftGroupWebhookError("id_azure es obligatorio o no es válido.", 400, "INVALID_AZURE_ID");
  }
  if (!email || !email.endsWith(SILVER_EMAIL_DOMAIN)) {
    throw new MicrosoftGroupWebhookError(
      `correo debe pertenecer al dominio ${SILVER_EMAIL_DOMAIN}`,
      400,
      "INVALID_CORPORATE_EMAIL"
    );
  }
  if (!displayName) {
    throw new MicrosoftGroupWebhookError("nombre es obligatorio.", 400, "INVALID_DISPLAY_NAME");
  }

  return {
    oid,
    email,
    displayName,
    personalEmail: personalEmail || null,
    documentNumber,
    phone,
    solicitudId
  };
}

function graphJsonRequest({ method = "GET", path, token, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = https.request({
      hostname: "graph.microsoft.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(payload
          ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          }
          : {})
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = {};
        try {
          parsed = JSON.parse(data || "{}");
        } catch (_) {}
        if (Number(res.statusCode || 0) >= 200 && Number(res.statusCode || 0) < 300) {
          return resolve(parsed);
        }
        return reject(new Error(`Graph error ${res.statusCode}: ${data.slice(0, 1000)}`));
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getAllowedGroupIds() {
  return String(process.env.AZURE_ALLOWED_GROUPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value));
}

async function resolveAllowedMicrosoftIdentity(input = {}, dependencies = {}) {
  const oid = normalizeText(input.id_azure || input.azure_oid || input.oid);
  if (!oid || oid.length > 64) {
    throw new MicrosoftGroupWebhookError("id_azure es obligatorio o no es válido.", 400, "INVALID_AZURE_ID");
  }
  const allowedGroupIds = dependencies.allowedGroupIds || getAllowedGroupIds();
  if (!allowedGroupIds.length) {
    throw new MicrosoftGroupWebhookError(
      "AZURE_ALLOWED_GROUPS debe contener al menos un ID de grupo.",
      503,
      "ALLOWED_GROUPS_NOT_CONFIGURED"
    );
  }

  try {
    const getToken = dependencies.getGraphAccessToken || getGraphAccessToken;
    const graphRequest = dependencies.graphJsonRequest || graphJsonRequest;
    const token = await getToken();
    const profilePath = `/v1.0/users/${encodeURIComponent(oid)}?$select=id,displayName,givenName,surname,mail,userPrincipalName,mobilePhone,businessPhones,otherMails`;
    const [profile, membershipChecks] = await Promise.all([
      graphRequest({ method: "GET", path: profilePath, token }),
      Promise.all(
        Array.from({ length: Math.ceil(allowedGroupIds.length / 20) }, (_, index) => (
          graphRequest({
            method: "POST",
            path: `/v1.0/users/${encodeURIComponent(oid)}/checkMemberGroups`,
            token,
            body: { groupIds: allowedGroupIds.slice(index * 20, (index + 1) * 20) }
          })
        ))
      )
    ]);
    const matchedGroups = membershipChecks.flatMap((result) => (
      Array.isArray(result?.value) ? result.value : []
    ));
    if (!matchedGroups.length) {
      throw new MicrosoftGroupWebhookError(
        "La persona no pertenece a un grupo permitido en AZURE_ALLOWED_GROUPS.",
        403,
        "GROUP_MEMBERSHIP_REQUIRED"
      );
    }

    return normalizeWebhookIdentity({
      ...input,
      id_azure: profile.id || oid,
      nombre: profile.displayName,
      correo: profile.mail || profile.userPrincipalName,
      telefono_movil: profile.mobilePhone,
      documento: profile.businessPhones,
      correo_personal: profile.otherMails
    });
  } catch (error) {
    if (error instanceof MicrosoftGroupWebhookError) throw error;
    throw new MicrosoftGroupWebhookError(
      "No se pudo verificar la identidad y el grupo en Microsoft Graph.",
      503,
      "GRAPH_VALIDATION_FAILED"
    );
  }
}

function selectPendingSolicitud(rows, identity) {
  const candidates = Array.isArray(rows) ? rows : [];
  let matches = [];
  let criterion = "nombre";

  if (identity.solicitudId) {
    criterion = "solicitud_id";
    matches = candidates.filter((row) => (
      String(row.public_id || "") === identity.solicitudId ||
      String(row.id || "") === identity.solicitudId
    ));
  } else if (identity.documentNumber) {
    criterion = "numero_documento";
    const target = normalizeDocumentNumber(identity.documentNumber);
    matches = candidates.filter((row) => normalizeDocumentNumber(row.numero_documento) === target);
  } else if (identity.personalEmail) {
    criterion = "correo_personal";
    matches = candidates.filter((row) => normalizeCorporateEmail(row.correo_personal) === identity.personalEmail);
  } else {
    const corporateMatches = candidates.filter(
      (row) => normalizeCorporateEmail(row.correo_empresarial) === identity.email
    );
    if (corporateMatches.length) {
      criterion = "correo_silver";
      matches = corporateMatches;
    } else {
      const targetName = buildNameFingerprint(identity.displayName);
      matches = candidates.filter((row) => (
        buildNameFingerprint(`${row.nombre || ""} ${row.apellidos || ""}`) === targetName
      ));
    }
  }

  if (matches.length > 1) {
    throw new MicrosoftGroupWebhookError(
      `Hay varias solicitudes pendientes que coinciden por ${criterion}; se requiere solicitud_id o numero_documento.`,
      409,
      "AMBIGUOUS_PENDING_REQUEST"
    );
  }
  return matches[0] || null;
}

function requestedRoleTitle(solicitud) {
  if (!solicitud) return "Consultor";
  const extra = parseObject(solicitud.datos_extra);
  const rawGroup = normalizeText(solicitud.grupo_app_tiempos || extra.grupo_usuario) || "CONSULTOR";
  const normalized = normalizeMatchValue(rawGroup).replace(/\s+/g, "");
  const knownRoles = new Map([
    ["admin", "Administrador"],
    ["administrador", "Administrador"],
    ["coordinador", "Coordinador"],
    ["consultor", "Consultor"],
    ["contabilidad", "Contabilidad"],
    ["comercial", "Comercial"]
  ]);
  if (knownRoles.has(normalized)) return knownRoles.get(normalized);
  if (normalized === "otro") {
    return normalizeText(solicitud.grupo_usuario_otro || extra.grupo_usuario_otro) || "Consultor";
  }
  return rawGroup;
}

async function getRole(db, title) {
  const result = await db.query(
    `SELECT id, titulo
     FROM roles
     WHERE activo = true AND LOWER(BTRIM(titulo)) = LOWER(BTRIM($1::text))
     LIMIT 1`,
    [title]
  );
  if (!result.rows[0]) {
    throw new MicrosoftGroupWebhookError(
      `No existe un rol activo para el grupo solicitado: ${title}`,
      422,
      "ROLE_NOT_FOUND"
    );
  }
  return result.rows[0];
}

async function findPendingSolicitudes(db) {
  const result = await db.query(
    `SELECT
       sc.id,
       sc.public_id,
       sc.preregistro_id,
       sc.nombre,
       sc.apellidos,
       sc.numero_documento,
       sc.correo_personal,
       sc.correo_empresarial,
       sc.grupo_app_tiempos,
       sc.grupo_usuario_otro,
       sc.datos_extra,
       sc.estado
     FROM solicitudes_contratacion sc
     WHERE sc.tipo_solicitud = 'Nuevo'
       AND sc.estado = ANY($1::varchar[])
       AND sc.crear_usuario_sistema = true
     ORDER BY sc.updated_at DESC
     LIMIT 400`,
    [ACTIVE_ONBOARDING_STATES]
  );
  return result.rows;
}

async function lockSolicitud(db, id) {
  const result = await db.query(
    `SELECT id, public_id, preregistro_id, numero_documento, estado
     FROM solicitudes_contratacion
     WHERE id = $1
     FOR UPDATE`,
    [id]
  );
  return result.rows[0] || null;
}

async function findSolicitudPerson(db, solicitud) {
  const result = await db.query(
    `SELECT id, public_id, numero_documento, correo_electronico, correo_silver, azure_oid
     FROM personas
     WHERE ($1::text IS NOT NULL AND BTRIM(numero_documento) = BTRIM($1::text))
        OR ($2::int IS NOT NULL AND preregistro_id = $2::int)
     ORDER BY CASE WHEN $1::text IS NOT NULL AND BTRIM(numero_documento) = BTRIM($1::text) THEN 0 ELSE 1 END, id
     FOR UPDATE`,
    [normalizeText(solicitud?.numero_documento), solicitud?.preregistro_id || null]
  );
  if (result.rows.length > 1 && Number(result.rows[0].id) !== Number(result.rows[1].id)) {
    throw new MicrosoftGroupWebhookError(
      "La solicitud coincide con varias personas; se requiere revisión manual.",
      409,
      "AMBIGUOUS_PERSON"
    );
  }
  if (!result.rows[0]) {
    throw new MicrosoftGroupWebhookError(
      "La persona todavía no está materializada. Guarda primero la sección 3 desde TH.",
      409,
      "PERSON_NOT_MATERIALIZED"
    );
  }
  return result.rows[0];
}

async function relinkMicrosoftPlaceholder(db, { person, identity }) {
  if (!person?.id) return false;
  const userResult = await db.query(
    `SELECT id, persona_id, created_by
     FROM usuarios
     WHERE azure_oid = $1 OR LOWER(BTRIM(email)) = $2
     ORDER BY CASE WHEN azure_oid = $1 THEN 0 ELSE 1 END, id
     FOR UPDATE`,
    [identity.oid, identity.email]
  );
  if (userResult.rows.length !== 1) return false;

  const user = userResult.rows[0];
  if (!user.persona_id || Number(user.persona_id) === Number(person.id)) return false;
  if (String(user.created_by || "").toLowerCase() !== "ms_sso") return false;

  const placeholderResult = await db.query(
    `SELECT id, numero_documento, preregistro_id, numero_contacto, correo_silver, azure_oid
     FROM personas
     WHERE id = $1
     FOR UPDATE`,
    [user.persona_id]
  );
  const placeholder = placeholderResult.rows[0];
  const isSafePlaceholder = placeholder &&
    !normalizeText(placeholder.numero_documento) &&
    !placeholder.preregistro_id &&
    String(placeholder.azure_oid || "") === identity.oid &&
    normalizeCorporateEmail(placeholder.correo_silver) === identity.email;
  if (!isSafePlaceholder) return false;

  await db.query(
    `UPDATE personas target
     SET numero_contacto = COALESCE(NULLIF(BTRIM(target.numero_contacto), ''), $1),
         updated_at = NOW()
     WHERE target.id = $2`,
    [normalizeText(placeholder.numero_contacto) || identity.phone, person.id]
  );
  await db.query(
    `UPDATE personas
     SET correo_silver = NULL,
         azure_oid = NULL,
         estado = 'inactivo',
         updated_at = NOW()
     WHERE id = $1`,
    [placeholder.id]
  );
  await db.query(
    `UPDATE usuarios
     SET persona_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [person.id, user.id]
  );
  return true;
}

async function registerIdentityOnPendingSolicitud(db, { solicitud, person, identity }) {
  if (person) {
    if (person.azure_oid && String(person.azure_oid) !== identity.oid) {
      throw new MicrosoftGroupWebhookError(
        "La persona ya está vinculada a otra identidad de Microsoft.",
        409,
        "PERSON_IDENTITY_CONFLICT"
      );
    }
    if (person.correo_silver && normalizeCorporateEmail(person.correo_silver) !== identity.email) {
      throw new MicrosoftGroupWebhookError(
        "La persona ya tiene otro correo Silver.",
        409,
        "PERSON_EMAIL_CONFLICT"
      );
    }
    await db.query(
      `UPDATE personas
       SET correo_silver = $1, azure_oid = $2, updated_at = NOW()
       WHERE id = $3`,
      [identity.email, identity.oid, person.id]
    );
  }

  const solicitudResult = await db.query(
    `UPDATE solicitudes_contratacion
     SET correo_empresarial = $1,
         datos_extra = COALESCE(datos_extra, '{}'::jsonb) || jsonb_build_object(
           'correo_silver_origen', 'power_automate',
           'correo_silver_sincronizado_en', NOW(),
           'azure_oid', $2::text
         ),
         updated_at = NOW()
     WHERE id = $3 AND estado = ANY($4::varchar[])
     RETURNING public_id, estado`,
    [identity.email, identity.oid, solicitud.id, ACTIVE_ONBOARDING_STATES]
  );
  if (!solicitudResult.rows[0]) {
    throw new MicrosoftGroupWebhookError(
      "La solicitud ya no está disponible para sincronizar.",
      409,
      "REQUEST_STATE_CHANGED"
    );
  }

  if (solicitud.preregistro_id) {
    await db.query(
      `UPDATE preregistro_personas
       SET correo_silver = $1, updated_at = NOW()
       WHERE id = $2 AND estado <> 'Anulado'`,
      [identity.email, solicitud.preregistro_id]
    );
  }

  return {
    accion: "correo_silver_registrado",
    solicitud_id: solicitudResult.rows[0].public_id,
    estado: solicitudResult.rows[0].estado,
    persona_id: person?.public_id || null,
    usuario: {
      id: null,
      nombre: identity.displayName,
      correo: identity.email,
      id_azure: identity.oid
    }
  };
}

async function completePendingSolicitud(db, { solicitud, person, user, role, identity }) {
  const userResult = await db.query(
    `UPDATE usuarios u
     SET rol_usuario_id = $1,
         activo = true,
         nombre_usuario = $2,
         email = $3,
         azure_oid = $4,
         persona_id = p.id,
         nro_cuenta_bancaria = COALESCE(u.nro_cuenta_bancaria, p.numero_cuenta),
         banco_id = COALESCE(u.banco_id, p.banco_id),
         tipo_cuenta_id = COALESCE(u.tipo_cuenta_id, p.tipo_cuenta_id),
         tipo_documento_id = COALESCE(u.tipo_documento_id, p.tipo_documento_id),
         cedula = COALESCE(u.cedula, p.numero_documento),
         direccion = COALESCE(u.direccion, p.direccion_residencia),
         telefono = COALESCE(u.telefono, p.numero_contacto),
         ciudad = COALESCE(u.ciudad, p.ciudad_residencia),
         tipo_persona = COALESCE(u.tipo_persona, p.tipo_persona),
         moneda_cobro = COALESCE(p.moneda_cobro, u.moneda_cobro, 'COP'::tipo_moneda),
         factura_en_colombia = COALESCE(u.factura_en_colombia, p.factura_en_colombia),
         updated_at = NOW()
     FROM personas p
     WHERE u.id = $5 AND p.id = $6
     RETURNING u.id, u.public_id, u.nombre_usuario, u.email, u.azure_oid`,
    [role.id, identity.displayName, identity.email, identity.oid, user.id, person.id]
  );
  const updatedUser = userResult.rows[0];
  if (!updatedUser) {
    throw new MicrosoftGroupWebhookError("No se pudo actualizar el usuario creado.", 500, "USER_UPDATE_FAILED");
  }

  const solicitudResult = await db.query(
    `UPDATE solicitudes_contratacion
     SET correo_empresarial = $1,
         persona_usuario_id = $2,
         estado = 'Completado',
         fecha_revision_th = COALESCE(fecha_revision_th, NOW()),
         datos_extra = COALESCE(datos_extra, '{}'::jsonb) || jsonb_build_object(
           'correo_silver_origen', 'power_automate',
           'correo_silver_sincronizado_en', NOW(),
           'azure_oid', $3::text
         ),
         updated_at = NOW()
     WHERE id = $4 AND estado = $5
     RETURNING public_id, estado`,
    [identity.email, updatedUser.id, identity.oid, solicitud.id, PENDING_SILVER_STATE]
  );
  if (!solicitudResult.rows[0]) {
    throw new MicrosoftGroupWebhookError(
      "La solicitud ya no está pendiente de correo Silver.",
      409,
      "REQUEST_STATE_CHANGED"
    );
  }

  if (solicitud.preregistro_id) {
    await db.query(
      `UPDATE preregistro_personas
       SET correo_silver = $1,
           estado = 'Completado',
           id_usuario_creado = $2,
           fecha_aprobacion = COALESCE(fecha_aprobacion, NOW()),
           fecha_completado_th = COALESCE(fecha_completado_th, NOW()),
           updated_at = NOW()
       WHERE id = $3 AND estado IN ('Pendiente Correo Silver', 'Pendiente Revision TH')`,
      [identity.email, updatedUser.id, solicitud.preregistro_id]
    );
  }

  return {
    accion: "onboarding_completado",
    solicitud_id: solicitudResult.rows[0].public_id,
    estado: solicitudResult.rows[0].estado,
    rol: role.titulo,
    persona_id: person.public_id,
    usuario: {
      id: updatedUser.public_id,
      nombre: updatedUser.nombre_usuario,
      correo: updatedUser.email,
      id_azure: updatedUser.azure_oid
    }
  };
}

async function syncConsultoresGroupMember(input, dependencies = {}) {
  const dbPool = dependencies.pool || pool;
  const syncIdentity = dependencies.syncMicrosoftIdentity || syncMicrosoftIdentity;
  const resolveIdentity = dependencies.resolveAllowedMicrosoftIdentity || resolveAllowedMicrosoftIdentity;
  const identity = await resolveIdentity(input);
  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`microsoft-sso:${identity.oid}`]);

    const candidates = await findPendingSolicitudes(client);
    const selected = selectPendingSolicitud(candidates, identity);

    let person = null;
    if (selected) {
      const locked = await lockSolicitud(client, selected.id);
      if (!locked || !ACTIVE_ONBOARDING_STATES.includes(locked.estado)) {
        throw new MicrosoftGroupWebhookError(
          "La solicitud ya fue procesada por otro evento.",
          409,
          "REQUEST_ALREADY_PROCESSED"
        );
      }
      const lockedSolicitud = { ...selected, ...locked };
      try {
        person = await findSolicitudPerson(client, lockedSolicitud);
      } catch (error) {
        if (locked.estado === PENDING_SILVER_STATE || error?.code !== "PERSON_NOT_MATERIALIZED") throw error;
      }
      if (locked.estado !== PENDING_SILVER_STATE) {
        const earlyResult = await registerIdentityOnPendingSolicitud(client, {
          solicitud: lockedSolicitud,
          person,
          identity
        });
        await client.query("COMMIT");
        return earlyResult;
      }
    }

    const role = await getRole(client, requestedRoleTitle(selected));

    if (selected) {
      await relinkMicrosoftPlaceholder(client, { person, identity });
    }

    const user = await syncIdentity(client, {
      oid: identity.oid,
      email: identity.email,
      displayName: identity.displayName,
      phone: identity.phone,
      personalEmail: identity.personalEmail,
      documentNumber: identity.documentNumber,
      defaultRoleId: role.id,
      personId: person?.id || null,
      recordLogin: false,
      requireActiveUser: false
    });

    const result = selected
      ? await completePendingSolicitud(client, { solicitud: selected, person, user, role, identity })
      : {
        accion: "usuario_sincronizado",
        estado: "Completado",
        rol: user.rol || role.titulo,
        persona_id: user.persona_public_id || null,
        usuario: {
          id: user.public_id,
          nombre: user.nombre_usuario,
          correo: user.email,
          id_azure: user.azure_oid
        }
      };

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof MicrosoftIdentitySyncError) {
      throw new MicrosoftGroupWebhookError(error.message, error.statusCode || 409, "IDENTITY_CONFLICT");
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  MicrosoftGroupWebhookError,
  normalizeWebhookIdentity,
  resolveAllowedMicrosoftIdentity,
  buildNameFingerprint,
  selectPendingSolicitud,
  requestedRoleTitle,
  relinkMicrosoftPlaceholder,
  syncConsultoresGroupMember
};
