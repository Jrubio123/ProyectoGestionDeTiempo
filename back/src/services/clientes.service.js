const { pool } = require("../db");

/**
 * Lista clientes activos del sistema
 */
async function listClientes(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        public_id AS id,
        titulo,
        nit,
        prefijo,
        correlativo,
        activo,
        COALESCE(requiere_confirmacion_cliente, false) AS requiere_confirmacion_cliente,
        created_at,
        updated_at
      FROM clientes
      WHERE activo = true
      ORDER BY id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener clientes" });
  }
}

/**
 * Crea un cliente con correlativo unico
 */
async function createCliente(req, res) {
  const { titulo, nit, prefijo, requiere_confirmacion_cliente } = req.body;
  const { toBooleanInput } = require("../index");
  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('clientes_correlativo'))");

    const check = await client.query(
      "SELECT id FROM clientes WHERE (nit = $1 OR titulo = $2) AND activo = true",
      [nit, titulo]
    );
    if (check.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "El cliente o NIT ya existe en la base de datos" });
    }

    const corrRes = await client.query("SELECT COALESCE(MAX(correlativo), 0) + 1 as next_val FROM clientes");
    const nuevoCorrelativo = corrRes.rows[0].next_val;

    const result = await client.query(
      `INSERT INTO clientes (titulo, nit, prefijo, correlativo, activo, requiere_confirmacion_cliente)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING
         public_id AS id,
         titulo,
         nit,
         prefijo,
         correlativo,
         activo,
         COALESCE(requiere_confirmacion_cliente, false) AS requiere_confirmacion_cliente,
         created_at,
         updated_at`,
      [titulo, nit, prefijo || "", nuevoCorrelativo, toBooleanInput(requiere_confirmacion_cliente, false)]
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "El cliente o NIT ya existe en la base de datos" });
    }
    res.status(500).json({ error: "Error al guardar en BD" });
  } finally {
    if (client) client.release();
  }
}

/**
 * Actualiza los datos de un cliente
 */
async function updateCliente(req, res) {
  const { id } = req.params;
  const { titulo, nit, prefijo, requiere_confirmacion_cliente } = req.body;
  const { toBooleanInput, withPublicId } = require("../index");

  try {
    const result = await pool.query(
      `UPDATE clientes
       SET titulo = $1,
           nit = $2,
           prefijo = $3,
           requiere_confirmacion_cliente = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = (SELECT id FROM clientes WHERE public_id = $5)
       RETURNING
         public_id AS id,
         titulo,
         nit,
         prefijo,
         correlativo,
         activo,
         COALESCE(requiere_confirmacion_cliente, false) AS requiere_confirmacion_cliente,
         created_at,
         updated_at`,
      [titulo, nit, prefijo, toBooleanInput(requiere_confirmacion_cliente, false), id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Cliente no encontrado" });
    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar" });
  }
}

/**
 * Desactiva un cliente existente
 */
async function deleteCliente(req, res) {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "UPDATE clientes SET activo = false, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM clientes WHERE public_id = $1) RETURNING id",
      [id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Cliente no encontrado" });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar" });
  }
}

module.exports = { listClientes, createCliente, updateCliente, deleteCliente };
