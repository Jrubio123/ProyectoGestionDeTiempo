const express = require("express");
const { requireAccess } = require("../middlewares/access");
const service = require("../services/capacidad-fabrica.service");

const router = express.Router();
const MANAGEMENT = requireAccess({ roles: ["Administrador", "Coordinador"] });
const SELF_FACTORY = requireAccess({ roles: ["Fábrica"] });
const CATALOGS = requireAccess({
  roles: ["Administrador", "Coordinador", "Talento Humano", "Fábrica"]
});
const MEMBERSHIP = requireAccess({
  roles: ["Administrador", "Coordinador", "Talento Humano"]
});

router.get("/catalogos", CATALOGS, service.getCatalogs);
router.get("/personas", MEMBERSHIP, service.listPeople);
router.post("/personas/desde-microsoft", MEMBERSHIP, service.materializeMicrosoftPerson);
router.patch("/personas/:id/fabrica", MEMBERSHIP, service.updateFactoryMembership);

router.get("/dashboard", MANAGEMENT, service.getDashboard);
router.post("/bolsas-reuniones", MANAGEMENT, service.assignMeetingBags);
router.get("/bolsas-reuniones/:id/movimientos", MANAGEMENT, service.getMeetingBagHistory);
router.get("/mi-capacidad", SELF_FACTORY, service.getMyCapacity);
router.post("/mi-reuniones", SELF_FACTORY, service.createMyMeeting);
router.patch("/actividades/:id/cancelar", MANAGEMENT, service.cancelCapacityActivity);
router.get("/requerimientos", MANAGEMENT, service.listRequirements);
router.post("/requerimientos/manual", MANAGEMENT, service.createManualRequirement);
router.post("/actividades/manual", MANAGEMENT, service.createManualActivity);
router.patch("/requerimientos/:id", MANAGEMENT, service.updateManualRequirement);
router.put(
  "/requerimientos/:id/distribucion",
  MANAGEMENT,
  service.updateRequirementDistribution
);
router.get("/requerimientos/:id/historial", MANAGEMENT, service.getRequirementHistory);
router.post("/sincronizar-azure", MANAGEMENT, service.syncAzureRequirements);

module.exports = router;
