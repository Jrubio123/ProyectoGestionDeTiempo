const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const anexoIndividualService = require("../services/anexo-individual.service");

const TH_ACCESS = requireAccess({ roles: ["Administrador", "Talento Humano"] });

router.get("/th/anexo-individual/search", TH_ACCESS, anexoIndividualService.searchAnexoIndividualUsuarios);
router.get("/th/anexo-individual/usuarios/:usuarioId/items", TH_ACCESS, anexoIndividualService.getAnexoIndividualUsuarioItems);
router.get("/th/anexo-individual/items/:itemId", TH_ACCESS, anexoIndividualService.getAnexoIndividualItem);
router.post("/th/anexo-individual/items", TH_ACCESS, anexoIndividualService.createAnexoIndividualItem);
router.patch("/th/anexo-individual/items/:itemId", TH_ACCESS, anexoIndividualService.updateAnexoIndividualItem);
router.patch("/th/anexo-individual/items/:itemId/finalizar", TH_ACCESS, anexoIndividualService.finalizarAnexoIndividualItem);
router.post("/th/anexo-individual/preview-pdf", TH_ACCESS, anexoIndividualService.previewAnexoIndividualPdf);
router.post("/th/anexo-individual/iniciar-firma", TH_ACCESS, anexoIndividualService.iniciarFirmaAnexoIndividual);
router.delete("/th/anexo-individual/cancelar-firma/:tokenId", TH_ACCESS, anexoIndividualService.cancelarFirmaAnexoIndividual);

module.exports = router;
