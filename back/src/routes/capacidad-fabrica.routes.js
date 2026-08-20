const express = require("express");
const { requireAccess } = require("../middlewares/access");
const service = require("../services/capacidad-fabrica.service");

const router = express.Router();
const MANAGEMENT = requireAccess({ roles: ["Administrador", "Coordinador"] });
const MEMBERSHIP = requireAccess({
  roles: ["Administrador", "Coordinador", "Talento Humano"]
});

router.get("/catalogos", MEMBERSHIP, service.getCatalogs);
router.get("/personas", MEMBERSHIP, service.listPeople);
router.post("/personas/desde-microsoft", MEMBERSHIP, service.materializeMicrosoftPerson);
router.patch("/personas/:id/fabrica", MEMBERSHIP, service.updateFactoryMembership);

router.get("/dashboard", MANAGEMENT, service.getDashboard);
router.get("/requerimientos", MANAGEMENT, service.listRequirements);
router.post("/requerimientos/manual", MANAGEMENT, service.createManualRequirement);
router.patch("/requerimientos/:id", MANAGEMENT, service.updateManualRequirement);
router.put(
  "/requerimientos/:id/distribucion",
  MANAGEMENT,
  service.updateRequirementDistribution
);
router.get("/requerimientos/:id/historial", MANAGEMENT, service.getRequirementHistory);
router.post("/sincronizar-azure", MANAGEMENT, service.syncAzureRequirements);

module.exports = router;
