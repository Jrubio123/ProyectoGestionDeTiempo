const { pool } = require("../db");

const normalizeValue = (value) => String(value || "").toLowerCase().trim();

async function listConsultores(req, res) {
  try {
    const result = await pool.query(`
      SELECT 
        u.public_id AS id,
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
}

async function listConsultoresPrincipales(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        u.public_id AS id,
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
}

async function listSubConsultoresPorPrincipal(req, res) {
  const { principalId } = req.params;
  try {
    if (!principalId) return res.json([]);
    const result = await pool.query(
      `
      WITH c_principal AS (SELECT id FROM usuarios WHERE public_id = $1)
      SELECT
        u.public_id AS id,
        u.nombre_usuario,
        u.email
      FROM usuarios u
      WHERE u.activo = true
        AND u.id_consultor_principal = (SELECT id FROM c_principal)
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
}

async function listSubConsultoresDisponibles(req, res) {
  const { principalId } = req.params;
  try {
    if (!principalId) return res.json([]);
    const result = await pool.query(
      `
      WITH c_principal AS (SELECT id FROM usuarios WHERE public_id = $1)
      SELECT
        u.public_id AS id,
        u.nombre_usuario,
        u.email
      FROM usuarios u
      LEFT JOIN roles r ON u.rol_usuario_id = r.id
      WHERE u.activo = true
        AND u.id <> (SELECT id FROM c_principal)
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
}

async function asociarSubConsultor(req, res) {
  const { principal_id, asociado_id } = req.body;
  try {
    if (!principal_id || !asociado_id) {
      return res.status(400).json({ error: "Faltan datos para asociar" });
    }

    const result = await pool.query(
      `
      WITH 
        c_principal AS (
          SELECT id, tipo_consultor 
          FROM usuarios 
          WHERE public_id = $1 AND activo = true
        ),
        c_asociado AS (
          SELECT id, id_consultor_principal 
          FROM usuarios 
          WHERE public_id = $2 AND activo = true
        )
      UPDATE usuarios
      SET id_consultor_principal = (SELECT id FROM c_principal),
          tipo_consultor = 'Asociado',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM c_asociado)
        AND EXISTS (SELECT 1 FROM c_principal WHERE LOWER(tipo_consultor::text) IS NULL OR LOWER(tipo_consultor::text) <> 'asociado')
        AND (SELECT id_consultor_principal FROM c_asociado) IS NULL
      RETURNING id
      `,
      [principal_id, asociado_id]
    );

    if (result.rowCount === 0) {
      // Analizar por qué falló
      const checkP = await pool.query("SELECT id, tipo_consultor FROM usuarios WHERE public_id = $1 AND activo = true", [principal_id]);
      if (checkP.rowCount === 0) return res.status(404).json({ error: "Consultor principal no encontrado" });
      if (normalizeValue(checkP.rows[0].tipo_consultor) === "asociado") return res.status(400).json({ error: "Un consultor asociado no puede tener asociados" });

      const checkA = await pool.query("SELECT id, id_consultor_principal FROM usuarios WHERE public_id = $1 AND activo = true", [asociado_id]);
      if (checkA.rowCount === 0) return res.status(404).json({ error: "Consultor asociado no encontrado" });
      if (String(checkA.rows[0].id_consultor_principal || "") !== "") return res.status(400).json({ error: "El consultor ya está asociado a otro principal" });

      return res.status(500).json({ error: "Error lógico desconocido" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al asociar consultor" });
  }
}

async function desvincularSubConsultor(req, res) {
  const { asociadoId } = req.params;
  const { principal_id } = req.body || {};
  try {
    if (!asociadoId || !principal_id) {
      return res.status(400).json({ error: "Faltan datos para desvincular" });
    }

    const result = await pool.query(
      `
      WITH 
        c_principal AS (SELECT id FROM usuarios WHERE public_id = $2),
        c_asociado AS (SELECT id, id_consultor_principal FROM usuarios WHERE public_id = $1 AND activo = true)
      UPDATE usuarios
      SET id_consultor_principal = NULL,
          tipo_consultor = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM c_asociado)
        AND id_consultor_principal = (SELECT id FROM c_principal)
      RETURNING id
      `,
      [asociadoId, principal_id]
    );

    if (result.rowCount === 0) {
      const checkP = await pool.query("SELECT id FROM usuarios WHERE public_id = $1", [principal_id]);
      const checkA = await pool.query("SELECT id, id_consultor_principal FROM usuarios WHERE public_id = $1 AND activo = true", [asociadoId]);

      if (checkA.rowCount === 0) return res.status(404).json({ error: "Consultor asociado no encontrado" });
      if (checkP.rowCount > 0 && String(checkA.rows[0].id_consultor_principal || "") !== String(checkP.rows[0].id)) {
        return res.status(403).json({ error: "No autorizado para desvincular" });
      }
      return res.status(404).json({ error: "Principal o Asociado no válido" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al desvincular consultor" });
  }
}

module.exports = {
  listConsultores,
  listConsultoresPrincipales,
  listSubConsultoresPorPrincipal,
  listSubConsultoresDisponibles,
  asociarSubConsultor,
  desvincularSubConsultor
};
