const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const {
  reportarHoras,
  listarAprobacionesPendientes,
  listarSolicitudesAprobacion,
  actualizarAprobacion
} = require("../services/reportes.service");

router.post("/reportar-horas", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), reportarHoras);
router.get("/aprobaciones/pendientes", requireAccess({ roles: ["Coordinador", "Administrador"] }), listarAprobacionesPendientes);
router.get("/aprobaciones/solicitudes", requireAccess({ roles: ["Coordinador", "Administrador"] }), listarSolicitudesAprobacion);
router.put("/aprobaciones/:id", requireAccess({ roles: ["Coordinador", "Administrador"] }), actualizarAprobacion);

module.exports = router;
