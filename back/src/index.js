require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// Pool de conexión a PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT
});

// Middleware para verificar token JWT
const verificarToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  
  if (!token) {
    return res.status(401).json({ error: "Token no proporcionado" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "SECRETO_TEMPORAL");
    req.usuario = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido" });
  }
};

/* ======================
   AUTH
====================== */

app.post("/auth/register", async (req, res) => {
  const { nombre_usuario, email, password, rol_usuario_id } = req.body;

  try {
    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO usuarios (nombre_usuario, email, rol_usuario_id, activo)
       VALUES ($1, $2, $3, true) RETURNING id, nombre_usuario, email`,
      [nombre_usuario, email, rol_usuario_id || 1]
    );

    res.json({ ok: true, usuario: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Usuario ya existe o email duplicado" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      `SELECT u.*, r.titulo as rol 
       FROM usuarios u
       LEFT JOIN roles r ON u.rol_usuario_id = r.id
       WHERE u.email = $1 AND u.activo = true`,
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Usuario no existe" });
    }

    const user = result.rows[0];

    // Si no hay password_hash, es un usuario migrado de SharePoint
    // En producción, deberías forzar un cambio de contraseña
    if (!user.password_hash) {
      return res.status(401).json({ 
        error: "Usuario debe establecer contraseña",
        requiere_setup: true 
      });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Contraseña incorrecta" });
    }

    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email,
        nombre: user.nombre_usuario,
        rol: user.rol
      },
      process.env.JWT_SECRET || "SECRETO_TEMPORAL",
      { expiresIn: "8h" }
    );

    res.json({ 
      token,
      usuario: {
        id: user.id,
        nombre: user.nombre_usuario,
        email: user.email,
        rol: user.rol
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en login" });
  }
});

/* ======================
   CLIENTES - CRUD COMPLETO
====================== */

// Obtener todos los clientes activos
app.get("/clientes", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        id,
        titulo,
        nit,
        prefijo,
        correlativo,
        activo,
        direccion,
        telefono,
        email,
        created_at,
        updated_at
       FROM clientes
       WHERE activo = true
       ORDER BY id DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo clientes" });
  }
});

// Obtener un cliente por ID
app.get("/clientes/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "SELECT * FROM clientes WHERE id = $1 AND activo = true",
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo cliente" });
  }
});

// Verificar si un cliente tiene consultorías asociadas
app.get("/clientes/:id/consultorias", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "SELECT id FROM consultorias WHERE id_cliente = $1 LIMIT 1",
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error verificando consultorías" });
  }
});

// Validar NIT único
app.post("/clientes/validar-nit", async (req, res) => {
  const { nit, excluir_id } = req.body;

  try {
    let query = "SELECT id FROM clientes WHERE nit = $1";
    let params = [nit];

    if (excluir_id) {
      query += " AND id != $2";
      params.push(excluir_id);
    }

    const result = await pool.query(query, params);

    res.json({ existe: result.rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error validando NIT" });
  }
});

// Validar título único
app.post("/clientes/validar-titulo", async (req, res) => {
  const { titulo, excluir_id } = req.body;

  try {
    let query = "SELECT id FROM clientes WHERE LOWER(titulo) = LOWER($1)";
    let params = [titulo];

    if (excluir_id) {
      query += " AND id != $2";
      params.push(excluir_id);
    }

    const result = await pool.query(query, params);

    res.json({ existe: result.rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error validando título" });
  }
});

// Crear nuevo cliente
app.post("/clientes", async (req, res) => {
  const { titulo, nit, prefijo, direccion, telefono, email } = req.body;

  // Validaciones
  if (!titulo || !nit) {
    return res.status(400).json({ 
      error: "Título y NIT son obligatorios" 
    });
  }

  try {
    // Verificar NIT único
    const nitExiste = await pool.query(
      "SELECT id FROM clientes WHERE nit = $1",
      [nit]
    );

    if (nitExiste.rows.length > 0) {
      return res.status(400).json({ error: "El NIT ya existe" });
    }

    // Verificar título único
    const tituloExiste = await pool.query(
      "SELECT id FROM clientes WHERE LOWER(titulo) = LOWER($1)",
      [titulo]
    );

    if (tituloExiste.rows.length > 0) {
      return res.status(400).json({ error: "El cliente ya existe" });
    }

    // Obtener el siguiente correlativo
    const correlativoResult = await pool.query(
      "SELECT COALESCE(MAX(correlativo), 0) + 1 as siguiente FROM clientes"
    );
    const correlativo = correlativoResult.rows[0].siguiente;

    // Insertar cliente
    const result = await pool.query(
      `INSERT INTO clientes 
        (titulo, nit, prefijo, correlativo, direccion, telefono, email, activo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [titulo, nit, prefijo || '', correlativo, direccion, telefono, email]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creando cliente" });
  }
});

// Actualizar cliente
app.put("/clientes/:id", async (req, res) => {
  const { id } = req.params;
  const { titulo, nit, prefijo, direccion, telefono, email } = req.body;

  // Validaciones
  if (!titulo || !nit) {
    return res.status(400).json({ 
      error: "Título y NIT son obligatorios" 
    });
  }

  try {
    // Verificar que el cliente existe
    const clienteExiste = await pool.query(
      "SELECT id FROM clientes WHERE id = $1",
      [id]
    );

    if (!clienteExiste.rows.length) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    // Verificar NIT único (excluyendo el cliente actual)
    const nitExiste = await pool.query(
      "SELECT id FROM clientes WHERE nit = $1 AND id != $2",
      [nit, id]
    );

    if (nitExiste.rows.length > 0) {
      return res.status(400).json({ error: "El NIT ya existe" });
    }

    // Verificar título único (excluyendo el cliente actual)
    const tituloExiste = await pool.query(
      "SELECT id FROM clientes WHERE LOWER(titulo) = LOWER($1) AND id != $2",
      [titulo, id]
    );

    if (tituloExiste.rows.length > 0) {
      return res.status(400).json({ error: "El cliente ya existe" });
    }

    // Actualizar cliente
    const result = await pool.query(
      `UPDATE clientes 
       SET titulo = $1, 
           nit = $2, 
           prefijo = $3,
           direccion = $4,
           telefono = $5,
           email = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [titulo, nit, prefijo || '', direccion, telefono, email, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error actualizando cliente" });
  }
});

// Eliminar cliente (soft delete)
app.delete("/clientes/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Verificar si tiene consultorías asociadas
    const consultorias = await pool.query(
      "SELECT id FROM consultorias WHERE id_cliente = $1 LIMIT 1",
      [id]
    );

    if (consultorias.rows.length > 0) {
      return res.status(400).json({ 
        error: "El cliente tiene consultorías asociadas",
        tiene_consultorias: true
      });
    }

    // Soft delete
    const result = await pool.query(
      `UPDATE clientes 
       SET activo = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json({ 
      ok: true, 
      mensaje: "Cliente eliminado correctamente",
      cliente: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error eliminando cliente" });
  }
});

/* ======================
   ENDPOINTS AUXILIARES
====================== */

// Obtener roles (para registro de usuarios)
app.get("/roles", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, titulo FROM roles WHERE activo = true ORDER BY titulo"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo roles" });
  }
});

// Health check
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    res.status(500).json({ status: "error", database: "disconnected" });
  }
});

/* ======================
   INICIAR SERVIDOR
====================== */

const PORT = process.env.BACK_PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Backend corriendo en puerto ${PORT}`);
  console.log(`📊 Base de datos: ${process.env.DB_NAME}@${process.env.DB_HOST}:${process.env.DB_PORT}`);
});

// Manejar errores no capturados
process.on('unhandledRejection', (err) => {
  console.error('Error no manejado:', err);
});