const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const {
  listConsultores,
  listConsultoresPrincipales,
  buscarConsultores,
  listSubConsultoresPorPrincipal,
  listSubConsultoresDisponibles,
  asociarSubConsultor,
  desvincularSubConsultor
} = require("../services/consultores.service");

router.get("/consultores", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial", "Talento Humano"] }), listConsultores);
router.get("/consultores/buscar", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }), buscarConsultores);
router.get("/consultores/principales", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial", "Talento Humano"] }), listConsultoresPrincipales);
router.get("/sub-consultores/:principalId", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }), listSubConsultoresPorPrincipal);
router.get("/sub-consultores/disponibles/:principalId", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }), listSubConsultoresDisponibles);
router.post("/sub-consultores/asociar", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }), asociarSubConsultor);
router.delete("/sub-consultores/:asociadoId", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }), desvincularSubConsultor);

module.exports = router;
