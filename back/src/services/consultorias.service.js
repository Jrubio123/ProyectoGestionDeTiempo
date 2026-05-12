const { pool } = require("../db");

const normalizeValue = (value) => String(value || "").toLowerCase().trim();

function getIndexHelpers() {
  return require("../index");
}

// Obtener consultorías
// Admin ve todas (o filtra por coordinador_id opcional).
// Coordinador solo ve las suyas propias, sin importar qué venga en query params.
/**
 * Obtiene la lista de consultorías activas filtradas según el rol del usuario
 */
async function listConsultorias(req, res) {
  try {
    const role = normalizeValue(req.user?.rol);
    let filtroCoordId = null;

    if (["coordinador", "comercial"].includes(role)) {
      // Forzar siempre al ID del coordinador autenticado
      filtroCoordId = req.user?.id || null;
    } else {
      // Admin puede filtrar opcionalmente por coordinador_id (public_id recibido en query)
      const { coordinador_id } = req.query;
      if (coordinador_id) {
        const r = await pool.query(`SELECT id FROM usuarios WHERE public_id = $1`, [coordinador_id]);
        filtroCoordId = r.rows[0]?.id || null;
      }
    }

    const result = await pool.query(`
      SELECT
        c.public_id AS id,
        cli.public_id AS cliente_id,
        u.public_id AS coordinador_id,
        ta.public_id AS tipo_asignacion_id,
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
        AND ($1::int IS NULL OR c.coordinador_responsable_id = $1::int)
      ORDER BY c.id DESC
    `, [filtroCoordId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener consultorías" });
  }
}

// Crear consultoría (solo Administrador asigna clientes a coordinadores)
/**
 * Crea una nueva consultoría, asigna los responsables y envía una notificación por correo
 */
async function crearConsultoria(req, res) {
  const { cliente_id, coordinador_id, tipo_asignacion_id, descripcion_consultoria } = req.body;
  const { sendEmailSafe, buildPortalUrl, getGraphContext, buildEmailLayout } = getIndexHelpers();

  try {
    if (!cliente_id || !coordinador_id || !tipo_asignacion_id) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    // Resolución en dos pasos para evitar el problema de visibilidad de CTEs
    // en PostgreSQL: el JOIN posterior al INSERT no ve la fila recién insertada.
    const refsRes = await pool.query(
      `SELECT
         (SELECT id FROM clientes       WHERE public_id = $1) AS cliente_id,
         (SELECT id FROM usuarios       WHERE public_id = $2) AS coordinador_id,
         (SELECT id FROM tipo_asignacion WHERE public_id = $3) AS tipo_asignacion_id`,
      [cliente_id, coordinador_id, tipo_asignacion_id]
    );
    const refs = refsRes.rows[0];
    if (!refs.cliente_id || !refs.coordinador_id || !refs.tipo_asignacion_id) {
      return res.status(400).json({ error: "Cliente, coordinador o tipo de asignación no válido" });
    }

    const inserted = await pool.query(
      `INSERT INTO consultorias (id_cliente, coordinador_responsable_id, id_tipo_asignacion, descripcion_consultoria, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id`,
      [refs.cliente_id, refs.coordinador_id, refs.tipo_asignacion_id, descripcion_consultoria || null]
    );
    if (!inserted.rows[0]?.id) {
      return res.status(500).json({ error: "Error al guardar consultoría" });
    }

    const result = await pool.query(
      `SELECT
         c.public_id AS id,
         cli.public_id AS cliente_id,
         u.public_id   AS coordinador_id,
         ta.public_id  AS tipo_asignacion_id,
         c.descripcion_consultoria,
         c.activo,
         cli.titulo        AS nombre_cliente,
         u.nombre_usuario  AS nombre_coordinador,
         u.email           AS coordinador_email,
         ta.titulo         AS tipo_asignacion
       FROM consultorias c
       JOIN clientes cli ON cli.id = c.id_cliente
       LEFT JOIN usuarios u ON u.id = c.coordinador_responsable_id
       LEFT JOIN tipo_asignacion ta ON ta.id = c.id_tipo_asignacion
       WHERE c.id = $1`,
      [inserted.rows[0].id]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: "Cliente, coordinador o tipo de asignación no válido" });
    }

    const created = result.rows[0];

    // Email al coordinador asignado
    if (created.coordinador_email) {
      const portalUrl = buildPortalUrl("mis-asignaciones-coordinador");
      await sendEmailSafe({
        ...getGraphContext(req),
        to: created.coordinador_email,
        subject: `Nueva consultoría asignada - ${created.nombre_cliente}`,
        text:
          `Hola ${created.nombre_coordinador || ""},\n` +
          `Se creó una consultoría para el cliente ${created.nombre_cliente}.\n` +
          `Tipo de asignación: ${created.tipo_asignacion}.\n` +
          `Descripción: ${descripcion_consultoria || "Sin descripción"}.\n` +
          `Revisa en: ${portalUrl}\n`,
        html: buildEmailLayout({
          title: "Nueva consultoría asignada",
          intro: `Hola <strong>${created.nombre_coordinador || "Coordinador"}</strong>, se creó una consultoría para que inicies gestión operativa.`,
          blocks: [
            { label: "Cliente", value: created.nombre_cliente },
            { label: "Tipo de asignación", value: created.tipo_asignacion || "N/A" },
            { label: "Descripción", value: descripcion_consultoria || "Sin descripción" }
          ],
          ctaLabel: "Ver consultoría en el portal",
          ctaUrl: portalUrl
        })
      });
    }

    // Remover email the response options if not wanted by the frontend
    delete created.coordinador_email;
    res.json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar consultoría" });
  }
}

// Actualizar consultoría (solo Administrador)
/**
 * Modifica los datos principales de una consultoría existente en la base de datos
 */
async function actualizarConsultoria(req, res) {
  const { id } = req.params;
  const { cliente_id, coordinador_id, tipo_asignacion_id, descripcion_consultoria } = req.body;

  try {
    const result = await pool.query(
      `
      WITH 
        c_consultoria AS (SELECT id FROM consultorias WHERE public_id = $5),
        c_cliente AS (SELECT id FROM clientes WHERE public_id = $1),
        c_coordinador AS (SELECT id FROM usuarios WHERE public_id = $2),
        c_tipo_asignacion AS (SELECT id FROM tipo_asignacion WHERE public_id = $3),
        
        upd AS (
          UPDATE consultorias
          SET id_cliente = (SELECT id FROM c_cliente),
              coordinador_responsable_id = (SELECT id FROM c_coordinador),
              id_tipo_asignacion = (SELECT id FROM c_tipo_asignacion),
              descripcion_consultoria = $4
          WHERE id = (SELECT id FROM c_consultoria)
            AND EXISTS (SELECT 1 FROM c_cliente)
            AND EXISTS (SELECT 1 FROM c_coordinador)
            AND EXISTS (SELECT 1 FROM c_tipo_asignacion)
          RETURNING id
        )
      SELECT
        c.public_id AS id,
        cli.public_id AS cliente_id,
        u.public_id AS coordinador_id,
        ta.public_id AS tipo_asignacion_id,
        c.descripcion_consultoria,
        c.activo,
        cli.titulo AS nombre_cliente,
        u.nombre_usuario AS nombre_coordinador,
        ta.titulo AS tipo_asignacion
      FROM upd
      JOIN consultorias c ON c.id = upd.id
      JOIN clientes cli ON cli.id = c.id_cliente
      LEFT JOIN usuarios u ON u.id = c.coordinador_responsable_id
      LEFT JOIN tipo_asignacion ta ON ta.id = c.id_tipo_asignacion
      `,
      [
        cliente_id,
        coordinador_id,
        tipo_asignacion_id,
        descripcion_consultoria || null,
        id
      ]
    );

    if (result.rowCount === 0) {
      // Verificar manual (sin error crash)
      const checkC = await pool.query("SELECT id FROM consultorias WHERE public_id = $1", [id]);
      if (checkC.rowCount === 0) return res.status(404).json({ error: "Consultoría no encontrada" });

      return res.status(404).json({ error: "Cliente, coordinador o tipo de asignación no válido" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar consultoría" });
  }
}

// Eliminar consultoría (soft delete, solo Administrador)
/**
 * Realiza un borrado lógico para inactivar una consultoría en el sistema
 */
async function eliminarConsultoria(req, res) {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      WITH c_consultoria AS (SELECT id FROM consultorias WHERE public_id = $1)
      UPDATE consultorias 
      SET activo = false 
      WHERE id = (SELECT id FROM c_consultoria)
      RETURNING id
    `, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Consultoría no encontrada" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar consultoría" });
  }
}

module.exports = { listConsultorias, crearConsultoria, actualizarConsultoria, eliminarConsultoria };
