const { pool } = require("../db");
const { sendEmail } = require("../email");
const {
  EntregaValidationError,
  TIPOS_SERVICIO,
  validateEntregaPayload
} = require("./entregas-servicio.domain");

const ALLOWED_ROLES = ["Administrador", "Coordinador", "Comercial"];
const STATUS_TRANSITIONS = Object.freeze({
  REGISTRADA: ["ACEPTADA", "CANCELADA"],
  ACEPTADA: [],
  EN_PROCESO: [],
  CERRADA: [],
  CANCELADA: []
});

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function allowedReceptionStatuses(role) {
  const normalized = normalizeRole(role);
  if (normalized === "coordinador") return ["ACEPTADA"];
  if (normalized === "administrador") return ["ACEPTADA", "CANCELADA"];
  return [];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function handleError(res, error, context) {
  if (error instanceof EntregaValidationError) {
    return res.status(error.statusCode).json({ error: error.message, field: error.field });
  }
  if (error?.code === "23505") {
    return res.status(409).json({ error: "Ya existe un registro con los mismos datos." });
  }
  console.error(`[entregas-servicio] ${context}:`, error);
  return res.status(500).json({ error: `No se pudo ${context}.` });
}

function visibilitySql(req, alias = "e", startIndex = 1) {
  const role = normalizeRole(req.user?.rol);
  if (role === "administrador") return { clause: "", params: [] };
  if (role === "coordinador") {
    return { clause: `AND ${alias}.coordinador_asignado_id = $${startIndex}`, params: [req.user.id] };
  }
  return { clause: `AND ${alias}.creado_por = $${startIndex}`, params: [req.user.id] };
}

const DELIVERY_SELECT = `
  SELECT
    e.public_id::text AS id,
    e.tipo_servicio,
    e.nombre_servicio,
    e.estado,
    e.perfil_cliente,
    e.analisis_adaptabilidad,
    e.acuerdos_comerciales,
    e.created_at,
    e.updated_at,
    c.public_id::text AS cliente_id,
    c.titulo AS cliente,
    c.nit AS cliente_nit,
    coord.public_id::text AS coordinador_id,
    coord.nombre_usuario AS coordinador,
    coord.email AS coordinador_email,
    coord_rol.titulo AS coordinador_rol,
    creador.public_id::text AS creado_por_id,
    creador.nombre_usuario AS creado_por,
    COALESCE((
      SELECT json_agg(json_build_object(
        'id', COALESCE(u.public_id::text, ec.public_id::text),
        'tipo', CASE WHEN ec.consultor_id IS NULL THEN 'EXTERNO' ELSE 'USUARIO' END,
        'nombre', COALESCE(u.nombre_usuario, ec.nombre_externo),
        'email', u.email,
        'telefono', ec.telefono_externo,
        'es_principal', ec.es_principal
      ) ORDER BY ec.es_principal DESC, COALESCE(u.nombre_usuario, ec.nombre_externo))
      FROM entregas_servicio_consultores ec
      LEFT JOIN usuarios u ON u.id = ec.consultor_id
      WHERE ec.entrega_servicio_id = e.id
    ), '[]'::json) AS consultores,
    COALESCE((
      SELECT json_agg(json_build_object(
        'id', COALESCE(m.public_id::text, ''),
        'nombre', COALESCE(m.titulo, em.modulo_otro)
      ) ORDER BY COALESCE(m.titulo, em.modulo_otro))
      FROM entregas_servicio_modulos em
      LEFT JOIN modulo m ON m.id = em.modulo_id
      WHERE em.entrega_servicio_id = e.id
    ), '[]'::json) AS modulos,
    COALESCE((
      SELECT json_agg(json_build_object(
        'id', d.public_id::text,
        'titulo', d.titulo,
        'url', d.url
      ) ORDER BY d.created_at)
      FROM entregas_servicio_enlaces d
      WHERE d.entrega_servicio_id = e.id
    ), '[]'::json) AS enlaces,
    COALESCE((
      SELECT json_build_object(
        'id', cc.public_id::text,
        'nombre', cc.nombre,
        'cargo', cc.cargo,
        'telefono', cc.telefono,
        'email', cc.email
      )
      FROM entregas_servicio_contactos esc
      JOIN contactos_cliente cc ON cc.id = esc.contacto_cliente_id
      WHERE esc.entrega_servicio_id = e.id AND esc.tipo_contacto = 'INTERVENTOR'
      ORDER BY esc.created_at
      LIMIT 1
    ), '{}'::json) AS interventor,
    COALESCE((
      SELECT json_build_object(
        'estado', n.estado,
        'intentos', n.intentos,
        'ultimo_error', n.ultimo_error,
        'enviado_at', n.enviado_at
      )
      FROM entregas_servicio_notificaciones n
      WHERE n.entrega_servicio_id = e.id AND n.tipo = 'ASIGNACION'
      ORDER BY n.created_at DESC
      LIMIT 1
    ), '{}'::json) AS notificacion,
    CASE e.tipo_servicio
      WHEN 'PROYECTO' THEN (
        SELECT json_build_object(
          'objeto_proyecto', p.objeto_proyecto,
          'valor_total', p.valor_total,
          'moneda', p.moneda,
          'valor_forma_pago', p.valor_forma_pago,
          'moneda_forma_pago', p.moneda_forma_pago,
          'equipo_estimacion', p.equipo_estimacion,
          'tarifa_consultoria', p.tarifa_consultoria,
          'moneda_tarifa_consultoria', p.moneda_tarifa_consultoria
        ) FROM entregas_servicio_proyecto p WHERE p.entrega_servicio_id = e.id
      )
      WHEN 'MESA_SERVICIO' THEN (
        SELECT json_build_object(
          'detalle_tarifas', m.detalle_tarifas,
          'forma_pago', m.forma_pago
        ) FROM entregas_servicio_mesa m WHERE m.entrega_servicio_id = e.id
      )
      ELSE (
        SELECT json_build_object(
          'tiempo_descripcion', o.tiempo_descripcion,
          'tarifa', o.tarifa,
          'valor_cliente', o.valor_cliente,
          'moneda', o.moneda,
          'tiene_contrato', o.tiene_contrato
        ) FROM entregas_servicio_outsourcing o WHERE o.entrega_servicio_id = e.id
      )
    END AS detalle
  FROM entregas_servicio e
  JOIN clientes c ON c.id = e.cliente_id
  JOIN usuarios coord ON coord.id = e.coordinador_asignado_id
  JOIN roles coord_rol ON coord_rol.id = coord.rol_usuario_id
  JOIN usuarios creador ON creador.id = e.creado_por
`;

async function getCatalogs(req, res) {
  try {
    const [clientes, coordinadores, consultores, modulos] = await Promise.all([
      pool.query(`
        SELECT public_id::text AS id, titulo AS nombre, nit, direccion
        FROM clientes WHERE activo = true ORDER BY titulo
      `),
      pool.query(`
        SELECT u.public_id::text AS id, u.nombre_usuario AS nombre, u.email, r.titulo AS rol,
               (u.id = $1) AS es_actual
        FROM usuarios u
        JOIN roles r ON r.id = u.rol_usuario_id
        WHERE u.activo = true AND r.activo = true
          AND r.titulo IN ('Administrador', 'Coordinador')
        ORDER BY r.titulo, u.nombre_usuario
      `, [req.user.id]),
      pool.query(`
        SELECT u.public_id::text AS id, u.nombre_usuario AS nombre, u.email
        FROM usuarios u
        LEFT JOIN roles r ON r.id = u.rol_usuario_id
        WHERE u.activo = true
          AND (r.titulo IN ('Consultor', 'Consultor Principal', 'Mesa de Servicio') OR u.tipo_consultor IS NOT NULL)
        ORDER BY u.nombre_usuario
      `),
      pool.query(`
        SELECT public_id::text AS id, titulo AS nombre
        FROM modulo WHERE activo = true ORDER BY titulo
      `)
    ]);
    return res.json({
      clientes: clientes.rows,
      coordinadores: coordinadores.rows,
      consultores: consultores.rows,
      modulos: modulos.rows
    });
  } catch (error) {
    return handleError(res, error, "cargar los catálogos de entregas");
  }
}

async function listClientContacts(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        cc.public_id::text AS id,
        cc.nombre,
        cc.cargo,
        cc.telefono,
        cc.email,
        cc.es_contacto_principal
      FROM contactos_cliente cc
      JOIN clientes c ON c.id = cc.cliente_id
      WHERE c.public_id::text = $1 AND cc.activo = true
      ORDER BY cc.es_contacto_principal DESC, cc.nombre
    `, [String(req.params.clienteId || "")]);
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, "cargar los contactos del cliente");
  }
}

async function listDeliveries(req, res) {
  try {
    const visibility = visibilitySql(req, "e", 1);
    const tipo = String(req.query.tipo || "").trim().toUpperCase();
    const estado = String(req.query.estado || "").trim().toUpperCase();
    const search = String(req.query.q || "").trim();
    const params = [...visibility.params];
    const filters = [visibility.clause];
    if (tipo) {
      params.push(tipo);
      filters.push(`AND e.tipo_servicio = $${params.length}`);
    }
    if (estado) {
      params.push(estado);
      filters.push(`AND e.estado = $${params.length}`);
    }
    if (search) {
      params.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
      filters.push(`AND (e.nombre_servicio ILIKE $${params.length} ESCAPE '\\' OR c.titulo ILIKE $${params.length} ESCAPE '\\')`);
    }
    const result = await pool.query(`
      ${DELIVERY_SELECT}
      WHERE 1 = 1 ${filters.join(" ")}
      ORDER BY e.created_at DESC
      LIMIT 300
    `, params);
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, "listar las entregas de servicio");
  }
}

async function getDeliveryForUser(req, publicId) {
  const visibility = visibilitySql(req, "e", 2);
  const result = await pool.query(`
    ${DELIVERY_SELECT}
    WHERE e.public_id::text = $1 ${visibility.clause}
    LIMIT 1
  `, [publicId, ...visibility.params]);
  return result.rows[0] || null;
}

async function getDelivery(req, res) {
  try {
    const row = await getDeliveryForUser(req, String(req.params.id || ""));
    if (!row) return res.status(404).json({ error: "Entrega de servicio no encontrada." });
    return res.json(row);
  } catch (error) {
    return handleError(res, error, "consultar la entrega de servicio");
  }
}

async function insertContact(client, clienteId, contact, createdBy, principal = false) {
  if (principal) {
    await client.query(`
      UPDATE contactos_cliente
      SET es_contacto_principal = false, updated_at = CURRENT_TIMESTAMP
      WHERE cliente_id = $1 AND es_contacto_principal = true AND activo = true
    `, [clienteId]);
  }
  const result = await client.query(`
    INSERT INTO contactos_cliente
      (cliente_id, nombre, cargo, telefono, email, es_contacto_principal, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, public_id::text AS public_id, nombre, cargo, telefono, email
  `, [
    clienteId,
    contact.nombre,
    contact.cargo,
    contact.telefono,
    contact.email,
    principal,
    createdBy
  ]);
  return result.rows[0];
}

async function resolveOrCreateClient(client, payload, createdBy) {
  if (payload.cliente_id) {
    const result = await client.query(`
      SELECT id, public_id::text AS public_id, titulo, nit
      FROM clientes WHERE public_id::text = $1 AND activo = true
    `, [payload.cliente_id]);
    if (!result.rows[0]) throw new EntregaValidationError("El cliente seleccionado no existe o está inactivo.", "cliente_id");
    return { cliente: result.rows[0], principalContact: null };
  }

  await client.query("SELECT pg_advisory_xact_lock(hashtext('clientes_correlativo'))");
  const duplicate = await client.query(`
    SELECT public_id::text AS id, titulo, activo
    FROM clientes
    WHERE REGEXP_REPLACE(UPPER(nit), '[^0-9A-Z]', '', 'g') = $1
       OR LOWER(BTRIM(titulo)) = LOWER(BTRIM($2))
    LIMIT 1
  `, [payload.cliente_nuevo.nit, payload.cliente_nuevo.titulo]);
  if (duplicate.rows[0]) {
    const error = new EntregaValidationError(
      "El cliente o NIT ya existe. Selecciónalo en el buscador.",
      "cliente_nuevo.nit"
    );
    error.statusCode = 409;
    throw error;
  }
  const correlation = await client.query("SELECT COALESCE(MAX(correlativo), 0) + 1 AS next_value FROM clientes");
  const inserted = await client.query(`
    INSERT INTO clientes
      (titulo, nit, correlativo, activo, direccion, requiere_confirmacion_cliente)
    VALUES ($1, $2, $3, true, $4, false)
    RETURNING id, public_id::text AS public_id, titulo, nit
  `, [
    payload.cliente_nuevo.titulo,
    payload.cliente_nuevo.nit,
    correlation.rows[0].next_value,
    payload.cliente_nuevo.direccion
  ]);
  const principalContact = await insertContact(
    client,
    inserted.rows[0].id,
    payload.cliente_nuevo.contacto,
    createdBy,
    true
  );
  return { cliente: inserted.rows[0], principalContact };
}

async function resolveCoordinator(client, publicId) {
  const result = await client.query(`
    SELECT u.id, u.public_id::text AS public_id, u.nombre_usuario, u.email, r.titulo AS rol
    FROM usuarios u
    JOIN roles r ON r.id = u.rol_usuario_id
    WHERE u.public_id::text = $1 AND u.activo = true AND r.activo = true
      AND r.titulo IN ('Administrador', 'Coordinador')
  `, [publicId]);
  if (!result.rows[0]) {
    throw new EntregaValidationError("El coordinador seleccionado no es válido.", "coordinador_id");
  }
  return result.rows[0];
}

async function resolveConsultants(client, publicIds) {
  if (!publicIds.length) return [];
  const result = await client.query(`
    SELECT u.id, u.public_id::text AS public_id, u.nombre_usuario, u.email
    FROM usuarios u
    LEFT JOIN roles r ON r.id = u.rol_usuario_id
    WHERE u.public_id::text = ANY($1::text[]) AND u.activo = true
      AND (r.titulo IN ('Consultor', 'Consultor Principal', 'Mesa de Servicio') OR u.tipo_consultor IS NOT NULL)
  `, [publicIds]);
  if (result.rows.length !== publicIds.length) {
    throw new EntregaValidationError("Uno o más consultores no son válidos.", "consultores_ids");
  }
  const byId = new Map(result.rows.map((row) => [row.public_id, row]));
  return publicIds.map((id) => byId.get(id));
}

async function resolveModules(client, publicIds) {
  if (!publicIds.length) return [];
  const result = await client.query(`
    SELECT id, public_id::text AS public_id, titulo
    FROM modulo
    WHERE public_id::text = ANY($1::text[]) AND activo = true
  `, [publicIds]);
  if (result.rows.length !== publicIds.length) {
    throw new EntregaValidationError("Uno o más módulos no son válidos.", "modulos_ids");
  }
  return result.rows;
}

async function resolveDeliveryContact(client, payload, cliente, principalContact, createdBy) {
  if (principalContact) return principalContact;
  if (payload.contacto_id) {
    const result = await client.query(`
      SELECT cc.id, cc.public_id::text AS public_id, cc.nombre, cc.cargo, cc.telefono, cc.email
      FROM contactos_cliente cc
      WHERE cc.public_id::text = $1 AND cc.cliente_id = $2 AND cc.activo = true
    `, [payload.contacto_id, cliente.id]);
    if (!result.rows[0]) {
      throw new EntregaValidationError("El contacto seleccionado no pertenece al cliente.", "contacto_id");
    }
    return result.rows[0];
  }
  const count = await client.query(
    "SELECT COUNT(*)::int AS total FROM contactos_cliente WHERE cliente_id = $1 AND activo = true",
    [cliente.id]
  );
  return insertContact(client, cliente.id, payload.contacto_nuevo, createdBy, count.rows[0].total === 0);
}

async function insertServiceDetail(client, entregaId, payload) {
  const detail = payload.detalle;
  if (payload.tipo_servicio === TIPOS_SERVICIO.PROYECTO) {
    await client.query(`
      INSERT INTO entregas_servicio_proyecto
        (entrega_servicio_id, objeto_proyecto, valor_total, moneda, valor_forma_pago, moneda_forma_pago,
         equipo_estimacion, tarifa_consultoria, moneda_tarifa_consultoria)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      entregaId,
      detail.objeto_proyecto,
      detail.valor_total,
      detail.moneda,
      detail.valor_forma_pago,
      detail.moneda_forma_pago,
      detail.equipo_estimacion,
      detail.tarifa_consultoria,
      detail.moneda_tarifa_consultoria
    ]);
    return;
  }
  if (payload.tipo_servicio === TIPOS_SERVICIO.MESA_SERVICIO) {
    await client.query(`
      INSERT INTO entregas_servicio_mesa (entrega_servicio_id, detalle_tarifas, forma_pago)
      VALUES ($1, $2, $3)
    `, [entregaId, detail.detalle_tarifas, detail.forma_pago]);
    return;
  }
  await client.query(`
    INSERT INTO entregas_servicio_outsourcing
      (entrega_servicio_id, tiempo_descripcion, tarifa, valor_cliente, moneda, tiene_contrato)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    entregaId,
    detail.tiempo_descripcion,
    detail.tarifa,
    detail.valor_cliente,
    detail.moneda,
    detail.tiene_contrato
  ]);
}

async function getAdminBcc(client, coordinator) {
  if (normalizeRole(coordinator.rol) === "administrador") return [];
  const result = await client.query(`
    SELECT DISTINCT LOWER(u.email) AS email
    FROM usuarios u
    JOIN roles r ON r.id = u.rol_usuario_id
    WHERE u.activo = true AND r.activo = true AND r.titulo = 'Administrador'
      AND NULLIF(BTRIM(u.email), '') IS NOT NULL
      AND LOWER(u.email) <> LOWER($1)
    ORDER BY email
  `, [coordinator.email]);
  return result.rows.map((row) => row.email);
}

function typeLabel(value) {
  return {
    PROYECTO: "Proyecto",
    MESA_SERVICIO: "Mesa de servicios / Fábrica / Requerimiento por demanda",
    OUTSOURCING: "Outsourcing"
  }[value] || value;
}

function portalUrl() {
  const base = String(process.env.FRONT_PORTAL_BASE || "").trim();
  if (!base) return null;
  return `${base.split("#")[0]}#entregas-servicio`;
}

function buildNotificationContent(delivery) {
  const assignerName = delivery.asignador?.nombre_usuario || delivery.creador.nombre_usuario || "Comercial";
  const consultants = delivery.consultores.map((item) => {
    const name = item.nombre_usuario || "Consultor";
    return item.telefono ? `${name} (${item.telefono})` : name;
  }).join(", ") || "Sin asignar";
  const modules = delivery.modulos.map((item) => item.titulo).concat(delivery.modulos_otros).join(", ");
  const links = delivery.enlaces.map((item) => (
    `<li><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.titulo || "Abrir enlace")}</a></li>`
  )).join("");
  const url = portalUrl();
  return {
    subject: `Nueva entrega de servicio: ${delivery.cliente.titulo} - ${delivery.nombre_servicio}`,
    text: [
      `${assignerName} asignó un nuevo servicio a ${delivery.coordinador.nombre_usuario}.`,
      `Cliente: ${delivery.cliente.titulo}`,
      `Servicio: ${typeLabel(delivery.tipo_servicio)} - ${delivery.nombre_servicio}`,
      `Módulos: ${modules}`,
      `Consultores: ${consultants}`,
      `Creado por: ${delivery.creador.nombre_usuario}`,
      ...delivery.enlaces.map((item) => `Enlace: ${item.url}`),
      url ? `Portal: ${url}` : ""
    ].filter(Boolean).join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;color:#1e293b;line-height:1.5">
        <h2 style="margin:0 0 16px">Nueva entrega de servicio</h2>
        <p>Hola <strong>${escapeHtml(delivery.coordinador.nombre_usuario)}</strong>, <strong>${escapeHtml(assignerName)}</strong> te asignó una nueva entrega.</p>
        <table style="border-collapse:collapse;width:100%;max-width:680px">
          <tr><td style="padding:7px;border-bottom:1px solid #e2e8f0"><strong>Cliente</strong></td><td style="padding:7px;border-bottom:1px solid #e2e8f0">${escapeHtml(delivery.cliente.titulo)}</td></tr>
          <tr><td style="padding:7px;border-bottom:1px solid #e2e8f0"><strong>Servicio</strong></td><td style="padding:7px;border-bottom:1px solid #e2e8f0">${escapeHtml(typeLabel(delivery.tipo_servicio))} - ${escapeHtml(delivery.nombre_servicio)}</td></tr>
          <tr><td style="padding:7px;border-bottom:1px solid #e2e8f0"><strong>Módulos</strong></td><td style="padding:7px;border-bottom:1px solid #e2e8f0">${escapeHtml(modules)}</td></tr>
          <tr><td style="padding:7px;border-bottom:1px solid #e2e8f0"><strong>Consultores</strong></td><td style="padding:7px;border-bottom:1px solid #e2e8f0">${escapeHtml(consultants)}</td></tr>
          <tr><td style="padding:7px"><strong>Entregado por</strong></td><td style="padding:7px">${escapeHtml(delivery.creador.nombre_usuario)}</td></tr>
        </table>
        ${links ? `<h3 style="margin:20px 0 8px">Enlaces comerciales</h3><ul>${links}</ul>` : ""}
        ${url ? `<p style="margin-top:20px"><a href="${escapeHtml(url)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">Ver entrega</a></p>` : ""}
      </div>
    `
  };
}

async function sendAssignmentNotification({ delivery, notificationId, graphAccessToken }) {
  const content = buildNotificationContent(delivery);
  try {
    await sendEmail({
      to: delivery.coordinador.email,
      bcc: delivery.bcc,
      subject: content.subject,
      text: content.text,
      html: content.html,
      graphAccessToken,
      graphUserEmail: process.env.GRAPH_SENDER_USER || process.env.ONEDRIVE_TARGET_USER
    });
    await pool.query(`
      UPDATE entregas_servicio_notificaciones
      SET estado = 'ENVIADA', intentos = intentos + 1, ultimo_error = NULL,
          enviado_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [notificationId]);
    return { estado: "ENVIADA" };
  } catch (error) {
    await pool.query(`
      UPDATE entregas_servicio_notificaciones
      SET estado = 'ERROR', intentos = intentos + 1, ultimo_error = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [notificationId, String(error.message || error).slice(0, 2000)]);
    console.error("[entregas-servicio] No se pudo notificar:", error.message || error);
    return { estado: "ERROR", error: "La entrega quedó guardada, pero el correo no pudo enviarse." };
  }
}

async function createDelivery(req, res) {
  let client;
  try {
    const payload = validateEntregaPayload(req.body || {});
    client = await pool.connect();
    await client.query("BEGIN");

    const { cliente, principalContact } = await resolveOrCreateClient(client, payload, req.user.id);
    const coordinator = await resolveCoordinator(client, payload.coordinador_id);
    const consultants = await resolveConsultants(client, payload.consultores_ids);
    const modules = await resolveModules(client, payload.modulos_ids);
    const contact = await resolveDeliveryContact(client, payload, cliente, principalContact, req.user.id);

    const inserted = await client.query(`
      INSERT INTO entregas_servicio
        (cliente_id, coordinador_asignado_id, tipo_servicio, nombre_servicio, estado,
         perfil_cliente, analisis_adaptabilidad, acuerdos_comerciales, creado_por)
      VALUES ($1, $2, $3, $4, 'REGISTRADA', $5, $6, $7, $8)
      RETURNING id, public_id::text AS public_id, created_at
    `, [
      cliente.id,
      coordinator.id,
      payload.tipo_servicio,
      payload.nombre_servicio,
      payload.perfil_cliente,
      payload.analisis_adaptabilidad,
      payload.acuerdos_comerciales,
      req.user.id
    ]);
    const delivery = inserted.rows[0];

    await insertServiceDetail(client, delivery.id, payload);
    await client.query(`
      INSERT INTO entregas_servicio_contactos
        (entrega_servicio_id, contacto_cliente_id, tipo_contacto)
      VALUES ($1, $2, 'INTERVENTOR')
    `, [delivery.id, contact.id]);

    for (const [index, consultant] of consultants.entries()) {
      await client.query(`
        INSERT INTO entregas_servicio_consultores
          (entrega_servicio_id, consultor_id, es_principal)
        VALUES ($1, $2, $3)
      `, [delivery.id, consultant.id, index === 0]);
    }
    for (const [index, consultant] of payload.consultores_externos.entries()) {
      await client.query(`
        INSERT INTO entregas_servicio_consultores
          (entrega_servicio_id, consultor_id, nombre_externo, telefono_externo, es_principal)
        VALUES ($1, NULL, $2, $3, $4)
      `, [delivery.id, consultant.nombre, consultant.telefono, consultants.length === 0 && index === 0]);
    }
    for (const module of modules) {
      await client.query(`
        INSERT INTO entregas_servicio_modulos (entrega_servicio_id, modulo_id)
        VALUES ($1, $2)
      `, [delivery.id, module.id]);
    }
    for (const moduleName of payload.modulos_otros) {
      await client.query(`
        INSERT INTO entregas_servicio_modulos (entrega_servicio_id, modulo_otro)
        VALUES ($1, $2)
      `, [delivery.id, moduleName]);
    }

    const linkRows = [];
    for (const link of payload.enlaces) {
      const result = await client.query(`
        INSERT INTO entregas_servicio_enlaces
          (entrega_servicio_id, titulo, url)
        VALUES ($1, $2, $3)
        RETURNING public_id::text AS id, titulo, url
      `, [delivery.id, link.titulo, link.url]);
      linkRows.push(result.rows[0]);
    }

    const bcc = await getAdminBcc(client, coordinator);
    const notification = await client.query(`
      INSERT INTO entregas_servicio_notificaciones
        (entrega_servicio_id, destinatarios, estado)
      VALUES ($1, $2::jsonb, 'PENDIENTE')
      RETURNING id
    `, [delivery.id, JSON.stringify({ to: [coordinator.email], bcc })]);
    await client.query("COMMIT");

    const notificationResult = await sendAssignmentNotification({
      delivery: {
        tipo_servicio: payload.tipo_servicio,
        nombre_servicio: payload.nombre_servicio,
        cliente,
        coordinador: coordinator,
        creador: { nombre_usuario: req.user.nombre_usuario || req.user.email || "Comercial" },
        asignador: { nombre_usuario: req.user.nombre_usuario || req.user.email || "Comercial" },
        consultores: [
          ...consultants,
          ...payload.consultores_externos.map((item) => ({
            nombre_usuario: item.nombre,
            telefono: item.telefono,
            tipo: "EXTERNO"
          }))
        ],
        modulos: modules,
        modulos_otros: payload.modulos_otros,
        enlaces: linkRows,
        bcc
      },
      notificationId: notification.rows[0].id,
      graphAccessToken: String(req.headers["x-graph-access-token"] || "").trim() || null
    });

    return res.status(201).json({
      id: delivery.public_id,
      estado: "REGISTRADA",
      cliente: { id: cliente.public_id, nombre: cliente.titulo },
      notificacion: notificationResult
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return handleError(res, error, "registrar la entrega de servicio");
  } finally {
    if (client) client.release();
  }
}

async function getNotificationContext(req, publicId) {
  const visibility = visibilitySql(req, "e", 2);
  const result = await pool.query(`
    SELECT
      e.id,
      e.tipo_servicio,
      e.nombre_servicio,
      c.titulo,
      coord.nombre_usuario AS coordinador_nombre,
      coord.email AS coordinador_email,
      rcoord.titulo AS coordinador_rol,
      creador.nombre_usuario AS creador_nombre,
      n.id AS notificacion_id,
      COALESCE((
        SELECT json_agg(json_build_object(
          'nombre_usuario', COALESCE(u.nombre_usuario, ec.nombre_externo),
          'email', u.email,
          'telefono', ec.telefono_externo,
          'tipo', CASE WHEN ec.consultor_id IS NULL THEN 'EXTERNO' ELSE 'USUARIO' END,
          'es_principal', ec.es_principal
        ) ORDER BY ec.es_principal DESC, COALESCE(u.nombre_usuario, ec.nombre_externo))
        FROM entregas_servicio_consultores ec LEFT JOIN usuarios u ON u.id = ec.consultor_id
        WHERE ec.entrega_servicio_id = e.id
      ), '[]'::json) AS consultores,
      COALESCE((
        SELECT json_agg(json_build_object('titulo', COALESCE(m.titulo, em.modulo_otro)))
        FROM entregas_servicio_modulos em LEFT JOIN modulo m ON m.id = em.modulo_id
        WHERE em.entrega_servicio_id = e.id
      ), '[]'::json) AS modulos,
      COALESCE((
        SELECT json_agg(json_build_object('titulo', d.titulo, 'url', d.url) ORDER BY d.created_at)
        FROM entregas_servicio_enlaces d WHERE d.entrega_servicio_id = e.id
      ), '[]'::json) AS enlaces
    FROM entregas_servicio e
    JOIN clientes c ON c.id = e.cliente_id
    JOIN usuarios coord ON coord.id = e.coordinador_asignado_id
    JOIN roles rcoord ON rcoord.id = coord.rol_usuario_id
    JOIN usuarios creador ON creador.id = e.creado_por
    JOIN LATERAL (
      SELECT id FROM entregas_servicio_notificaciones
      WHERE entrega_servicio_id = e.id AND tipo = 'ASIGNACION'
      ORDER BY created_at DESC LIMIT 1
    ) n ON true
    WHERE e.public_id::text = $1 ${visibility.clause}
  `, [publicId, ...visibility.params]);
  return result.rows[0] || null;
}

async function retryNotification(req, res) {
  try {
    const row = await getNotificationContext(req, String(req.params.id || ""));
    if (!row) return res.status(404).json({ error: "Entrega de servicio no encontrada." });
    const bccResult = normalizeRole(row.coordinador_rol) === "administrador"
      ? { rows: [] }
      : await pool.query(`
          SELECT DISTINCT LOWER(u.email) AS email
          FROM usuarios u JOIN roles r ON r.id = u.rol_usuario_id
          WHERE u.activo = true AND r.activo = true AND r.titulo = 'Administrador'
            AND LOWER(u.email) <> LOWER($1)
        `, [row.coordinador_email]);
    const result = await sendAssignmentNotification({
      delivery: {
        tipo_servicio: row.tipo_servicio,
        nombre_servicio: row.nombre_servicio,
        cliente: { titulo: row.titulo },
        coordinador: { nombre_usuario: row.coordinador_nombre, email: row.coordinador_email },
        creador: { nombre_usuario: row.creador_nombre },
        consultores: row.consultores || [],
        modulos: row.modulos || [],
        modulos_otros: [],
        enlaces: row.enlaces || [],
        bcc: bccResult.rows.map((item) => item.email)
      },
      notificationId: row.notificacion_id,
      graphAccessToken: String(req.headers["x-graph-access-token"] || "").trim() || null
    });
    return res.status(result.estado === "ENVIADA" ? 200 : 502).json(result);
  } catch (error) {
    return handleError(res, error, "reenviar la notificación");
  }
}

async function reassignDelivery(req, res) {
  let client;
  let transactionOpen = false;
  try {
    if (normalizeRole(req.user?.rol) !== "administrador") {
      return res.status(403).json({ error: "Solo un administrador puede reasignar la entrega." });
    }
    const assigneePublicId = String(req.body?.coordinador_id || "").trim();
    if (!assigneePublicId) {
      return res.status(422).json({ error: "Selecciona el nuevo responsable." });
    }

    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    const current = await client.query(`
      SELECT id, estado, coordinador_asignado_id
      FROM entregas_servicio
      WHERE public_id::text = $1
      FOR UPDATE
    `, [String(req.params.id || "")]);
    if (!current.rows[0]) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return res.status(404).json({ error: "Entrega de servicio no encontrada." });
    }
    if (current.rows[0].estado !== "REGISTRADA") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return res.status(422).json({ error: "Solo se pueden reasignar entregas pendientes de aceptación." });
    }

    const assignee = await resolveCoordinator(client, assigneePublicId);
    if (normalizeRole(assignee.rol) === "administrador" && Number(assignee.id) !== Number(req.user.id)) {
      throw new EntregaValidationError(
        "El administrador solo puede asignarse la entrega a sí mismo o enviarla a un coordinador.",
        "coordinador_id"
      );
    }
    if (Number(current.rows[0].coordinador_asignado_id) === Number(assignee.id)) {
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, responsable: assignee.nombre_usuario, sin_cambios: true });
    }

    await client.query(`
      UPDATE entregas_servicio
      SET coordinador_asignado_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [current.rows[0].id, assignee.id]);
    const bcc = await getAdminBcc(client, assignee);
    const notification = await client.query(`
      INSERT INTO entregas_servicio_notificaciones
        (entrega_servicio_id, destinatarios, estado)
      VALUES ($1, $2::jsonb, 'PENDIENTE')
      RETURNING id
    `, [current.rows[0].id, JSON.stringify({ to: [assignee.email], bcc })]);
    await client.query("COMMIT");
    transactionOpen = false;

    const row = await getNotificationContext(req, String(req.params.id || ""));
    const notificationResult = await sendAssignmentNotification({
      delivery: {
        tipo_servicio: row.tipo_servicio,
        nombre_servicio: row.nombre_servicio,
        cliente: { titulo: row.titulo },
        coordinador: { nombre_usuario: row.coordinador_nombre, email: row.coordinador_email },
        creador: { nombre_usuario: row.creador_nombre },
        asignador: { nombre_usuario: req.user.nombre_usuario || req.user.email || "Administrador" },
        consultores: row.consultores || [],
        modulos: row.modulos || [],
        modulos_otros: [],
        enlaces: row.enlaces || [],
        bcc
      },
      notificationId: notification.rows[0].id,
      graphAccessToken: String(req.headers["x-graph-access-token"] || "").trim() || null
    });
    return res.json({
      ok: true,
      responsable: assignee.nombre_usuario,
      coordinador_id: assignee.public_id,
      notificacion: notificationResult
    });
  } catch (error) {
    if (client && transactionOpen) await client.query("ROLLBACK").catch(() => {});
    return handleError(res, error, "reasignar la entrega de servicio");
  } finally {
    if (client) client.release();
  }
}

async function updateDeliveryStatus(req, res) {
  try {
    const role = normalizeRole(req.user?.rol);
    const nextStatus = String(req.body?.estado || "").trim().toUpperCase();
    if (!allowedReceptionStatuses(role).includes(nextStatus)) {
      return res.status(403).json({
        error: role === "coordinador"
          ? "El coordinador solo puede aceptar la entrega."
          : "Solo un administrador puede aceptar o devolver la entrega."
      });
    }
    const current = await pool.query(`
      SELECT id, estado FROM entregas_servicio
      WHERE public_id::text = $1 AND coordinador_asignado_id = $2
    `, [String(req.params.id || ""), req.user.id]);
    if (!current.rows[0]) {
      return res.status(404).json({ error: "La entrega no está asignada al usuario actual." });
    }
    if (!(STATUS_TRANSITIONS[current.rows[0].estado] || []).includes(nextStatus)) {
      return res.status(422).json({ error: `No se puede pasar de ${current.rows[0].estado} a ${nextStatus}.` });
    }
    const updated = await pool.query(`
      UPDATE entregas_servicio
      SET estado = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND estado = $3 AND coordinador_asignado_id = $4
      RETURNING id
    `, [current.rows[0].id, nextStatus, current.rows[0].estado, req.user.id]);
    if (!updated.rows[0]) {
      return res.status(409).json({ error: "La entrega cambió mientras realizabas la acción. Actualiza e intenta nuevamente." });
    }
    return res.json({ ok: true, estado: nextStatus });
  } catch (error) {
    return handleError(res, error, "actualizar el estado de la entrega");
  }
}

module.exports = {
  ALLOWED_ROLES,
  STATUS_TRANSITIONS,
  createDelivery,
  getCatalogs,
  getDelivery,
  listClientContacts,
  listDeliveries,
  reassignDelivery,
  retryNotification,
  updateDeliveryStatus,
  _private: { allowedReceptionStatuses, visibilitySql }
};
