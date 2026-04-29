const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const { reportarHoras, listarAprobacionesPendientes, actualizarAprobacion } = require("../services/reportes.service");

router.post("/reportar-horas", requireAccess({ roles: ["Consultor", "Consultor Principal", "Mesa de Servicio"], tipos: ["Asociado"] }), reportarHoras);
router.get("/aprobaciones/pendientes", requireAccess({ roles: ["Coordinador"] }), listarAprobacionesPendientes);
router.put("/aprobaciones/:id", requireAccess({ roles: ["Coordinador"] }), actualizarAprobacion);

module.exports = router;
