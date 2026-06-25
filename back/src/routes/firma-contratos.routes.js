const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const firmaContratosService = require("../services/firma-contratos.service");

const TALENTO_HUMANO_ROL = "Talento Humano";
const FIRMA_CONTRATOS_ACCESS = requireAccess({ roles: ["Administrador", TALENTO_HUMANO_ROL] });

router.get("/", FIRMA_CONTRATOS_ACCESS, firmaContratosService.listFirmaContratos);
router.get("/candidatos", FIRMA_CONTRATOS_ACCESS, firmaContratosService.listCandidatos);
router.post("/generar", FIRMA_CONTRATOS_ACCESS, firmaContratosService.generarTokenFirma);
router.get("/datos-laborales", FIRMA_CONTRATOS_ACCESS, firmaContratosService.getDatosLaboralesFirma);
router.put("/datos-laborales", FIRMA_CONTRATOS_ACCESS, firmaContratosService.updateDatosLaboralesFirma);
router.get("/anexo-items", FIRMA_CONTRATOS_ACCESS, firmaContratosService.listAnexoItems);
router.post("/anexo-items", FIRMA_CONTRATOS_ACCESS, firmaContratosService.createAnexoItem);
router.delete("/:id", FIRMA_CONTRATOS_ACCESS, firmaContratosService.deleteFirmaContrato);

module.exports = router;
