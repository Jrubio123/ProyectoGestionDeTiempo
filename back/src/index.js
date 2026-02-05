require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require('path');

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
const FRONTEND_PATH = path.join(__dirname, '..', '..', 'front'); 
app.use(express.static(FRONTEND_PATH));

/* ===============================
   RUTAS DE VISTAS (SPA)
=============================== */
app.get('/views/:view', (req, res) => {
    let viewName = req.params.view;
    if (!viewName.endsWith('.html')) viewName += '.html';
    
    const viewFile = path.join(FRONTEND_PATH, 'views', viewName);
    res.sendFile(viewFile, (err) => {
        if (err) res.status(404).send('<p class="text-red-500">Vista no encontrada</p>');
    });
});

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

// Ruta Default para SPA (Siempre al final)
app.get('*', (req, res) => {
    res.sendFile(path.join(FRONTEND_PATH, 'index.html'));
});

const PORT = process.env.BACK_PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Backend listo en http://localhost:${PORT}`);
});