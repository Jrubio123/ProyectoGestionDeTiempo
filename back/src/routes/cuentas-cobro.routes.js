const express = require("express");
const { Router } = express;
const { requireAccess } = require("../middlewares/access");
const {
  previewCuentaCobro,
  crearCuentaCobro,
  getHistorialCuentas,
  getAprobadoresCuentas,
  getSoportesCuentas,
  getDetalleCuenta,
  getCuentaPdf,
  uploadAdjuntosCuenta,
  subirSeguridadSocialManual,
  iniciarFirmaCuenta,
  reconciliarFirmaCuenta,
  reiniciarFirmaCuenta,
  adjuntarFirmaCuenta
} = require("../services/cuentas-cobro.service");

const router = Router();
const ROLES_ASOCIADOS = ["Consultor", "Consultor Principal", "Mesa de Servicio"];
const ROLES_LECTURA_AMPLIA = ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador"];
const ROLES_SOPORTES_CUENTAS = ["Administrador", "Coordinador", "Comercial"];
const ROLES_FIRMA_SOPORTES = ["Consultor", "Consultor Principal", "Mesa de Servicio", "Administrador", "Coordinador", "Comercial"];

router.post("/preview", requireAccess({ roles: ROLES_ASOCIADOS, tipos: ["Asociado"] }), previewCuentaCobro);
router.post("/", requireAccess({ roles: ROLES_ASOCIADOS, tipos: ["Asociado"] }), crearCuentaCobro);
router.get("/historial/:userId", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), getHistorialCuentas);
router.get("/aprobadores", requireAccess({ roles: ROLES_SOPORTES_CUENTAS }), getAprobadoresCuentas);
router.get("/soportes", requireAccess({ roles: ROLES_SOPORTES_CUENTAS }), getSoportesCuentas);
router.get("/detalle/:cuentaId", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), getDetalleCuenta);
router.get("/:id/pdf", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), getCuentaPdf);
router.post("/:id/adjuntos", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), uploadAdjuntosCuenta);
router.post("/:id/seguridad-social", requireAccess({ roles: ROLES_SOPORTES_CUENTAS }), subirSeguridadSocialManual);

router.post("/:id/firma/iniciar", requireAccess({ roles: ROLES_FIRMA_SOPORTES, tipos: ["Asociado"] }), iniciarFirmaCuenta);
router.post("/:id/firma/reconciliar", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), reconciliarFirmaCuenta);
router.post("/:id/firma/reiniciar", requireAccess({ roles: ["Talento Humano", "Coordinador"] }), reiniciarFirmaCuenta);
router.post("/:id/firma/adjuntar", requireAccess({ roles: ROLES_LECTURA_AMPLIA, tipos: ["Asociado"] }), adjuntarFirmaCuenta);

module.exports = router;
