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
router.get("/aprobaciones/pendientes", requireAccess({ roles: ["Coordinador", "Comercial", "Administrador"] }), listarAprobacionesPendientes);
router.get("/aprobaciones/solicitudes", requireAccess({ roles: ["Coordinador", "Comercial", "Administrador"] }), listarSolicitudesAprobacion);
router.put("/aprobaciones/:id", requireAccess({ roles: ["Coordinador", "Comercial", "Administrador"] }), actualizarAprobacion);

module.exports = router;
