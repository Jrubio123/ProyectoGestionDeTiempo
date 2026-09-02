const crypto = require("crypto");
const { pool } = require("../db");
const { sendEmail } = require("../email");
const {
  calcularPeriodoVacaciones,
  formatDateEs: formatDate
} = require("./vacaciones-calendario.service");
const {
  getMicrosoftManager,
  getMicrosoftPerson,
  searchMicrosoftPeople
} = require("./microsoft-people.service");
const { getAvailableVacationDays } = require("./loggro-vacaciones.service");

const MANAGEMENT_ROLES = new Set(["administrador", "talento humano", "administrativo"]);
const TOKEN_DAYS = Math.max(1, Number(process.env.VACACIONES_TOKEN_DIAS || 30));

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isManagement(user) {
  return MANAGEMENT_ROLES.has(normalize(user?.rol));
}

function fixedBossEmails() {
  return String(process.env.VACACIONES_JEFES_FIJOS || "")
    .split(/[;,]/)
    .map(normalizeEmail)
    .filter(Boolean);
}

function emailContext(req = {}) {
  return {
    graphAccessToken: String(req.headers?.["x-graph-access-token"] || "").trim() || null,
    graphUserEmail: normalizeEmail(req.user?.email) || null
  };
}

function publicApiBase(req) {
  const configured = String(process.env.VACACIONES_PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host")}`;
}

function appUrl() {
  const base = String(process.env.FRONT_PORTAL_BASE || "").trim();
  if (!base) return "";
  return `${base.split("#")[0]}#vacaciones`;
}

async function currentUser(userId) {
  const result = await pool.query(`
    SELECT u.id, u.public_id::text AS usuario_id, u.nombre_usuario AS nombre,
           LOWER(u.email) AS email, u.azure_oid,
           p.id AS persona_internal_id, p.public_id::text AS persona_id,
           p.jefe_inmediato, p.correo_silver, p.correo_electronico,
           COALESCE(NULLIF(BTRIM(p.numero_documento), ''), NULLIF(BTRIM(u.cedula), '')) AS numero_documento,
           r.titulo AS rol
    FROM usuarios u
    LEFT JOIN personas p ON p.id = u.persona_id
    LEFT JOIN roles r ON r.id = u.rol_usuario_id
    WHERE u.id = $1 AND u.activo = TRUE
    LIMIT 1
  `, [userId]);
  return result.rows[0] || null;
}

function mapLocalPerson(row) {
  return {
    origen: "personas",
    usuario_id: row.usuario_id || null,
    persona_id: row.persona_id || null,
    azure_oid: row.azure_oid || null,
    nombre: row.nombre,
    email: normalizeEmail(row.email),
    cargo: row.cargo || null,
    _usuario_internal_id: row.usuario_internal_id || null,
    _persona_internal_id: row.persona_internal_id || null
  };
}

async function searchLocalPeople(query, limit = 12) {
  const pattern = `%${String(query || "").trim()}%`;
  const result = await pool.query(`
    WITH candidatos AS (
      SELECT u.id AS usuario_internal_id, u.public_id::text AS usuario_id,
             p.id AS persona_internal_id, p.public_id::text AS persona_id,
             COALESCE(u.azure_oid, p.azure_oid) AS azure_oid,
             u.nombre_usuario AS nombre,
             LOWER(COALESCE(NULLIF(u.email, ''), p.correo_silver, p.correo_electronico)) AS email,
             p.cargo
      FROM usuarios u
      LEFT JOIN personas p ON p.id = u.persona_id
      WHERE u.activo = TRUE
        AND (u.nombre_usuario ILIKE $1 OR u.email ILIKE $1
             OR p.nombre ILIKE $1 OR p.apellidos ILIKE $1
             OR p.correo_silver ILIKE $1 OR p.correo_electronico ILIKE $1)
      UNION ALL
      SELECT NULL, NULL, p.id, p.public_id::text, p.azure_oid,
             BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)),
             LOWER(COALESCE(NULLIF(p.correo_silver, ''), p.correo_electronico)), p.cargo
      FROM personas p
      WHERE LOWER(COALESCE(p.estado, 'activo')) = 'activo'
        AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.persona_id = p.id)
        AND (p.nombre ILIKE $1 OR p.apellidos ILIKE $1
             OR p.correo_silver ILIKE $1 OR p.correo_electronico ILIKE $1)
    )
    SELECT * FROM candidatos
    WHERE NULLIF(email, '') IS NOT NULL
    ORDER BY nombre
    LIMIT $2
  `, [pattern, limit]);
  return result.rows.map(mapLocalPerson);
}

async function findLocalPerson(reference = {}) {
  const email = normalizeEmail(reference.email);
  const usuarioId = String(reference.usuario_id || "").trim();
  const personaId = String(reference.persona_id || "").trim();
  const azureOid = String(reference.azure_oid || "").trim();
  const result = await pool.query(`
    SELECT u.id AS usuario_internal_id, u.public_id::text AS usuario_id,
           p.id AS persona_internal_id, p.public_id::text AS persona_id,
           COALESCE(u.azure_oid, p.azure_oid) AS azure_oid,
           COALESCE(u.nombre_usuario, BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos))) AS nombre,
           LOWER(COALESCE(NULLIF(u.email, ''), p.correo_silver, p.correo_electronico)) AS email,
           p.cargo
    FROM personas p
    FULL JOIN usuarios u ON u.persona_id = p.id
    WHERE (
         (NULLIF($1, '') IS NOT NULL AND u.public_id::text = $1)
      OR (NULLIF($2, '') IS NOT NULL AND p.public_id::text = $2)
      OR (NULLIF($3, '') IS NOT NULL AND COALESCE(u.azure_oid, p.azure_oid) = $3)
      OR (NULLIF($4, '') IS NOT NULL AND LOWER(COALESCE(NULLIF(u.email, ''), p.correo_silver, p.correo_electronico)) = $4)
    )
      AND (COALESCE(u.activo, FALSE) = TRUE OR (u.id IS NULL AND LOWER(COALESCE(p.estado, 'activo')) = 'activo'))
    ORDER BY CASE WHEN u.id IS NOT NULL THEN 0 ELSE 1 END
    LIMIT 1
  `, [usuarioId, personaId, azureOid, email]);
  return result.rows[0] ? mapLocalPerson(result.rows[0]) : null;
}

async function resolvePerson(reference = {}) {
  const local = await findLocalPerson(reference);
  if (local) return local;
  const graphReference = reference.azure_oid || reference.email;
  const microsoft = await getMicrosoftPerson(graphReference);
  if (microsoft) return microsoft;
  throw Object.assign(new Error("La persona no existe en Personas ni en Microsoft 365"), { statusCode: 404 });
}

async function fixedBosses() {
  const bosses = [];
  for (const email of fixedBossEmails()) {
    try {
      bosses.push(await resolvePerson({ email }));
    } catch (_) {
      bosses.push({ origen: "configuracion", nombre: email, email, azure_oid: null });
    }
  }
  return bosses;
}

function publicPerson(person) {
  if (!person) return null;
  const { _usuario_internal_id, _persona_internal_id, ...safe } = person;
  return safe;
}

async function searchPeople(req, res) {
  const query = String(req.query.q || "").trim();
  if (query.length < 2) return res.json(await fixedBosses().then((items) => items.map(publicPerson)));
  try {
    const local = await searchLocalPeople(query);
    let microsoft = [];
    try {
      microsoft = await searchMicrosoftPeople(query, 12);
    } catch (error) {
      console.error("[vacaciones] búsqueda Microsoft 365:", error.message);
    }
    const byEmail = new Map();
    [...local, ...microsoft, ...(await fixedBosses())].forEach((person) => {
      if (person?.email && !byEmail.has(person.email)) byEmail.set(person.email, publicPerson(person));
    });
    return res.json([...byEmail.values()].slice(0, 20));
  } catch (error) {
    console.error("[vacaciones] búsqueda de personas:", error);
    return res.status(500).json({ error: "No fue posible buscar personas" });
  }
}

async function getContext(req, res) {
  try {
    const user = await currentUser(req.user.id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
    let manager = null;
    try {
      manager = await getMicrosoftManager(user.azure_oid || user.email);
    } catch (error) {
      console.error("[vacaciones] jefe en Microsoft 365:", error.message);
    }
    if (!manager && user.jefe_inmediato) {
      manager = (await searchLocalPeople(user.jefe_inmediato, 1))[0] || null;
    }
    return res.json({
      solicitante: {
        usuario_id: user.usuario_id,
        persona_id: user.persona_id,
        nombre: user.nombre,
        email: user.email
      },
      jefe_sugerido: publicPerson(manager),
      jefes_fijos: (await fixedBosses()).map(publicPerson),
      puede_configurar: isManagement(req.user)
    });
  } catch (error) {
    console.error("[vacaciones] contexto:", error);
    return res.status(500).json({ error: "No fue posible cargar el contexto" });
  }
}

function calculate(req, res) {
  try {
    return res.json(calcularPeriodoVacaciones(req.body.fecha_inicio, req.body.fecha_fin));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
}

async function getAvailableDays(req, res) {
  try {
    const user = await currentUser(req.user.id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
    const result = await getAvailableVacationDays({
      documentNumber: user.numero_documento,
      date: req.query.fecha
    });
    return res.json(result);
  } catch (error) {
    console.error(`[vacaciones] saldo Loggro (${error.code || "ERROR"}):`, error.message);
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "No fue posible consultar los días disponibles en Loggro"
    });
  }
}

function requestEmailHtml(request, token, baseUrl) {
  const approve = `${baseUrl}/vacaciones/aprobacion/${encodeURIComponent(token)}?accion=aprobar`;
  const reject = `${baseUrl}/vacaciones/aprobacion/${encodeURIComponent(token)}?accion=rechazar`;
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1e293b;background:#f8fafc;padding:24px">
    <div style="max-width:620px;margin:auto;background:white;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
      <h2 style="margin-top:0">Solicitud de vacaciones</h2>
      <p><strong>${escapeHtml(request.solicitante_nombre)}</strong> solicita ${request.dias_habiles} día(s) hábil(es) de vacaciones.</p>
      <p>Desde <strong>${escapeHtml(formatDate(request.fecha_inicio))}</strong> hasta <strong>${escapeHtml(formatDate(request.fecha_fin))}</strong>.<br>Regreso: <strong>${escapeHtml(formatDate(request.fecha_regreso))}</strong>.</p>
      ${request.observaciones ? `<p>Observaciones: ${escapeHtml(request.observaciones)}</p>` : ""}
      <p style="margin-top:28px">
        <a href="${escapeHtml(approve)}" style="display:inline-block;background:#15803d;color:white;text-decoration:none;padding:12px 20px;border-radius:8px;margin-right:8px">Aceptar solicitud</a>
        <a href="${escapeHtml(reject)}" style="display:inline-block;background:#b91c1c;color:white;text-decoration:none;padding:12px 20px;border-radius:8px">Rechazar solicitud</a>
      </p>
      <p style="font-size:12px;color:#64748b;margin-top:24px">El enlace abre una confirmación y vence en ${TOKEN_DAYS} días.</p>
    </div></body></html>`;
}

async function trackEmail(requestId, type, recipients, sender) {
  try {
    await sender();
    await pool.query(
      `INSERT INTO vacaciones_notificaciones (solicitud_id, tipo, destinatarios, estado) VALUES ($1,$2,$3,'enviado')`,
      [requestId, type, recipients]
    );
    return null;
  } catch (error) {
    console.error(`[vacaciones] correo ${type}:`, error.message);
    await pool.query(
      `INSERT INTO vacaciones_notificaciones (solicitud_id, tipo, destinatarios, estado, error) VALUES ($1,$2,$3,'error',$4)`,
      [requestId, type, recipients, String(error.message || error).slice(0, 1500)]
    ).catch(() => {});
    return error.message;
  }
}

async function createRequest(req, res) {
  let calculated;
  try {
    calculated = calcularPeriodoVacaciones(req.body.fecha_inicio, req.body.fecha_fin);
    const today = new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/Bogota"
    }).format(new Date());
    if (calculated.fecha_inicio < today) {
      return res.status(400).json({ error: "La fecha inicial no puede estar en el pasado" });
    }
    if (calculated.dias_habiles < 1) {
      return res.status(400).json({ error: "El periodo debe contener al menos un día hábil" });
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const client = await pool.connect();
  try {
    const applicant = await currentUser(req.user.id);
    if (!applicant) return res.status(404).json({ error: "Solicitante no encontrado" });
    const boss = await resolvePerson(req.body.jefe || {});
    if (normalizeEmail(boss.email) === normalizeEmail(applicant.email)) {
      return res.status(400).json({ error: "El jefe inmediato debe ser diferente al solicitante" });
    }

    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await client.query("BEGIN");
    const inserted = await client.query(`
      INSERT INTO vacaciones_solicitudes (
        solicitante_usuario_id, solicitante_persona_id, solicitante_nombre, solicitante_correo,
        jefe_usuario_id, jefe_persona_id, jefe_azure_oid, jefe_nombre, jefe_correo,
        fecha_inicio, fecha_fin, dias_habiles, fecha_regreso, observaciones, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$1)
      RETURNING *, public_id::text AS solicitud_id,
                TO_CHAR(fecha_inicio,'YYYY-MM-DD') AS fecha_inicio_text,
                TO_CHAR(fecha_fin,'YYYY-MM-DD') AS fecha_fin_text,
                TO_CHAR(fecha_regreso,'YYYY-MM-DD') AS fecha_regreso_text
    `, [
      applicant.id, applicant.persona_internal_id, applicant.nombre, applicant.email,
      boss._usuario_internal_id || null, boss._persona_internal_id || null, boss.azure_oid || null,
      boss.nombre, boss.email, calculated.fecha_inicio, calculated.fecha_fin,
      calculated.dias_habiles, calculated.fecha_regreso,
      String(req.body.observaciones || "").trim().slice(0, 2000) || null
    ]);
    const request = inserted.rows[0];
    request.fecha_inicio = request.fecha_inicio_text;
    request.fecha_fin = request.fecha_fin_text;
    request.fecha_regreso = request.fecha_regreso_text;
    await client.query(`
      INSERT INTO vacaciones_aprobacion_tokens (solicitud_id, token_hash, expira_at)
      VALUES ($1,$2,NOW() + ($3 || ' days')::interval)
    `, [request.id, tokenHash, TOKEN_DAYS]);
    await client.query(`
      INSERT INTO vacaciones_auditoria (solicitud_id, evento, usuario_id, datos)
      VALUES ($1,'solicitada',$2,$3::jsonb)
    `, [request.id, applicant.id, JSON.stringify(calculated)]);
    await client.query("COMMIT");

    const warning = await trackEmail(request.id, "solicitud", [boss.email], () => sendEmail({
      to: boss.email,
      subject: `Solicitud de vacaciones - ${applicant.nombre}`,
      html: requestEmailHtml(request, rawToken, publicApiBase(req)),
      text: `${applicant.nombre} solicita vacaciones del ${request.fecha_inicio} al ${request.fecha_fin}.`,
      ...emailContext(req)
    }));
    return res.status(201).json({
      solicitud: mapRequest(request, req.user),
      calendario: calculated.calendario,
      advertencia_correo: warning || null
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[vacaciones] crear solicitud:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "No fue posible crear la solicitud" });
  } finally {
    client.release();
  }
}

function mapRequest(row, user) {
  const email = normalizeEmail(user?.email);
  const roleManagement = isManagement(user);
  const jefe = Number(row.jefe_usuario_id) === Number(user?.id) || normalizeEmail(row.jefe_correo) === email;
  return {
    id: row.solicitud_id || row.public_id,
    solicitante: { nombre: row.solicitante_nombre, email: row.solicitante_correo },
    jefe: { nombre: row.jefe_nombre, email: row.jefe_correo },
    fecha_inicio: row.fecha_inicio_text || String(row.fecha_inicio).slice(0, 10),
    fecha_fin: row.fecha_fin_text || String(row.fecha_fin).slice(0, 10),
    fecha_regreso: row.fecha_regreso_text || String(row.fecha_regreso).slice(0, 10),
    dias_habiles: Number(row.dias_habiles),
    estado: row.estado,
    observaciones: row.observaciones,
    comentario_decision: row.comentario_decision,
    solicitado_at: row.created_at,
    decidido_at: row.decidido_at,
    es_mia: Number(row.solicitante_usuario_id) === Number(user?.id),
    para_mi_aprobacion: jefe,
    puede_decidir: jefe && row.estado === "pendiente",
    vista_administrativa: roleManagement
  };
}

async function listRequests(req, res) {
  try {
    const email = normalizeEmail(req.user.email);
    const management = isManagement(req.user);
    const observer = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM vacaciones_destinatarios WHERE activo=TRUE AND LOWER(correo)=$1) AS value`,
      [email]
    );
    const isObserver = observer.rows[0]?.value === true;
    const result = await pool.query(`
      SELECT s.*, s.public_id::text AS solicitud_id,
             TO_CHAR(s.fecha_inicio,'YYYY-MM-DD') AS fecha_inicio_text,
             TO_CHAR(s.fecha_fin,'YYYY-MM-DD') AS fecha_fin_text,
             TO_CHAR(s.fecha_regreso,'YYYY-MM-DD') AS fecha_regreso_text
      FROM vacaciones_solicitudes s
      WHERE s.solicitante_usuario_id = $1
         OR s.jefe_usuario_id = $1
         OR LOWER(s.jefe_correo) = $2
         OR $3::boolean
         OR ($4::boolean AND s.estado = 'aprobada')
      ORDER BY s.fecha_inicio DESC, s.created_at DESC
    `, [req.user.id, email, management, isObserver]);
    return res.json({
      solicitudes: result.rows.map((row) => mapRequest(row, req.user)),
      permisos: { puede_configurar: management, puede_ver_panorama: management || isObserver }
    });
  } catch (error) {
    console.error("[vacaciones] listado:", error);
    return res.status(500).json({ error: "No fue posible listar las vacaciones" });
  }
}

async function configuredRecipients() {
  const result = await pool.query(
    `SELECT correo FROM vacaciones_destinatarios WHERE activo=TRUE ORDER BY nombre, correo`
  );
  return result.rows.map((row) => normalizeEmail(row.correo)).filter(Boolean);
}

function decisionEmailHtml(request, recipientsCopy = false) {
  const approved = request.estado === "aprobada";
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1e293b;padding:24px">
    <div style="max-width:620px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
      <h2 style="margin-top:0;color:${approved ? "#15803d" : "#b91c1c"}">Vacaciones ${approved ? "aprobadas" : "rechazadas"}</h2>
      <p>La solicitud de <strong>${escapeHtml(request.solicitante_nombre)}</strong> fue ${approved ? "aprobada" : "rechazada"}.</p>
      <p>${escapeHtml(formatDate(request.fecha_inicio))} al ${escapeHtml(formatDate(request.fecha_fin))} · ${request.dias_habiles} día(s) hábil(es).</p>
      ${approved ? `<p>Fecha de regreso: <strong>${escapeHtml(formatDate(request.fecha_regreso))}</strong>.</p>` : ""}
      ${request.comentario_decision ? `<p>Comentario: ${escapeHtml(request.comentario_decision)}</p>` : ""}
      ${appUrl() && !recipientsCopy ? `<p><a href="${escapeHtml(appUrl())}">Ver en la aplicación</a></p>` : ""}
    </div></body></html>`;
}

async function notifyDecision(request, context = {}) {
  const errors = [];
  const applicantEmail = normalizeEmail(request.solicitante_correo);
  if (applicantEmail) {
    const error = await trackEmail(request.id, "decision_solicitante", [applicantEmail], () => sendEmail({
      to: applicantEmail,
      subject: `Vacaciones ${request.estado === "aprobada" ? "aprobadas" : "rechazadas"}`,
      html: decisionEmailHtml(request),
      text: `Tu solicitud de vacaciones fue ${request.estado}.`,
      ...context
    }));
    if (error) errors.push(error);
  }
  if (request.estado === "aprobada") {
    const recipients = (await configuredRecipients()).filter((email) => email !== applicantEmail);
    if (recipients.length) {
      const error = await trackEmail(request.id, "aprobacion_informativa", recipients, () => sendEmail({
        to: recipients,
        subject: `Vacaciones aprobadas - ${request.solicitante_nombre}`,
        html: decisionEmailHtml(request, true),
        text: `${request.solicitante_nombre} tendrá vacaciones del ${request.fecha_inicio} al ${request.fecha_fin}.`,
        ...context
      }));
      if (error) errors.push(error);
    }
  }
  return errors;
}

async function applyDecision(client, request, action, comment, actor = {}) {
  const status = action === "aprobar" ? "aprobada" : "rechazada";
  const updated = await client.query(`
    UPDATE vacaciones_solicitudes
    SET estado=$1, comentario_decision=$2, decidido_at=NOW(),
        decidido_por_usuario_id=$3, decidido_por_correo=$4, updated_at=NOW()
    WHERE id=$5 AND estado='pendiente'
    RETURNING *, public_id::text AS solicitud_id,
              TO_CHAR(fecha_inicio,'YYYY-MM-DD') AS fecha_inicio_text,
              TO_CHAR(fecha_fin,'YYYY-MM-DD') AS fecha_fin_text,
              TO_CHAR(fecha_regreso,'YYYY-MM-DD') AS fecha_regreso_text
  `, [status, comment || null, actor.userId || null, actor.email || null, request.id]);
  if (!updated.rowCount) throw Object.assign(new Error("La solicitud ya fue procesada"), { statusCode: 409 });
  await client.query(
    `UPDATE vacaciones_aprobacion_tokens SET usado_at=NOW(), accion_usada=$1 WHERE solicitud_id=$2 AND usado_at IS NULL`,
    [action, request.id]
  );
  await client.query(
    `INSERT INTO vacaciones_auditoria (solicitud_id, evento, usuario_id, actor_correo, datos)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [request.id, status, actor.userId || null, actor.email || null, JSON.stringify({ comentario: comment || null, canal: actor.channel })]
  );
  const row = updated.rows[0];
  row.fecha_inicio = row.fecha_inicio_text;
  row.fecha_fin = row.fecha_fin_text;
  row.fecha_regreso = row.fecha_regreso_text;
  return row;
}

async function decideFromApp(req, res) {
  const action = normalize(req.body.accion);
  if (!['aprobar', 'rechazar'].includes(action)) return res.status(400).json({ error: "Acción inválida" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT * FROM vacaciones_solicitudes WHERE public_id::text=$1 FOR UPDATE`,
      [req.params.id]
    );
    const request = selected.rows[0];
    if (!request) throw Object.assign(new Error("Solicitud no encontrada"), { statusCode: 404 });
    const isBoss = Number(request.jefe_usuario_id) === Number(req.user.id)
      || normalizeEmail(request.jefe_correo) === normalizeEmail(req.user.email);
    if (!isBoss) throw Object.assign(new Error("Solo el jefe seleccionado puede decidir"), { statusCode: 403 });
    const updated = await applyDecision(
      client, request, action,
      String(req.body.comentario || "").trim().slice(0, 2000),
      { userId: req.user.id, email: req.user.email, channel: "aplicacion" }
    );
    await client.query("COMMIT");
    const errors = await notifyDecision(updated, emailContext(req));
    return res.json({ solicitud: mapRequest(updated, req.user), advertencias_correo: errors });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[vacaciones] decisión aplicación:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "No fue posible procesar la solicitud" });
  } finally {
    client.release();
  }
}

function approvalPage({ token, action, request, message, done = false }) {
  const validAction = ['aprobar', 'rechazar'].includes(action) ? action : 'aprobar';
  const title = done ? message : `${validAction === 'aprobar' ? 'Aprobar' : 'Rechazar'} solicitud`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><link rel="icon" href="data:,"><title>${escapeHtml(title)}</title></head>
  <body style="font-family:Arial,sans-serif;background:#f1f5f9;color:#1e293b;padding:24px"><main style="max-width:560px;margin:40px auto;background:#fff;border-radius:14px;padding:30px;border:1px solid #e2e8f0">
    <h1 style="font-size:24px">${escapeHtml(title)}</h1>
    ${done ? `<p>${escapeHtml(message)}</p>` : `<p><strong>${escapeHtml(request.solicitante_nombre)}</strong><br>${escapeHtml(formatDate(request.fecha_inicio))} al ${escapeHtml(formatDate(request.fecha_fin))}<br>${request.dias_habiles} día(s) hábil(es) · regreso ${escapeHtml(formatDate(request.fecha_regreso))}</p>
      <form method="post" action="/vacaciones/aprobacion/${encodeURIComponent(token)}">
        <input type="hidden" name="accion" value="${validAction}">
        <label style="display:block;margin:18px 0 6px">Comentario (opcional)</label>
        <textarea name="comentario" maxlength="2000" style="width:100%;min-height:90px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:10px"></textarea>
        <button type="submit" style="margin-top:18px;border:0;border-radius:8px;padding:12px 20px;color:white;background:${validAction === 'aprobar' ? '#15803d' : '#b91c1c'}">Confirmar ${validAction === 'aprobar' ? 'aprobación' : 'rechazo'}</button>
      </form>`}
  </main></body></html>`;
}

async function findByApprovalToken(token, lockClient = null) {
  const hash = crypto.createHash("sha256").update(String(token || "")).digest("hex");
  const db = lockClient || pool;
  const result = await db.query(`
    SELECT s.*, t.id AS token_id, t.expira_at, t.usado_at
    FROM vacaciones_aprobacion_tokens t
    JOIN vacaciones_solicitudes s ON s.id=t.solicitud_id
    WHERE t.token_hash=$1
    ${lockClient ? "FOR UPDATE OF s, t" : ""}
  `, [hash]);
  return result.rows[0] || null;
}

async function showApproval(req, res) {
  const action = normalize(req.query.accion);
  res.set("Cache-Control", "no-store");
  try {
    const request = await findByApprovalToken(req.params.token);
    if (!request || request.usado_at || request.estado !== 'pendiente' || new Date(request.expira_at) < new Date()) {
      return res.status(410).send(approvalPage({ done: true, message: "Este enlace ya fue usado, venció o no es válido." }));
    }
    return res.send(approvalPage({ token: req.params.token, action, request }));
  } catch (error) {
    console.error("[vacaciones] abrir aprobación:", error);
    return res.status(500).send(approvalPage({ done: true, message: "No fue posible abrir la solicitud." }));
  }
}

async function decideFromEmail(req, res) {
  const action = normalize(req.body.accion);
  res.set("Cache-Control", "no-store");
  if (!['aprobar', 'rechazar'].includes(action)) {
    return res.status(400).send(approvalPage({ done: true, message: "Acción inválida." }));
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const request = await findByApprovalToken(req.params.token, client);
    if (!request || request.usado_at || request.estado !== 'pendiente' || new Date(request.expira_at) < new Date()) {
      throw Object.assign(new Error("Este enlace ya fue usado, venció o no es válido."), { statusCode: 410 });
    }
    const updated = await applyDecision(
      client, request, action,
      String(req.body.comentario || "").trim().slice(0, 2000),
      { email: request.jefe_correo, channel: "correo" }
    );
    await client.query("COMMIT");
    await notifyDecision(updated);
    return res.send(approvalPage({ done: true, message: `La solicitud fue ${updated.estado} correctamente.` }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[vacaciones] decisión correo:", error);
    return res.status(error.statusCode || 500).send(approvalPage({ done: true, message: error.statusCode ? error.message : "No fue posible procesar la solicitud." }));
  } finally {
    client.release();
  }
}

async function getNotificationConfig(req, res) {
  try {
    const result = await pool.query(`
      SELECT d.public_id::text AS id, d.origen,
             p.public_id::text AS persona_id, u.public_id::text AS usuario_id,
             d.azure_oid, d.nombre, d.correo, d.cargo
      FROM vacaciones_destinatarios d
      LEFT JOIN personas p ON p.id=d.persona_id
      LEFT JOIN usuarios u ON u.id=d.usuario_id
      WHERE d.activo=TRUE ORDER BY d.nombre, d.correo
    `);
    return res.json(result.rows);
  } catch (error) {
    console.error("[vacaciones] configuración:", error);
    return res.status(500).json({ error: "No fue posible cargar la configuración" });
  }
}

async function updateNotificationConfig(req, res) {
  const recipients = Array.isArray(req.body.destinatarios) ? req.body.destinatarios : [];
  if (recipients.length > 50) return res.status(400).json({ error: "Máximo 50 destinatarios" });
  const client = await pool.connect();
  try {
    const resolved = [];
    for (const item of recipients) {
      const person = await resolvePerson(item);
      if (!resolved.some((candidate) => candidate.email === person.email)) resolved.push(person);
    }
    await client.query("BEGIN");
    await client.query("DELETE FROM vacaciones_destinatarios");
    for (const person of resolved) {
      await client.query(`
        INSERT INTO vacaciones_destinatarios
          (origen, persona_id, usuario_id, azure_oid, nombre, correo, cargo, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        person.origen, person._persona_internal_id || null, person._usuario_internal_id || null,
        person.azure_oid || null, person.nombre, person.email, person.cargo || null, req.user.id
      ]);
    }
    await client.query("COMMIT");
    return getNotificationConfig(req, res);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[vacaciones] guardar configuración:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "No fue posible guardar la configuración" });
  } finally {
    client.release();
  }
}

module.exports = {
  calculate,
  createRequest,
  decideFromApp,
  decideFromEmail,
  getAvailableDays,
  getContext,
  getNotificationConfig,
  listRequests,
  searchPeople,
  showApproval,
  updateNotificationConfig
};
