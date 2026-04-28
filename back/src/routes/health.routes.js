const express = require('express');
const router = express.Router();
const { pool, getPoolStats } = require('../db');
const { requireAccess } = require('../middlewares/access');
const { env } = require('../config/env');

router.get('/health', async (req, res) => {
  const timestamp = new Date().toISOString();
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "healthy",
      timestamp
    });
  } catch (err) {
    res.status(503).json({
      status: "unhealthy",
      timestamp
    });
  }
});

router.get('/health/deep', requireAccess({ roles: ["Administrador"] }), async (req, res) => {
  try {
    const dbCheck = await pool.query("SELECT current_database() AS db_name, version() AS pg_version");
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      db_pool: getPoolStats(),
      db_host: env.DB_HOST || null,
      db_name: dbCheck.rows[0]?.db_name || null,
      pg_version: String(dbCheck.rows[0]?.pg_version || "").split(" ").slice(0, 2).join(" ")
    });
  } catch (err) {
    res.status(503).json({
      status: "unhealthy",
      db_pool: getPoolStats(),
      db_host: env.DB_HOST || null
    });
  }
});

module.exports = router;
