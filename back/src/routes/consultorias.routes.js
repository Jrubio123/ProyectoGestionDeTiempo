const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const {
  listConsultorias,
  crearConsultoria,
  actualizarConsultoria,
  eliminarConsultoria
} = require("../services/consultorias.service");

router.get("/", requireAccess({ roles: ["Administrador", "Coordinador"] }), listConsultorias);
router.post("/", requireAccess({ roles: ["Administrador"] }), crearConsultoria);
router.put("/:id", requireAccess({ roles: ["Administrador"] }), actualizarConsultoria);
router.delete("/:id", requireAccess({ roles: ["Administrador"] }), eliminarConsultoria);

module.exports = router;
