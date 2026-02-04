const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST || "db",
  port: process.env.DB_PORT || 5432
});

// Ruta de salud
app.get("/health", async (req, res) => {
  const result = await pool.query("SELECT NOW()");
  res.json({ status: "ok", db_time: result.rows[0].now });
});

// NUEVA RUTA: Guardar tarea
app.post("/tareas", async (req, res) => {
  const { titulo, descripcion, usuario_id } = req.body;
  try {
    const query = "INSERT INTO tareas (titulo, descripcion, usuario_id) VALUES ($1, $2, $3) RETURNING *";
    const values = [titulo, descripcion, usuario_id];
    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar en BD" });
  }
});

const PORT = process.env.BACK_PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});