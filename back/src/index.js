require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const app = express();

/* ===============================
   CONFIG BASE
=============================== */

app.use(cors({
  origin: ["http://localhost:3000"],
  credentials: true
}));
app.use(express.json());

/* ===============================
   DB
=============================== */

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT
});

/* ===============================
   NOTA: Frontend se sirve por separado
=============================== */

/* ===============================
   HEALTHCHECK
=============================== */

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.json({ ok: true, message: "API activo. Abre el frontend en http://localhost:3000" });
});




/* ===============================
   API — AUTH
=============================== */

app.post("/auth/register", async (req, res) => {
  // tu lógica
});

app.post("/auth/login", async (req, res) => {
  // tu lógica
});

/* ===============================
   API — CLIENTES
=============================== */

app.get("/clientes", async (req, res) => {
  // tu lógica real
});

app.post("/clientes", async (req, res) => {
  // tu lógica
});

app.put("/clientes/:id", async (req, res) => {
  // tu lógica
});

app.delete("/clientes/:id", async (req, res) => {
  // tu lógica
});

/* ===============================
   SERVER
=============================== */

const PORT = process.env.BACK_PORT || 4000;

app.listen(PORT, () => {
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
});
