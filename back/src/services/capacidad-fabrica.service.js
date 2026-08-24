const { pool } = require("../db");
const { listRecentWorkItemsAllProjects } = require("./azure-devops.service");
const { syncMicrosoftIdentity } = require("./microsoft-identity-sync.service");
const {
  calculateActiveHours,
  getWeekRange,
  isCorporateSilverEmail,
  normalizeAzureEffort,
  normalizeStateCode,
  validateDistribution
} = require("./capacidad-fabrica.domain");

class CapacityError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "CapacityError";
    this.statusCode = statusCode;
  }
}

function cleanText(value, maxLength = null) {
  const text = String(value || "").trim();
  if (!text) return null;
  return maxLength ? text.slice(0, maxLength) : text;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validatePriority(value, required = false) {
  const priority = numberOrNull(value);
  if (priority === null && !required) return null;
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    throw new CapacityError("La prioridad debe ser 1, 2 o 3.");
  }
  return priority;
}

function normalizeDateInput(value, label) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new CapacityError(`La fecha de ${label} no es válida.`);
  }
  const parsed = new Date(`${normalized}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new CapacityError(`La fecha de ${label} no es válida.`);
  }
  return normalized;
}

function validateDates(startDate, endDate) {
  const normalizedStart = normalizeDateInput(startDate, "inicio");
  const normalizedEnd = normalizeDateInput(endDate, "fin");
  if (normalizedStart && normalizedEnd && normalizedStart > normalizedEnd) {
    throw new CapacityError("La fecha de fin no puede ser anterior a la fecha de inicio.");
  }
  return { startDate: normalizedStart, endDate: normalizedEnd };
}

function dateOnly(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getCategories(db = pool) {
  const result = await db.query(
    `SELECT id, public_id::text AS id_publico, codigo, nombre,
            porcentaje_predeterminado::float8 AS porcentaje_predeterminado, orden
     FROM categorias_esfuerzo_capacidad
     WHERE activo = TRUE
     ORDER BY orden, id`
  );
  return result.rows;
}

async function getStateByCode(db, value) {
  const code = normalizeStateCode(value);
  if (!code) throw new CapacityError("El estado del requerimiento no es válido.");
  const result = await db.query(
    `SELECT id, codigo, nombre, consume_capacidad, categoria_codigo,
            clasificacion, es_terminal, permite_reactivacion, orden
     FROM estados_requerimiento_capacidad
     WHERE codigo = $1 AND activo = TRUE`,
    [code]
  );
  if (!result.rows[0]) throw new CapacityError("El estado del requerimiento no existe.");
  return result.rows[0];
}

async function ensureDefaultDistribution(db, requirementId) {
  await db.query(
    `INSERT INTO requerimiento_distribucion_capacidad
       (requerimiento_id, categoria_id, porcentaje)
     SELECT $1, c.id, c.porcentaje_predeterminado
     FROM categorias_esfuerzo_capacidad c
     WHERE c.activo = TRUE
     ON CONFLICT (requerimiento_id, categoria_id) DO NOTHING`,
    [requirementId]
  );
}

async function loadSnapshot(db, requirementId) {
  const requirementResult = await db.query(
    `SELECT r.*, e.codigo AS estado_codigo, e.nombre AS estado_nombre,
            c.titulo AS cliente_manual,
            CONCAT_WS(' ', p.nombre, p.apellidos) AS persona_nombre,
            p.public_id::text AS persona_public_id
     FROM requerimientos_capacidad r
     JOIN estados_requerimiento_capacidad e ON e.id = r.estado_id
     LEFT JOIN clientes c ON c.id = r.cliente_id
     LEFT JOIN personas p ON p.id = r.persona_id
     WHERE r.id = $1`,
    [requirementId]
  );
  const requirement = requirementResult.rows[0];
  if (!requirement) throw new CapacityError("Requerimiento no encontrado.", 404);

  const distributionResult = await db.query(
    `SELECT c.codigo, d.porcentaje::float8 AS porcentaje
     FROM requerimiento_distribucion_capacidad d
     JOIN categorias_esfuerzo_capacidad c ON c.id = d.categoria_id
     WHERE d.requerimiento_id = $1
     ORDER BY c.orden, c.id`,
    [requirementId]
  );
  const percentages = Object.fromEntries(
    distributionResult.rows.map((item) => [item.codigo, Number(item.porcentaje)])
  );
  const data = {
    public_id: requirement.public_id,
    origen: requirement.origen,
    external_id: requirement.external_id,
    organizacion_azure: requirement.organizacion_azure,
    azure_project_name: requirement.azure_project_name,
    cliente: requirement.cliente_manual || requirement.cliente_nombre_origen,
    tipo: requirement.tipo,
    titulo: requirement.titulo,
    estado_codigo: requirement.estado_codigo,
    estado_nombre: requirement.estado_nombre,
    responsable_nombre: requirement.persona_nombre || requirement.responsable_nombre,
    responsable_correo: requirement.responsable_correo,
    responsable_azure_id: requirement.responsable_azure_id,
    azure_url: requirement.azure_url
  };

  return { requirement, percentages, data };
}

async function writeHistory(db, requirementId, event, actorId, preferredDate = null) {
  const snapshot = await loadSnapshot(db, requirementId);
  const openResult = await db.query(
    `SELECT id, valido_desde
     FROM requerimientos_capacidad_historial
     WHERE requerimiento_id = $1 AND valido_hasta IS NULL
     FOR UPDATE`,
    [requirementId]
  );
  const open = openResult.rows[0] || null;
  const now = new Date();
  let validFrom = preferredDate ? new Date(preferredDate) : now;
  if (Number.isNaN(validFrom.getTime()) || validFrom > now) validFrom = now;
  if (open) {
    const previousStart = new Date(open.valido_desde);
    if (validFrom <= previousStart) validFrom = now > previousStart
      ? now
      : new Date(previousStart.getTime() + 1);
    await db.query(
      `UPDATE requerimientos_capacidad_historial
       SET valido_hasta = $1
       WHERE id = $2`,
      [validFrom, open.id]
    );
  }

  const row = snapshot.requirement;
  await db.query(
    `INSERT INTO requerimientos_capacidad_historial (
       requerimiento_id, evento, estado_id, persona_id, effort_total,
       prioridad, fecha_inicio, fecha_fin, porcentajes_snapshot, datos_snapshot,
       valido_desde, source_changed_at, registrado_por
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13)`,
    [
      requirementId,
      event,
      row.estado_id,
      row.persona_id,
      row.effort_total,
      row.prioridad,
      row.fecha_inicio,
      row.fecha_fin,
      JSON.stringify(snapshot.percentages),
      JSON.stringify(snapshot.data),
      validFrom,
      row.source_changed_at,
      actorId || null
    ]
  );
}

async function setFactoryMembership(db, personPublicId, belongs, actorId) {
  const personResult = await db.query(
    `SELECT id, public_id::text AS id_publico, nombre, apellidos, correo_silver,
            azure_oid, estado, pertenece_fabrica
     FROM personas
     WHERE public_id = $1
     FOR UPDATE`,
    [personPublicId]
  );
  const person = personResult.rows[0];
  if (!person) throw new CapacityError("Persona no encontrada.", 404);

  const openResult = await db.query(
    `SELECT id, pertenece_fabrica
     FROM personas_fabrica_historial
     WHERE persona_id = $1 AND valido_hasta IS NULL
     FOR UPDATE`,
    [person.id]
  );
  const open = openResult.rows[0] || null;
  const desired = Boolean(belongs);

  if (!open || Boolean(open.pertenece_fabrica) !== desired) {
    if (open) {
      await db.query(
        `UPDATE personas_fabrica_historial
         SET valido_hasta = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [open.id]
      );
    }
    await db.query(
      `INSERT INTO personas_fabrica_historial
         (persona_id, pertenece_fabrica, registrado_por)
       VALUES ($1, $2, $3)`,
      [person.id, desired, actorId || null]
    );
  }

  const updated = await db.query(
    `UPDATE personas
     SET pertenece_fabrica = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING public_id::text AS id, nombre, apellidos, correo_silver,
               azure_oid, estado, pertenece_fabrica`,
    [desired, person.id]
  );
  return updated.rows[0];
}

async function getCatalogs(req, res) {
  try {
    const [categories, states, config, clients] = await Promise.all([
      getCategories(),
      pool.query(
        `SELECT public_id::text AS id, codigo, nombre, consume_capacidad,
                categoria_codigo, clasificacion, es_terminal,
                permite_reactivacion, orden
         FROM estados_requerimiento_capacidad
         WHERE activo = TRUE ORDER BY orden, id`
      ),
      pool.query(
        `SELECT horas_semanales::float8 AS horas_semanales, updated_at
         FROM configuracion_capacidad_fabrica WHERE id = 1`
      ),
      pool.query(
        `SELECT public_id::text AS id, titulo
         FROM clientes WHERE activo = TRUE ORDER BY titulo`
      )
    ]);
    return res.json({
      categorias: categories,
      estados: states.rows,
      configuracion: config.rows[0] || { horas_semanales: 42 },
      clientes: clients.rows
    });
  } catch (error) {
    return handleError(res, error, "Error consultando la configuración de capacidad");
  }
}

async function listPeople(req, res) {
  try {
    const search = cleanText(req.query?.q, 120);
    const onlyFactory = String(req.query?.solo_fabrica || "").toLowerCase() === "true";
    const result = await pool.query(
      `SELECT p.public_id::text AS id, p.nombre, p.apellidos, p.correo_silver,
              p.azure_oid, p.estado, p.tipo_contrato,
              p.pertenece_fabrica,
              u.public_id::text AS usuario_id, u.activo AS usuario_activo
       FROM personas p
       LEFT JOIN usuarios u ON u.persona_id = p.id
       WHERE p.estado = 'activo'
         AND ($1::boolean = FALSE OR p.pertenece_fabrica = TRUE)
         AND (
           $2::text IS NULL
           OR CONCAT_WS(' ', p.nombre, p.apellidos) ILIKE '%' || $2 || '%'
           OR p.correo_silver ILIKE '%' || $2 || '%'
         )
       ORDER BY p.pertenece_fabrica DESC, p.nombre, p.apellidos
       LIMIT 100`,
      [onlyFactory, search]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, "Error consultando personas");
  }
}

async function materializeMicrosoftPerson(req, res) {
  try {
    const identity = req.body || {};
    if (!isCorporateSilverEmail(identity.email)) {
      throw new CapacityError(
        "El integrante de Fábrica debe usar un correo @silverconsulting.com.co."
      );
    }
    const result = await withTransaction(async (client) => {
      const synced = await syncMicrosoftIdentity(client, {
        oid: identity.azure_oid,
        email: identity.email,
        displayName: identity.nombre_usuario,
        givenName: identity.nombre,
        surname: identity.apellidos,
        phone: identity.telefono,
        createUser: false,
        recordLogin: false,
        requireActiveUser: false
      });
      const personResult = await client.query(
        `SELECT public_id::text AS id
         FROM personas WHERE id = $1`,
        [synced.persona_id]
      );
      return setFactoryMembership(
        client,
        personResult.rows[0].id,
        true,
        req.user?.id
      );
    });
    return res.status(201).json(result);
  } catch (error) {
    return handleError(res, error, "Error vinculando la persona de Microsoft 365");
  }
}

async function updateFactoryMembership(req, res) {
  try {
    if (typeof req.body?.pertenece_fabrica !== "boolean") {
      throw new CapacityError("Debe indicar si la persona pertenece a Fábrica.");
    }
    const result = await withTransaction((client) =>
      setFactoryMembership(
        client,
        req.params.id,
        req.body.pertenece_fabrica,
        req.user?.id
      )
    );
    return res.json(result);
  } catch (error) {
    return handleError(res, error, "Error actualizando la pertenencia a Fábrica");
  }
}

async function listRequirements(req, res) {
  try {
    const includeFinished = String(req.query?.incluir_finalizados || "").toLowerCase() === "true";
    const result = await pool.query(
      `SELECT r.public_id::text AS id, r.origen, r.external_id,
              r.organizacion_azure, r.azure_project_name,
              COALESCE(c.titulo, r.cliente_nombre_origen) AS cliente,
              c.public_id::text AS cliente_id, r.tipo, r.titulo,
              e.codigo AS estado_codigo, e.nombre AS estado,
              e.consume_capacidad, e.categoria_codigo, e.clasificacion,
              e.es_terminal, r.estado_origen,
              r.effort_total::float8 AS effort_total, r.prioridad,
              p.public_id::text AS persona_id,
              COALESCE(CONCAT_WS(' ', p.nombre, p.apellidos), r.responsable_nombre) AS responsable,
              r.responsable_correo, r.fecha_inicio, r.fecha_fin, r.azure_url,
              r.source_changed_at, r.last_synced_at, r.updated_at,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'codigo', cat.codigo,
                    'nombre', cat.nombre,
                    'porcentaje', d.porcentaje::float8,
                    'orden', cat.orden
                  ) ORDER BY cat.orden
                ) FILTER (WHERE d.id IS NOT NULL),
                '[]'::jsonb
              ) AS distribucion
       FROM requerimientos_capacidad r
       JOIN estados_requerimiento_capacidad e ON e.id = r.estado_id
       LEFT JOIN clientes c ON c.id = r.cliente_id
       LEFT JOIN personas p ON p.id = r.persona_id
       LEFT JOIN requerimiento_distribucion_capacidad d ON d.requerimiento_id = r.id
       LEFT JOIN categorias_esfuerzo_capacidad cat ON cat.id = d.categoria_id
       WHERE r.activo = TRUE
         AND (
           r.origen = 'MANUAL'
           OR (r.origen = 'AZURE_DEVOPS' AND p.pertenece_fabrica = TRUE)
         )
         AND ($1::boolean = TRUE OR e.es_terminal = FALSE)
       GROUP BY r.id, c.id, e.id, p.id
       ORDER BY e.es_terminal, r.prioridad NULLS LAST, r.updated_at DESC`,
      [includeFinished]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, "Error consultando requerimientos");
  }
}

async function resolveManualRelations(db, clientPublicId, personPublicId) {
  const [clientResult, personResult] = await Promise.all([
    db.query(
      `SELECT id, titulo FROM clientes
       WHERE public_id = $1 AND activo = TRUE`,
      [clientPublicId]
    ),
    db.query(
      `SELECT id, CONCAT_WS(' ', nombre, apellidos) AS nombre, correo_silver, azure_oid
       FROM personas
       WHERE public_id = $1 AND estado = 'activo' AND pertenece_fabrica = TRUE`,
      [personPublicId]
    )
  ]);
  if (!clientResult.rows[0]) throw new CapacityError("El cliente no existe o está inactivo.");
  if (!personResult.rows[0]) throw new CapacityError("El responsable debe pertenecer a Fábrica.");
  return { client: clientResult.rows[0], person: personResult.rows[0] };
}

function validateEffort(value) {
  const effort = Number(value);
  if (!Number.isFinite(effort) || effort < 0) {
    throw new CapacityError("El esfuerzo total debe ser un número mayor o igual a cero.");
  }
  return effort;
}

async function createManualRequirement(req, res) {
  try {
    const payload = req.body || {};
    const result = await withTransaction(async (client) => {
      const title = cleanText(payload.titulo);
      const type = cleanText(payload.tipo, 120);
      if (!title || !type) throw new CapacityError("El tipo y el título son obligatorios.");
      const state = await getStateByCode(client, payload.estado_codigo);
      const relations = await resolveManualRelations(
        client,
        payload.cliente_id,
        payload.persona_id
      );
      const effort = validateEffort(payload.effort_total);
      const priority = validatePriority(payload.prioridad, true);
      const dates = validateDates(payload.fecha_inicio, payload.fecha_fin);
      const insert = await client.query(
        `INSERT INTO requerimientos_capacidad (
           origen, cliente_id, cliente_nombre_origen, tipo, titulo, estado_id,
           estado_origen, effort_total, prioridad, persona_id,
           responsable_azure_id, responsable_correo, responsable_nombre,
           fecha_inicio, fecha_fin, created_by, modified_by
         ) VALUES (
           'MANUAL', $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $15
         ) RETURNING id, public_id::text AS id_publico`,
        [
          relations.client.id,
          relations.client.titulo,
          type,
          title,
          state.id,
          state.nombre,
          effort,
          priority,
          relations.person.id,
          relations.person.azure_oid,
          relations.person.correo_silver,
          relations.person.nombre,
          dates.startDate,
          dates.endDate,
          req.user?.id || null
        ]
      );
      await ensureDefaultDistribution(client, insert.rows[0].id);
      if (Array.isArray(payload.distribucion)) {
        await saveDistribution(client, insert.rows[0].id, payload.distribucion);
      }
      await writeHistory(client, insert.rows[0].id, "CREADO", req.user?.id);
      return insert.rows[0];
    });
    return res.status(201).json({ id: result.id_publico });
  } catch (error) {
    return handleError(res, error, "Error creando el requerimiento manual");
  }
}

async function updateManualRequirement(req, res) {
  try {
    const payload = req.body || {};
    const result = await withTransaction(async (client) => {
      const currentResult = await client.query(
        `SELECT r.*, e.codigo AS estado_codigo_actual, e.es_terminal
         FROM requerimientos_capacidad r
         JOIN estados_requerimiento_capacidad e ON e.id = r.estado_id
         WHERE r.public_id = $1 FOR UPDATE OF r`,
        [req.params.id]
      );
      const current = currentResult.rows[0];
      if (!current) throw new CapacityError("Requerimiento no encontrado.", 404);
      if (current.origen !== "MANUAL") {
        throw new CapacityError("Los datos de Azure DevOps se actualizan desde Azure.", 409);
      }

      const state = payload.estado_codigo
        ? await getStateByCode(client, payload.estado_codigo)
        : { id: current.estado_id, nombre: current.estado_origen };
      if (current.es_terminal && state.id !== current.estado_id) {
        throw new CapacityError("Un requerimiento cerrado o removido no se puede reactivar.", 409);
      }
      let clientId = current.cliente_id;
      let clientName = current.cliente_nombre_origen;
      let personId = current.persona_id;
      let person = null;
      if (payload.cliente_id || payload.persona_id) {
        const currentRelations = await client.query(
          `SELECT c.public_id::text AS cliente_public_id,
                  p.public_id::text AS persona_public_id
           FROM requerimientos_capacidad r
           LEFT JOIN clientes c ON c.id = r.cliente_id
           LEFT JOIN personas p ON p.id = r.persona_id
           WHERE r.id = $1`,
          [current.id]
        );
        const relations = await resolveManualRelations(
          client,
          payload.cliente_id || currentRelations.rows[0].cliente_public_id,
          payload.persona_id || currentRelations.rows[0].persona_public_id
        );
        clientId = relations.client.id;
        clientName = relations.client.titulo;
        personId = relations.person.id;
        person = relations.person;
      }

      const nextEffort = payload.effort_total === undefined
        ? Number(current.effort_total)
        : validateEffort(payload.effort_total);
      const nextType = payload.tipo === undefined ? current.tipo : cleanText(payload.tipo, 120);
      const nextTitle = payload.titulo === undefined ? current.titulo : cleanText(payload.titulo);
      if (!nextType || !nextTitle) throw new CapacityError("El tipo y el título son obligatorios.");
      const nextPriority = payload.prioridad === undefined
        ? current.prioridad
        : validatePriority(payload.prioridad, true);
      const rawStartDate = payload.fecha_inicio === undefined
        ? current.fecha_inicio
        : (payload.fecha_inicio || null);
      const rawEndDate = payload.fecha_fin === undefined
        ? current.fecha_fin
        : (payload.fecha_fin || null);
      const dates = validateDates(rawStartDate, rawEndDate);
      const update = await client.query(
        `UPDATE requerimientos_capacidad
         SET cliente_id = $1, cliente_nombre_origen = $2,
             tipo = $3, titulo = $4, estado_id = $5, estado_origen = $6,
             effort_total = $7, prioridad = $8, persona_id = $9,
             responsable_azure_id = COALESCE($10, responsable_azure_id),
             responsable_correo = COALESCE($11, responsable_correo),
             responsable_nombre = COALESCE($12, responsable_nombre),
             fecha_inicio = $13, fecha_fin = $14,
             modified_by = $15, updated_at = CURRENT_TIMESTAMP
         WHERE id = $16
         RETURNING public_id::text AS id_publico`,
        [
          clientId,
          clientName,
          nextType,
          nextTitle,
          state.id,
          state.nombre,
          nextEffort,
          nextPriority,
          personId,
          person?.azure_oid || null,
          person?.correo_silver || null,
          person?.nombre || null,
          dates.startDate,
          dates.endDate,
          req.user?.id || null,
          current.id
        ]
      );
      if (Array.isArray(payload.distribucion)) {
        await saveDistribution(client, current.id, payload.distribucion);
      }
      const event = state.id !== current.estado_id
        ? "ESTADO"
        : (personId !== current.persona_id ? "ASIGNACION" : "PLANIFICACION");
      await writeHistory(client, current.id, event, req.user?.id);
      return update.rows[0];
    });
    return res.json({ id: result.id_publico });
  } catch (error) {
    return handleError(res, error, "Error actualizando el requerimiento manual");
  }
}

async function saveDistribution(db, requirementId, distribution) {
  const categories = await getCategories(db);
  const values = validateDistribution(distribution, categories.map((item) => item.codigo));
  for (const category of categories) {
    await db.query(
      `INSERT INTO requerimiento_distribucion_capacidad
         (requerimiento_id, categoria_id, porcentaje)
       VALUES ($1, $2, $3)
       ON CONFLICT (requerimiento_id, categoria_id)
       DO UPDATE SET porcentaje = EXCLUDED.porcentaje, updated_at = CURRENT_TIMESTAMP`,
      [requirementId, category.id, values.get(category.codigo)]
    );
  }
}

async function updateRequirementDistribution(req, res) {
  try {
    await withTransaction(async (client) => {
      const requirement = await client.query(
        `SELECT id FROM requerimientos_capacidad
         WHERE public_id = $1 AND activo = TRUE FOR UPDATE`,
        [req.params.id]
      );
      if (!requirement.rows[0]) throw new CapacityError("Requerimiento no encontrado.", 404);
      await saveDistribution(client, requirement.rows[0].id, req.body?.distribucion);
      await client.query(
        `UPDATE requerimientos_capacidad
         SET modified_by = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [req.user?.id || null, requirement.rows[0].id]
      );
      await writeHistory(
        client,
        requirement.rows[0].id,
        "PLANIFICACION",
        req.user?.id
      );
    });
    return res.json({ ok: true });
  } catch (error) {
    return handleError(res, error, "Error guardando la distribución del esfuerzo");
  }
}

async function syncAzureRequirements(req, res) {
  try {
    const azureData = await listRecentWorkItemsAllProjects();
    const result = await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('capacidad-fabrica-azure-sync'))");
      const [statesResult, peopleResult] = await Promise.all([
        client.query("SELECT id, codigo, nombre FROM estados_requerimiento_capacidad WHERE activo = TRUE"),
        client.query(
          `SELECT p.id, p.azure_oid, LOWER(BTRIM(p.correo_silver)) AS correo_silver,
                  u.azure_oid AS usuario_azure_oid, LOWER(BTRIM(u.email)) AS usuario_email
           FROM personas p
           LEFT JOIN usuarios u ON u.persona_id = p.id
           WHERE p.estado = 'activo'`
        )
      ]);
      const stateByCode = new Map(statesResult.rows.map((item) => [item.codigo, item]));
      const personByIdentity = new Map();
      for (const person of peopleResult.rows) {
        for (const key of [
          person.azure_oid,
          person.correo_silver,
          person.usuario_azure_oid,
          person.usuario_email
        ].filter(Boolean)) {
          personByIdentity.set(String(key).toLowerCase(), person.id);
        }
      }

      const summary = {
        recibidos: azureData.workItems.length,
        creados: 0,
        actualizados: 0,
        sin_cambios: 0,
        effort_pendiente: 0,
        omitidos_effort_invalido: 0,
        omitidos_estado: 0,
        estados_no_mapeados: {}
      };

      for (const item of azureData.workItems) {
        const stateCode = normalizeStateCode(item.state);
        const state = stateByCode.get(stateCode);
        if (!state) {
          summary.omitidos_estado += 1;
          const label = cleanText(item.state) || "Sin estado";
          summary.estados_no_mapeados[label] = (summary.estados_no_mapeados[label] || 0) + 1;
          continue;
        }
        const effortInfo = normalizeAzureEffort(item.effort);
        if (!effortInfo.valid) {
          summary.omitidos_effort_invalido += 1;
          continue;
        }
        const effort = effortInfo.effort;
        if (effortInfo.pending) summary.effort_pendiente += 1;

        const identityCandidates = [item.assignedToId, item.assignedToEmail]
          .filter(Boolean)
          .map((value) => String(value).trim().toLowerCase());
        const personId = identityCandidates
          .map((identity) => personByIdentity.get(identity))
          .find(Boolean) || null;
        const rawPriority = numberOrNull(item.priority);
        const priority = Number.isInteger(rawPriority) && rawPriority >= 1 && rawPriority <= 3
          ? rawPriority
          : null;
        const upsert = await client.query(
          `INSERT INTO requerimientos_capacidad (
             origen, external_id, organizacion_azure, azure_project_name,
             cliente_nombre_origen, tipo, titulo, estado_id, estado_origen,
             effort_total, prioridad, persona_id, responsable_azure_id,
             responsable_correo, responsable_nombre, fecha_inicio, fecha_fin,
             azure_url, source_created_at, source_changed_at, last_synced_at,
             created_by, modified_by
           ) VALUES (
             'AZURE_DEVOPS', $1, $2, $3, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
             CURRENT_TIMESTAMP, $19, $19
           )
           ON CONFLICT (origen, organizacion_azure, external_id)
           DO UPDATE SET
             azure_project_name = EXCLUDED.azure_project_name,
             cliente_nombre_origen = EXCLUDED.cliente_nombre_origen,
             tipo = EXCLUDED.tipo,
             titulo = EXCLUDED.titulo,
             estado_id = EXCLUDED.estado_id,
             estado_origen = EXCLUDED.estado_origen,
             effort_total = EXCLUDED.effort_total,
             prioridad = EXCLUDED.prioridad,
             persona_id = EXCLUDED.persona_id,
             responsable_azure_id = EXCLUDED.responsable_azure_id,
             responsable_correo = EXCLUDED.responsable_correo,
             responsable_nombre = EXCLUDED.responsable_nombre,
             fecha_inicio = EXCLUDED.fecha_inicio,
             fecha_fin = EXCLUDED.fecha_fin,
             azure_url = EXCLUDED.azure_url,
             source_created_at = EXCLUDED.source_created_at,
             source_changed_at = EXCLUDED.source_changed_at,
             last_synced_at = CURRENT_TIMESTAMP,
             modified_by = EXCLUDED.modified_by,
             updated_at = CURRENT_TIMESTAMP
           WHERE (
             requerimientos_capacidad.azure_project_name,
             requerimientos_capacidad.tipo,
             requerimientos_capacidad.titulo,
             requerimientos_capacidad.estado_id,
             requerimientos_capacidad.effort_total,
             requerimientos_capacidad.prioridad,
             requerimientos_capacidad.persona_id,
             requerimientos_capacidad.responsable_azure_id,
             requerimientos_capacidad.responsable_correo,
             requerimientos_capacidad.responsable_nombre,
             requerimientos_capacidad.fecha_inicio,
             requerimientos_capacidad.fecha_fin,
             requerimientos_capacidad.source_changed_at
           ) IS DISTINCT FROM (
             EXCLUDED.azure_project_name,
             EXCLUDED.tipo,
             EXCLUDED.titulo,
             EXCLUDED.estado_id,
             EXCLUDED.effort_total,
             EXCLUDED.prioridad,
             EXCLUDED.persona_id,
             EXCLUDED.responsable_azure_id,
             EXCLUDED.responsable_correo,
             EXCLUDED.responsable_nombre,
             EXCLUDED.fecha_inicio,
             EXCLUDED.fecha_fin,
             EXCLUDED.source_changed_at
           )
           RETURNING id, (xmax = 0) AS insertado`,
          [
            item.id,
            azureData.organization,
            cleanText(item.project, 255) || "Sin proyecto",
            cleanText(item.type, 120) || "Requerimiento",
            cleanText(item.title) || `Work item ${item.id}`,
            state.id,
            cleanText(item.state, 120),
            effort,
            priority,
            personId,
            cleanText(item.assignedToId, 128),
            normalizeEmail(item.assignedToEmail) || null,
            cleanText(item.assignedTo, 255),
            dateOnly(item.startDate),
            dateOnly(item.targetDate),
            cleanText(item.url),
            item.createdDate || null,
            item.changedDate || null,
            req.user?.id || null
          ]
        );
        const changed = upsert.rows[0];
        if (!changed) {
          summary.sin_cambios += 1;
          continue;
        }
        await ensureDefaultDistribution(client, changed.id);
        await writeHistory(
          client,
          changed.id,
          changed.insertado ? "CREADO" : "SINCRONIZADO",
          req.user?.id,
          item.changedDate
        );
        if (changed.insertado) summary.creados += 1;
        else summary.actualizados += 1;
      }
      return summary;
    });
    return res.json({
      organizacion: azureData.organization,
      proyectos: azureData.projectCount,
      ...result
    });
  } catch (error) {
    return handleError(res, error, "Error sincronizando Azure DevOps");
  }
}

async function getDashboard(req, res) {
  try {
    let week;
    try {
      week = getWeekRange(req.query?.fecha);
    } catch (error) {
      throw new CapacityError(error.message);
    }
    const configResult = await pool.query(
      `SELECT horas_semanales::float8 AS horas_semanales
       FROM configuracion_capacidad_fabrica WHERE id = 1`
    );
    const weeklyHours = Number(configResult.rows[0]?.horas_semanales || 42);
    const membersResult = await pool.query(
      `SELECT DISTINCT ON (p.id)
              p.id, p.public_id::text AS persona_id,
              CONCAT_WS(' ', p.nombre, p.apellidos) AS persona,
              p.correo_silver
       FROM personas p
       JOIN personas_fabrica_historial h ON h.persona_id = p.id
       WHERE h.pertenece_fabrica = TRUE
         AND h.valido_desde <= $1
         AND (h.valido_hasta IS NULL OR h.valido_hasta > $1)
       ORDER BY p.id, h.valido_desde DESC`,
      [week.cutoff]
    );
    const versionsResult = await pool.query(
      `SELECT h.requerimiento_id, h.persona_id, h.effort_total::float8 AS effort_total,
              h.prioridad, h.fecha_inicio, h.fecha_fin, h.porcentajes_snapshot,
              h.datos_snapshot, e.codigo AS estado_codigo, e.nombre AS estado,
              e.consume_capacidad, e.categoria_codigo
       FROM requerimientos_capacidad_historial h
       JOIN estados_requerimiento_capacidad e ON e.id = h.estado_id
       WHERE h.valido_desde <= $1
         AND (h.valido_hasta IS NULL OR h.valido_hasta > $1)`,
      [week.cutoff]
    );

    const assignmentsByPerson = new Map();
    for (const version of versionsResult.rows) {
      if (!version.persona_id || !version.consume_capacidad) continue;
      const percentage = Number(
        version.porcentajes_snapshot?.[version.categoria_codigo] || 0
      );
      const hasEffort = version.effort_total !== null && version.effort_total !== undefined;
      const hours = hasEffort
        ? calculateActiveHours(version.effort_total, percentage)
        : 0;
      const detail = {
        requerimiento_id: version.requerimiento_id,
        titulo: version.datos_snapshot?.titulo || "",
        cliente: version.datos_snapshot?.cliente || "",
        origen: version.datos_snapshot?.origen || "",
        estado: version.estado,
        estado_codigo: version.estado_codigo,
        categoria: version.categoria_codigo,
        effort_total: hasEffort ? Number(version.effort_total) : null,
        effort_pendiente: !hasEffort,
        porcentaje_fase: percentage,
        horas_activas: hours,
        prioridad: version.prioridad,
        fecha_fin: version.fecha_fin
      };
      if (!assignmentsByPerson.has(version.persona_id)) {
        assignmentsByPerson.set(version.persona_id, []);
      }
      assignmentsByPerson.get(version.persona_id).push(detail);
    }

    const people = membersResult.rows.map((person) => {
      const assignments = assignmentsByPerson.get(person.id) || [];
      const used = Math.round(
        assignments.reduce((sum, item) => sum + item.horas_activas, 0) * 100
      ) / 100;
      const pendingEffort = assignments.filter((item) => item.effort_pendiente).length;
      return {
        persona_id: person.persona_id,
        persona: person.persona,
        correo_silver: person.correo_silver,
        horas_capacidad: weeklyHours,
        horas_ocupadas: used,
        horas_disponibles: Math.round((weeklyHours - used) * 100) / 100,
        porcentaje_ocupacion: Math.round((used / weeklyHours) * 10000) / 100,
        requerimientos_activos: assignments.length,
        requerimientos_sin_effort: pendingEffort,
        asignaciones: assignments.sort((left, right) =>
          (left.prioridad || 99) - (right.prioridad || 99)
        )
      };
    });
    const totalCapacity = weeklyHours * people.length;
    const totalUsed = Math.round(
      people.reduce((sum, person) => sum + person.horas_ocupadas, 0) * 100
    ) / 100;
    const totalPendingEffort = people.reduce(
      (sum, person) => sum + person.requerimientos_sin_effort,
      0
    );
    return res.json({
      semana: {
        fecha_inicio: week.startDate,
        fecha_fin: week.endDate,
        corte: week.cutoffIso,
        actual: week.isCurrent
      },
      resumen: {
        personas: people.length,
        horas_capacidad: totalCapacity,
        horas_ocupadas: totalUsed,
        horas_disponibles: Math.round((totalCapacity - totalUsed) * 100) / 100,
        requerimientos_sin_effort: totalPendingEffort,
        porcentaje_ocupacion: totalCapacity
          ? Math.round((totalUsed / totalCapacity) * 10000) / 100
          : 0
      },
      personas: people.sort((left, right) => right.porcentaje_ocupacion - left.porcentaje_ocupacion)
    });
  } catch (error) {
    return handleError(res, error, "Error calculando la capacidad semanal");
  }
}

async function getRequirementHistory(req, res) {
  try {
    const result = await pool.query(
      `SELECT h.id, h.evento, e.codigo AS estado_codigo, e.nombre AS estado,
              h.effort_total::float8 AS effort_total, h.prioridad,
              h.fecha_inicio, h.fecha_fin, h.porcentajes_snapshot,
              h.datos_snapshot, h.valido_desde, h.valido_hasta,
              h.source_changed_at, h.registrado_at,
              u.nombre_usuario AS registrado_por
       FROM requerimientos_capacidad_historial h
       JOIN requerimientos_capacidad r ON r.id = h.requerimiento_id
       JOIN estados_requerimiento_capacidad e ON e.id = h.estado_id
       LEFT JOIN usuarios u ON u.id = h.registrado_por
       WHERE r.public_id = $1
       ORDER BY h.valido_desde DESC, h.id DESC`,
      [req.params.id]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, "Error consultando el historial del requerimiento");
  }
}

function handleError(res, error, fallback) {
  const status = error.statusCode || (error.code === "23505" ? 409 : 500);
  if (status >= 500) console.error(fallback, error);
  return res.status(status).json({ error: error.message || fallback });
}

module.exports = {
  CapacityError,
  createManualRequirement,
  getCatalogs,
  getDashboard,
  getRequirementHistory,
  listPeople,
  listRequirements,
  materializeMicrosoftPerson,
  syncAzureRequirements,
  updateFactoryMembership,
  updateManualRequirement,
  updateRequirementDistribution
};
