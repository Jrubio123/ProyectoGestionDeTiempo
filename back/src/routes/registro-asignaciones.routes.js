const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const { actualizarRegistroAsignacion, eliminarRegistroAsignacion, crearRegistroAsignacion } = require("../services/registro-asignaciones.service");

router.put("/:id", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }), actualizarRegistroAsignacion);
router.delete("/:id", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }), eliminarRegistroAsignacion);
router.post("/", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }), crearRegistroAsignacion);

module.exports = router;
