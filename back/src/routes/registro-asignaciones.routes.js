const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const { actualizarRegistroAsignacion, eliminarRegistroAsignacion, crearRegistroAsignacion } = require("../services/registro-asignaciones.service");

router.put("/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), actualizarRegistroAsignacion);
router.delete("/:id", requireAccess({ roles: ["Administrador", "Coordinador"] }), eliminarRegistroAsignacion);
router.post("/", requireAccess({ roles: ["Administrador", "Coordinador"] }), crearRegistroAsignacion);

module.exports = router;
