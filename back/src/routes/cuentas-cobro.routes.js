const express = require("express");
const { Router } = express;
const { requireAccess } = require("../middlewares/access");
const {
  previewCuentaCobro,
  crearCuentaCobro,
  getHistorialCuentas,
  getSoportesCuentas,
  getDetalleCuenta,
  getCuentaPdf,
  uploadAdjuntosCuenta,
  iniciarFirmaCuenta,
  reconciliarFirmaCuenta,
  adjuntarFirmaCuenta
} = require("../services/cuentas-cobro.service");

const router = Router();
const ROLES_ASOCIADOS = ["Consultor", "Consultor Principal", "Mesa de Servicio"];
const ROLES_LECTURA_AMPLIA = ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"];

router.post("/preview", requireAccess({ roles: ROLES_ASOCIADOS, tipos: ["Asociado"] }), previewCuentaCobro);
router.post("/", requireAccess({ roles: ROLES_ASOCIADOS, tipos: ["Asociado"] }), crearCuentaCobro);
router.get("/historial/:userId", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), getHistorialCuentas);
router.get("/soportes", requireAccess({ roles: ["Administrador", "Coordinador"] }), getSoportesCuentas);
router.get("/detalle/:cuentaId", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), getDetalleCuenta);
router.get("/:id/pdf", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), getCuentaPdf);
router.post("/:id/adjuntos", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), uploadAdjuntosCuenta);

router.post("/:id/firma/iniciar", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), iniciarFirmaCuenta);
router.post("/:id/firma/reconciliar", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), reconciliarFirmaCuenta);
router.post("/:id/firma/adjuntar", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), adjuntarFirmaCuenta);

module.exports = router;
