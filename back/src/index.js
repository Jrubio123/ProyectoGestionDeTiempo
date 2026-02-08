const path = require("path");
const envFile =
  process.env.NODE_ENV === "production" ? ".env_produccion" : ".env";
require("dotenv").config({ path: path.resolve(process.cwd(), envFile) });
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { NumerosALetras } = require("numero-a-letras");


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

function buildTotalLetras(numero, moneda = 'COP') {
    const parteEntera = Math.floor(numero);
    const centavos = Math.round((numero - parteEntera) * 100);
    
    // Obtener texto y limpiar "00/100" si existe
    let textoNumeros = NumerosALetras(parteEntera).toUpperCase();
    
    // Eliminar " 00/100" si está presente
    textoNumeros = textoNumeros.replace(/\s*00\/100\s*/g, '');
    // También eliminar "M.N." si existe
    textoNumeros = textoNumeros.replace(/\s*M\.N\.\s*/g, '');
    
    const nombreMoneda = moneda === 'USD' ? 'DÓLARES' : 'PESOS';
    
    if (centavos > 0) {
        return `${textoNumeros} CON ${centavos}/100 ${nombreMoneda}`;
    } else {
        return `${textoNumeros} ${nombreMoneda}`;
    }
}

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

/* ===============================
   AUTH
=============================== */

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

app.post("/auth/register", async (req, res) => {
  const { nombre_usuario, email, password } = req.body;

  try {
    if (!nombre_usuario || !email || !password) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const existe = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: "El correo ya está registrado" });
    }

    const rolRes = await pool.query(
      "SELECT id FROM roles WHERE titulo = 'Consultor' LIMIT 1"
    );
    const rolId = rolRes.rows[0]?.id || null;

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (nombre_usuario, email, password_hash, rol_usuario_id, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, nombre_usuario, email, rol_usuario_id`,
      [nombre_usuario, email, hash, rolId]
    );

    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al registrar" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

      const result = await pool.query(
        `SELECT u.id, u.nombre_usuario, u.email, u.password_hash, u.rol_usuario_id, u.tipo_consultor, r.titulo AS rol
         FROM usuarios u
         LEFT JOIN roles r ON u.rol_usuario_id = r.id
         WHERE u.email = $1 AND u.activo = true`,
        [email]
      );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

      const payload = {
        id: user.id,
        nombre_usuario: user.nombre_usuario,
        email: user.email,
        rol: user.rol || "",
        rol_usuario_id: user.rol_usuario_id,
        tipo_consultor: user.tipo_consultor || null
      };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
    res.json({ token, user: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "No autorizado" });
    const decoded = jwt.verify(token, JWT_SECRET);
      const result = await pool.query(
        `SELECT u.id, u.nombre_usuario, u.email, u.rol_usuario_id, u.tipo_consultor, r.titulo AS rol
         FROM usuarios u
         LEFT JOIN roles r ON u.rol_usuario_id = r.id
         WHERE u.id = $1 AND u.activo = true`,
        [decoded.id]
      );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Usuario no válido" });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(401).json({ error: "Token inválido" });
  }
});

const authMiddleware = (req, res, next) => {
  const publicPaths = ["/", "/auth/login", "/auth/register", "/auth/me"];
  if (publicPaths.includes(req.path)) return next();

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  // En desarrollo, permitir flujo sin auth para acelerar pruebas
  if (!token && process.env.BACK_ENV !== "production") {
    return next();
  }

  if (!token) return res.status(401).json({ error: "No autorizado" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido" });
  }
};

app.use(authMiddleware);

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
        AND (
          r.titulo = 'Coordinador'
          OR u.rol_usuario_id = (SELECT id FROM roles WHERE titulo = 'Coordinador' LIMIT 1)
        )
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
    const coordinadorId = req.query.coordinador_id || null;
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
        AND ($1::int IS NULL OR c.coordinador_responsable_id = $1)
      ORDER BY c.id DESC
    `, [coordinadorId]);
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
    const userId = req.user?.id || req.query.coordinador_id;
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
          ra.valor_dia,
          ra.total_pagar,
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
        WHERE con.activo = true
          AND ($1::int IS NULL OR con.coordinador_responsable_id = $1)
        ORDER BY ra.id DESC
      `, [userId || null]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener asignaciones" });
  }
});

// Listar asignaciones activas para consultor
app.get("/mis-asignaciones", async (req, res) => {
  try {
    const userId = req.user?.id || req.query.consultor_id;
    const result = await pool.query(`
      SELECT
        ra.id,
        con.id AS consultoria_id,
        c.id AS cliente_id,
        c.titulo AS nombre_cliente,
        coord.nombre_usuario AS nombre_coordinador,
        m.titulo AS nombre_modulo,
        ta.titulo AS nombre_tipo_asignacion,
        ra.horas_asignadas,
        ra.cantidad_dias,
        ra.valor_hora,
        ra.valor_dia,
        ra.total_pagar,
        ra.estado,
        ra.tipo_servicio,
        ra.nro_caso_interno,
        ra.nro_caso_cliente,
        ra.fecha_fin,
        ra.observacion,
        lr.estado_reporte,
        lr.motivo_rechazo
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        JOIN clientes c ON con.id_cliente = c.id
        LEFT JOIN usuarios coord ON con.coordinador_responsable_id = coord.id
        LEFT JOIN modulo m ON ra.id_modulo = m.id
        LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
        LEFT JOIN LATERAL (
          SELECT rh.estado_reporte, rh.motivo_rechazo
          FROM reporte_horas rh
          WHERE rh.id_registro_asignacion = ra.id
          ORDER BY rh.created_at DESC
          LIMIT 1
        ) lr ON true
      WHERE ($1::int IS NULL OR ra.consultor_responsable_id = $1)
        AND lr.estado_reporte = 'Aprobado'
      ORDER BY ra.id DESC
    `, [userId || null]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener asignaciones" });
  }
});

// Asignaciones disponibles para registro de horas (consultor)
app.get("/registro-horas-asignaciones", async (req, res) => {
  try {
    const userId = req.user?.id || req.query.consultor_id;
    const result = await pool.query(`
      SELECT
        ra.id,
        con.id AS consultoria_id,
        c.id AS cliente_id,
        c.titulo AS nombre_cliente,
        coord.nombre_usuario AS nombre_coordinador,
        m.titulo AS nombre_modulo,
        ta.titulo AS nombre_tipo_asignacion,
        ra.horas_asignadas,
        ra.cantidad_dias,
        ra.valor_hora,
        ra.valor_dia,
        ra.total_pagar,
        ra.estado,
        ra.tipo_servicio,
        ra.nro_caso_interno,
        ra.nro_caso_cliente,
        ra.fecha_fin,
        ra.observacion,
        lr.estado_reporte,
        lr.motivo_rechazo
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        JOIN clientes c ON con.id_cliente = c.id
        LEFT JOIN usuarios coord ON con.coordinador_responsable_id = coord.id
        LEFT JOIN modulo m ON ra.id_modulo = m.id
        LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
        LEFT JOIN LATERAL (
          SELECT rh.estado_reporte, rh.motivo_rechazo
          FROM reporte_horas rh
          WHERE rh.id_registro_asignacion = ra.id
          ORDER BY rh.created_at DESC
          LIMIT 1
        ) lr ON true
      WHERE ($1::int IS NULL OR ra.consultor_responsable_id = $1)
        AND (lr.estado_reporte IS NULL OR lr.estado_reporte = 'Rechazado')
        AND ra.estado IN ('Abierto', 'Proceso')
      ORDER BY ra.id DESC
    `, [userId || null]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener asignaciones para registro" });
  }
});

// Reportar horas
app.post("/reportar-horas", async (req, res) => {
  const {
    id_registro_asignacion,
    horas_reportadas,
    cantidad_dias_reportados,
    total_cobrar,
    tipo_servicio,
    nro_caso_int_ext
  } = req.body;

  try {
    if (!id_registro_asignacion) {
      return res.status(400).json({ error: "Falta id_registro_asignacion" });
    }

      const existente = await pool.query(
        `SELECT id, estado_reporte
         FROM reporte_horas
         WHERE id_registro_asignacion = $1
           AND estado_reporte IN ('Pendiente', 'Rechazado')
         ORDER BY updated_at DESC NULLS LAST, id DESC
         LIMIT 1`,
        [id_registro_asignacion]
      );
      const existenteRow = existente.rows[0];
      if (existenteRow?.estado_reporte === "Pendiente") {
        return res.status(400).json({ error: "Ya hay un reporte pendiente para esta asignación" });
      }

    const meta = await pool.query(`
      SELECT
        ra.id,
        ra.id_modulo,
        ra.consultor_responsable_id,
        con.id_cliente,
        con.id_tipo_asignacion,
        con.coordinador_responsable_id
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
      WHERE ra.id = $1
    `, [id_registro_asignacion]);

    if (meta.rows.length === 0) {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }

      const info = meta.rows[0];
      const consultorId = info.consultor_responsable_id || req.user?.id || null;
      let consultorPrincipalId = null;
      if (consultorId) {
        const principalRes = await pool.query(
          "SELECT id_consultor_principal, tipo_consultor FROM usuarios WHERE id = $1",
          [consultorId]
        );
        const principalRow = principalRes.rows[0];
        if (principalRow?.id_consultor_principal) {
          consultorPrincipalId = principalRow.id_consultor_principal;
        }
      }
      let result;
      if (existenteRow?.estado_reporte === "Rechazado") {
        result = await pool.query(
          `UPDATE reporte_horas
           SET horas_reportadas = $1,
               cantidad_dias_reportados = $2,
               total_cobrar = $3,
               tipo_servicio = $4,
               nro_caso_int_ext = $5,
               cliente_id = $6,
               tipo_asignacion_id = $7,
               modulo_id = $8,
               coordinador_id = $9,
               consultor_responsable_id = $10,
               consultor_principal_id = $11,
               estado_reporte = 'Pendiente',
               motivo_rechazo = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $12
           RETURNING *`,
          [
            horas_reportadas || null,
            cantidad_dias_reportados || null,
            total_cobrar || null,
            tipo_servicio || null,
            nro_caso_int_ext || null,
            info.id_cliente,
            info.id_tipo_asignacion,
            info.id_modulo,
            info.coordinador_responsable_id,
            consultorId,
            consultorPrincipalId,
            existenteRow.id
          ]
        );
      } else {
        result = await pool.query(
          `INSERT INTO reporte_horas
            (id_registro_asignacion, horas_reportadas, cantidad_dias_reportados, total_cobrar,
             tipo_servicio, nro_caso_int_ext, cliente_id, tipo_asignacion_id, modulo_id,
             coordinador_id, consultor_responsable_id, consultor_principal_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING *`,
          [
            id_registro_asignacion,
            horas_reportadas || null,
            cantidad_dias_reportados || null,
            total_cobrar || null,
            tipo_servicio || null,
            nro_caso_int_ext || null,
            info.id_cliente,
            info.id_tipo_asignacion,
            info.id_modulo,
            info.coordinador_responsable_id,
            consultorId,
            consultorPrincipalId,
            req.user?.id || consultorId
          ]
        );
      }

    await pool.query(
      `UPDATE registro_asignaciones
       SET estado = 'Proceso'
       WHERE id = $1`,
      [id_registro_asignacion]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al reportar horas" });
  }
});

/* ===============================
   API - CUENTAS DE COBRO
=============================== */

// Registros aprobados por cobrar
app.get("/horas-por-cobrar/:consultorId", async (req, res) => {
  const { consultorId } = req.params;
  try {
    if (!consultorId) return res.json([]);
    const result = await pool.query(
      `
      SELECT
        rh.id,
        rh.total_cobrar,
        rh.horas_reportadas,
        rh.cantidad_dias_reportados,
        rh.created_at,
        rh.nro_caso_int_ext,
        rh.requerimiento,
        c.titulo AS cliente,
        ta.titulo AS tipo_asignacion
      FROM reporte_horas rh
        LEFT JOIN clientes c ON rh.cliente_id = c.id
        LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
      WHERE rh.estado_reporte = 'Aprobado'
        AND rh.id_cuenta_cobro IS NULL
        AND (rh.consultor_principal_id = $1 OR rh.consultor_responsable_id = $1)
      ORDER BY rh.id DESC
      `,
      [consultorId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener registros por cobrar" });
  }
});

// Vista previa de cuenta de cobro (total + letras)
app.post("/cuentas-cobro/preview", async (req, res) => {
  const { consultor_id, ids_reportes } = req.body;
  
  if (!consultor_id || !Array.isArray(ids_reportes) || ids_reportes.length === 0) {
    return res.status(400).json({ error: "Faltan datos para previsualizar" });
  }

  try {
    // 1. Obtener moneda del consultor
    const monedaRes = await pool.query(
      "SELECT moneda_cobro FROM usuarios WHERE id = $1",
      [consultor_id]
    );
    const moneda = monedaRes.rows[0]?.moneda_cobro || "COP";

    // 2. Calcular totales y fechas
    const meta = await pool.query(
      `SELECT
        COUNT(*) AS count,
        COALESCE(SUM(total_cobrar), 0) AS total,
        MIN(created_at)::date AS min_fecha,
        MAX(created_at)::date AS max_fecha
      FROM reporte_horas
      WHERE id = ANY($1)
        AND estado_reporte = 'Aprobado'
        AND id_cuenta_cobro IS NULL
        AND (consultor_principal_id = $2 OR consultor_responsable_id = $2)`,
      [ids_reportes, consultor_id]
    );

    const info = meta.rows[0];
    
    // 3. Validar que todos los registros sean válidos
    if (Number(info.count) !== ids_reportes.length) {
      return res.status(400).json({ 
        error: "Algunos registros no son válidos para cobro" 
      });
    }

    // 4. Convertir a letras
    const total = Number(info.total || 0);
    const total_letras = buildTotalLetras(total, moneda);

    // 5. Retornar respuesta
    res.json({
      total: total,
      total_letras: total_letras,
      moneda: moneda,
      fecha_inicio: info.min_fecha,
      fecha_fin: info.max_fecha
    });

  } catch (error) {
    console.error('❌ Error en /cuentas-cobro/preview:', error);
    res.status(500).json({ 
      error: 'Error al calcular preview',
      detalle: error.message 
    });
  }
});

// Crear cuenta de cobro
app.post("/cuentas-cobro", async (req, res) => {
  const { consultor_id, fecha_inicio, fecha_fin, total_letras, ciudad_cobro, total_numeros, ids_reportes } = req.body;
  if (!consultor_id || !fecha_inicio || !fecha_fin || !total_letras || !ciudad_cobro || !Array.isArray(ids_reportes) || ids_reportes.length === 0) {
    return res.status(400).json({ error: "Faltan datos para generar la cuenta" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const meta = await client.query(
      `
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(total_cobrar), 0) AS total,
        MIN(created_at)::date AS min_fecha,
        MAX(created_at)::date AS max_fecha
      FROM reporte_horas
      WHERE id = ANY($1)
        AND estado_reporte = 'Aprobado'
        AND id_cuenta_cobro IS NULL
        AND (consultor_principal_id = $2 OR consultor_responsable_id = $2)
      `,
      [ids_reportes, consultor_id]
    );

    const info = meta.rows[0];
    if (Number(info.count) !== ids_reportes.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Algunos registros no son válidos para cobro" });
    }

    const monedaRes = await client.query(
      "SELECT moneda_cobro FROM usuarios WHERE id = $1",
      [consultor_id]
    );
    const moneda = monedaRes.rows[0]?.moneda_cobro || "COP";
    const totalLetrasFinal = buildTotalLetras(Number(info.total || 0), moneda);
    const descripcionFinal =
      (typeof req.body.descripcion === "string" && req.body.descripcion.trim()) ||
      `Cuenta de cobro ${fecha_inicio} - ${fecha_fin}`;

    const insert = await client.query(
      `
      INSERT INTO cuenta_cobro
        (descripcion, fecha_correspondiente, fecha_periodo_inicio, fecha_periodo_fin, total_cuenta_cobro, total_letras, ciudad_cobro, created_by)
      VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        descripcionFinal,
        fecha_inicio,
        fecha_fin,
        info.total,
        totalLetrasFinal,
        ciudad_cobro,
        consultor_id
      ]
    );

    const cuentaId = insert.rows[0].id;

    await client.query(
      `
      UPDATE reporte_horas
      SET id_cuenta_cobro = $1
      WHERE id = ANY($2)
      `,
      [cuentaId, ids_reportes]
    );

    await client.query(
      `
      UPDATE registro_asignaciones
      SET estado = 'Cerrado'
      WHERE id IN (
        SELECT id_registro_asignacion
        FROM reporte_horas
        WHERE id = ANY($1)
      )
      `,
      [ids_reportes]
    );

    await client.query("COMMIT");
    res.json({ ok: true, cuenta: insert.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Error al generar cuenta de cobro" });
  } finally {
    client.release();
  }
});

// Historial de cuentas de cobro por usuario
app.get("/cuentas-cobro/historial/:userId", async (req, res) => {
  const { userId } = req.params;
  const { fecha_inicio, fecha_fin } = req.query;
  try {
    if (!userId) return res.json([]);
    const params = [userId];
    let whereFecha = "";
    if (fecha_inicio && fecha_fin) {
      params.push(fecha_inicio, fecha_fin);
      whereFecha = "AND cc.fecha_correspondiente BETWEEN $2 AND $3";
    }
    const result = await pool.query(
      `
      SELECT
        cc.id,
        COALESCE(NULLIF(cc.descripcion, ''), 'Cuenta de cobro') AS descripcion,
        cc.fecha_correspondiente,
        cc.fecha_periodo_inicio AS fecha_inicio_periodo,
        cc.fecha_periodo_fin AS fecha_fin_periodo,
        cc.total_cuenta_cobro AS total_numeros,
        cc.total_letras,
        cc.estado,
        cc.created_at
      FROM cuenta_cobro cc
      WHERE cc.created_by = $1
        ${whereFecha}
      ORDER BY cc.id DESC
      `,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener historial de cobros" });
  }
});

// Detalle de cuenta de cobro
app.get("/cuentas-cobro/detalle/:cuentaId", async (req, res) => {
  const { cuentaId } = req.params;
  try {
    const result = await pool.query(
      `
        SELECT
          rh.id,
          c.titulo AS cliente,
          m.titulo AS modulo,
          ta.titulo AS tipo_asignacion,
          u.nombre_usuario AS consultor_responsable,
          rh.nro_caso_int_ext,
          rh.horas_reportadas,
          rh.cantidad_dias_reportados,
          rh.total_cobrar
        FROM reporte_horas rh
          LEFT JOIN clientes c ON rh.cliente_id = c.id
          LEFT JOIN modulo m ON rh.modulo_id = m.id
          LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
          LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
      WHERE rh.id_cuenta_cobro = $1
      ORDER BY rh.id DESC
      `,
      [cuentaId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener detalle de cuenta" });
  }
});


// Reportes pendientes para coordinador
app.get("/aprobaciones/pendientes", async (req, res) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(`
      SELECT
        rh.id,
        rh.created_at AS fecha_reporte,
        rh.nro_caso_int_ext,
        rh.total_cobrar,
        rh.horas_reportadas,
        rh.cantidad_dias_reportados,
        c.titulo AS nombre_cliente,
        u.nombre_usuario AS nombre_consultor,
        u.email AS email_consultor,
        m.titulo AS nombre_modulo,
        ta.titulo AS nombre_tipo_asignacion
      FROM reporte_horas rh
        LEFT JOIN clientes c ON rh.cliente_id = c.id
        LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
        LEFT JOIN modulo m ON rh.modulo_id = m.id
        LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
      WHERE rh.estado_reporte = 'Pendiente'
        AND rh.coordinador_id = $1
      ORDER BY rh.created_at DESC
    `, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener reportes" });
  }
});

// Aprobar / Rechazar reporte
app.put("/aprobaciones/:id", async (req, res) => {
  const { id } = req.params;
  const { estado, motivo } = req.body;

  try {
    if (!estado) {
      return res.status(400).json({ error: "Falta estado" });
    }
    const result = await pool.query(
      `UPDATE reporte_horas
       SET estado_reporte = $1,
           motivo_rechazo = $2
       WHERE id = $3
       RETURNING *`,
      [estado, motivo || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Reporte no encontrado" });
    }

    const registroId = result.rows[0]?.id_registro_asignacion || null;
    if (registroId) {
      try {
        // Actualizar aprobación y estado en la asignación asociada
        await pool.query(
          `UPDATE registro_asignaciones
           SET aprobar_coordinador = $1,
               estado = CASE
                 WHEN $1 = 'Aprobado' THEN 'Proceso'
                 WHEN $1 = 'Rechazado' THEN 'Abierto'
                 ELSE estado
               END
           WHERE id = $2`,
          [estado, registroId]
        );
      } catch (innerErr) {
        console.error("Error actualizando registro_asignaciones:", innerErr);
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar reporte" });
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
    valor_dia,
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
           valor_dia = $7,
           nro_caso_interno = $8,
           nro_caso_cliente = $9,
           tipo_servicio = $10,
           estado = $11,
           observacion = $12,
           total_pagar = $13
       WHERE id = $14
       RETURNING *`,
      [
        consultor_responsable_id || null,
        id_modulo || null,
        fecha_inicio || null,
        fecha_fin || null,
        cantidad_dias || null,
        valor_hora || null,
        valor_dia || null,
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

// Crear asignación (registro_asignaciones)
app.post("/registro-asignaciones", async (req, res) => {
    const {
      id_consultoria,
      id_modulo,
      consultor_responsable_id,
      fecha_inicio,
      fecha_fin,
      cantidad_dias,
      horas_asignadas,
      valor_hora,
      valor_dia,
      tipo_servicio,
      total_pagar
    } = req.body;

  try {
    if (!id_consultoria || !consultor_responsable_id || !id_modulo) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const meta = await pool.query(
      "SELECT id_cliente FROM consultorias WHERE id = $1 AND activo = true",
      [id_consultoria]
    );
    if (meta.rows.length === 0) {
      return res.status(400).json({ error: "Consultoría no válida" });
    }
    const clienteId = meta.rows[0].id_cliente;

    const dup = await pool.query(
      `SELECT ra.id
       FROM registro_asignaciones ra
       JOIN consultorias con ON ra.id_consultoria = con.id
       WHERE ra.consultor_responsable_id = $1
         AND ra.id_modulo = $2
         AND con.id_cliente = $3
         AND ra.estado IN ('Abierto', 'Proceso')
       LIMIT 1`,
      [consultor_responsable_id, id_modulo, clienteId]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe asignación para este consultor, cliente y módulo" });
    }

      const result = await pool.query(
        `INSERT INTO registro_asignaciones
          (id_consultoria, id_modulo, consultor_responsable_id, fecha_inicio, fecha_fin,
           cantidad_dias, horas_asignadas, valor_hora, valor_dia, tipo_servicio, total_pagar, estado, aprobar_coordinador)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Abierto','Pendiente')
         RETURNING *`,
        [
          id_consultoria,
          id_modulo,
          consultor_responsable_id,
          fecha_inicio || null,
          fecha_fin || null,
          cantidad_dias || null,
          horas_asignadas || null,
          valor_hora || null,
          valor_dia || null,
          tipo_servicio || null,
          total_pagar || null
        ]
      );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear asignación" });
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
