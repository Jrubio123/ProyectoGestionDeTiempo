require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");


const app = express();

/* ===============================
   CONFIGURACIÓN
=============================== */
app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:4000"], // Permite frontend en ambos puertos
  credentials: true
}));
app.use(express.json());

/* ===============================
   BASE DE DATOS
=============================== */
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT
});

/* ===============================
   SERVIR ARCHIVOS DEL FRONTEND
=============================== */
// Ajusta esta ruta si tu carpeta 'front' está en otro nivel relativo
// Frontend se sirve por separado (no está en este contenedor)

/* ===============================
   RUTAS DE VISTAS (SPA)
=============================== */
// (sin rutas de vistas aquí)

/* ===============================
   API - CLIENTES (AQUÍ ESTABA EL FALTANTE)
=============================== */

// 1. OBTENER TODOS
app.get("/clientes", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM clientes WHERE activo = true ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener clientes" });
  }
});

// 2. CREAR CLIENTE
app.post("/clientes", async (req, res) => {
  const { titulo, nit, prefijo } = req.body;

  try {
    // Validar duplicados
    const check = await pool.query("SELECT id FROM clientes WHERE (nit = $1 OR titulo = $2) AND activo = true", [nit, titulo]);
    if (check.rows.length > 0) {
        return res.status(400).json({ error: "El cliente o NIT ya existe en la base de datos" });
    }

    // Calcular siguiente correlativo (MAX + 1)
    const corrRes = await pool.query("SELECT COALESCE(MAX(correlativo), 0) + 1 as next_val FROM clientes");
    const nuevoCorrelativo = corrRes.rows[0].next_val;

    const result = await pool.query(
      "INSERT INTO clientes (titulo, nit, prefijo, correlativo, activo) VALUES ($1, $2, $3, $4, true) RETURNING *",
      [titulo, nit, prefijo || '', nuevoCorrelativo]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar en BD" });
  }
});

// 3. EDITAR CLIENTE
app.put("/clientes/:id", async (req, res) => {
  const { id } = req.params;
  const { titulo, nit, prefijo } = req.body;

  try {
    const result = await pool.query(
      "UPDATE clientes SET titulo = $1, nit = $2, prefijo = $3 WHERE id = $4 RETURNING *",
      [titulo, nit, prefijo, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar" });
  }
});

// 4. ELIMINAR CLIENTE (Soft Delete)
app.delete("/clientes/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Validar dependencias (Ejemplo: si tienes tabla consultorias)
    // const check = await pool.query("SELECT id FROM consultorias WHERE id_cliente = $1", [id]);
    // if (check.rows.length > 0) return res.status(400).json({ tiene_consultorias: true });

    await pool.query("UPDATE clientes SET activo = false WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar" });
  }
});

/* ===============================
   API - CATÁLOGOS
=============================== */

// Consultores activos
app.get("/consultores", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
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
});

// Módulos activos
app.get("/modulos", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, titulo
      FROM modulo
      WHERE activo = true
      ORDER BY titulo ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener módulos" });
  }
});

// Tipos de asignación activos
app.get("/tipos-asignacion", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, titulo
      FROM tipo_asignacion
      WHERE activo = true
      ORDER BY id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tipos de asignación" });
  }
});

// Coordinadores activos
app.get("/coordinadores", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.nombre_usuario AS nombre
      FROM usuarios u
      LEFT JOIN roles r ON u.rol_usuario_id = r.id
      WHERE u.activo = true
        AND r.titulo = 'Coordinador'
      ORDER BY u.nombre_usuario ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener coordinadores" });
  }
});

// Tarifa vigente de un consultor
app.get("/tarifa-consultor", async (req, res) => {
  const { consultor_id, cliente_id, modulo_id, tipo_asignacion_id } = req.query;
  try {
    if (!consultor_id || !cliente_id) {
      return res.status(400).json({ error: "Faltan parámetros requeridos" });
    }
    const result = await pool.query(
      `SELECT obtener_tarifa_consultor($1, $2, $3, $4) AS valor_tarifa`,
      [consultor_id, cliente_id, modulo_id || null, tipo_asignacion_id || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tarifa" });
  }
});

/* ===============================
   API - TARIFAS
=============================== */

// Obtener tarifas
app.get("/tarifas", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        tc.id,
        tc.id_cliente AS cliente_id,
        tc.consultor_id,
        tc.modulo_id,
        tc.id_tipo_asignacion AS tipo_asignacion_id,
        tc.valor_tarifa AS valor,
        tc.activo,
        c.titulo AS nombre_cliente,
        u.nombre_usuario AS nombre_consultor,
        m.titulo AS nombre_modulo,
        ta.titulo AS tipo_asignacion,
        u.moneda_cobro AS moneda
      FROM tarifa_consultor tc
      JOIN clientes c ON c.id = tc.id_cliente
      JOIN usuarios u ON u.id = tc.consultor_id
      LEFT JOIN modulo m ON m.id = tc.modulo_id
      LEFT JOIN tipo_asignacion ta ON ta.id = tc.id_tipo_asignacion
      WHERE tc.activo = true
      ORDER BY tc.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tarifas" });
  }
});

// Crear tarifa
app.post("/tarifas", async (req, res) => {
  const { cliente_id, consultor_id, modulo_id, tipo_asignacion_id, valor } = req.body;

  try {
    if (!cliente_id || !consultor_id || !tipo_asignacion_id || !valor) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const result = await pool.query(
      `INSERT INTO tarifa_consultor 
        (id_cliente, consultor_id, modulo_id, id_tipo_asignacion, valor_tarifa, activo)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [
        cliente_id,
        consultor_id,
        modulo_id || null,
        tipo_asignacion_id || null,
        valor
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar tarifa" });
  }
});

// Actualizar tarifa
app.put("/tarifas/:id", async (req, res) => {
  const { id } = req.params;
  const { cliente_id, consultor_id, modulo_id, tipo_asignacion_id, valor } = req.body;

  try {
    const result = await pool.query(
      `UPDATE tarifa_consultor
       SET id_cliente = $1,
           consultor_id = $2,
           modulo_id = $3,
           id_tipo_asignacion = $4,
           valor_tarifa = $5
       WHERE id = $6
       RETURNING *`,
      [
        cliente_id,
        consultor_id,
        modulo_id || null,
        tipo_asignacion_id || null,
        valor,
        id
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar tarifa" });
  }
});

// Eliminar tarifa (soft delete)
app.delete("/tarifas/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("UPDATE tarifa_consultor SET activo = false WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar tarifa" });
  }
});

/* ===============================
   API - CONSULTORÍAS (ASIGNACIÓN COORDINADORES)
=============================== */

// Obtener consultorías
app.get("/consultorias", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.id_cliente AS cliente_id,
        c.coordinador_responsable_id AS coordinador_id,
        c.id_tipo_asignacion AS tipo_asignacion_id,
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
      ORDER BY c.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener consultorías" });
  }
});

// Crear consultoría
app.post("/consultorias", async (req, res) => {
  const { cliente_id, coordinador_id, tipo_asignacion_id, descripcion_consultoria } = req.body;

  try {
    if (!cliente_id || !coordinador_id || !tipo_asignacion_id) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const result = await pool.query(
      `INSERT INTO consultorias
        (id_cliente, coordinador_responsable_id, id_tipo_asignacion, descripcion_consultoria, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [
        cliente_id,
        coordinador_id,
        tipo_asignacion_id,
        descripcion_consultoria || null
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar consultoría" });
  }
});

// Actualizar consultoría
app.put("/consultorias/:id", async (req, res) => {
  const { id } = req.params;
  const { cliente_id, coordinador_id, tipo_asignacion_id, descripcion_consultoria } = req.body;

  try {
    const result = await pool.query(
      `UPDATE consultorias
       SET id_cliente = $1,
           coordinador_responsable_id = $2,
           id_tipo_asignacion = $3,
           descripcion_consultoria = $4
       WHERE id = $5
       RETURNING *`,
      [
        cliente_id,
        coordinador_id,
        tipo_asignacion_id,
        descripcion_consultoria || null,
        id
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar consultoría" });
  }
});

// Eliminar consultoría (soft delete)
app.delete("/consultorias/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("UPDATE consultorias SET activo = false WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar consultoría" });
  }
});

/* ===============================
   API - MIS ASIGNACIONES (COORDINADOR)
=============================== */

// Listar asignaciones activas para coordinador
app.get("/mis-asignaciones-coordinador", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ra.id,
        con.id AS consultoria_id,
        c.id AS cliente_id,
        c.titulo AS cliente,
        u.nombre_usuario AS consultor_responsable,
        coord.nombre_usuario AS coordinador,
        m.titulo AS modulo,
        ta.titulo AS tipo_asignacion,
        con.id_tipo_asignacion AS tipo_asignacion_id,
        con.descripcion_consultoria,
        ra.consultor_responsable_id,
        ra.id_modulo,
        ra.estado,
        ra.tipo_servicio,
        ra.valor_hora,
        ra.cantidad_dias,
        ra.fecha_inicio,
        ra.fecha_fin,
        ra.nro_caso_interno,
        ra.nro_caso_cliente,
        ra.observacion
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        JOIN clientes c ON con.id_cliente = c.id
        LEFT JOIN usuarios u ON ra.consultor_responsable_id = u.id
        LEFT JOIN usuarios coord ON con.coordinador_responsable_id = coord.id
        LEFT JOIN modulo m ON ra.id_modulo = m.id
        LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
      WHERE ra.estado = 'Activo'
      ORDER BY ra.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener asignaciones" });
  }
});

// Actualizar asignación (registro_asignaciones)
app.put("/registro-asignaciones/:id", async (req, res) => {
  const { id } = req.params;
  const {
    consultor_responsable_id,
    id_modulo,
    fecha_inicio,
    fecha_fin,
    cantidad_dias,
    valor_hora,
    nro_caso_interno,
    nro_caso_cliente,
    tipo_servicio,
    estado,
    observacion,
    total_pagar
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE registro_asignaciones
       SET consultor_responsable_id = $1,
           id_modulo = $2,
           fecha_inicio = $3,
           fecha_fin = $4,
           cantidad_dias = $5,
           valor_hora = $6,
           nro_caso_interno = $7,
           nro_caso_cliente = $8,
           tipo_servicio = $9,
           estado = $10,
           observacion = $11,
           total_pagar = $12
       WHERE id = $13
       RETURNING *`,
      [
        consultor_responsable_id || null,
        id_modulo || null,
        fecha_inicio || null,
        fecha_fin || null,
        cantidad_dias || null,
        valor_hora || null,
        nro_caso_interno || null,
        nro_caso_cliente || null,
        tipo_servicio || null,
        estado || null,
        observacion || null,
        total_pagar || null,
        id
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar asignación" });
  }
});

// Ruta Default para SPA (Siempre al final)
app.get("/", (req, res) => {
  res.json({ ok: true, message: "API activo. Abre el frontend en http://localhost:3000" });
});

const PORT = process.env.BACK_PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Backend listo en http://localhost:${PORT}`);
});
