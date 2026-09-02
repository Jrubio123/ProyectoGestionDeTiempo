const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireAccess } = require("../middlewares/access");
const service = require("../services/vacaciones.service");

const router = express.Router();
const CONFIG_ACCESS = requireAccess({
  roles: ["Administrador", "Talento Humano", "Administrativo"]
});
const VACATION_ACCESS = requireAccess({
  roles: [
    "Administrador",
    "Administrativo",
    "Talento Humano",
    "Coordinador",
    "Comercial",
    "Reclutador",
    "Contabilidad",
    "Fábrica"
  ]
});
const APPROVAL_LIMIT = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

router.get("/aprobacion/:token", APPROVAL_LIMIT, service.showApproval);
router.post("/aprobacion/:token", APPROVAL_LIMIT, service.decideFromEmail);

router.get("/contexto", VACATION_ACCESS, service.getContext);
router.get("/dias-disponibles", VACATION_ACCESS, service.getAvailableDays);
router.get("/personas", VACATION_ACCESS, service.searchPeople);
router.post("/calcular", VACATION_ACCESS, service.calculate);
router.get("/solicitudes", VACATION_ACCESS, service.listRequests);
router.post("/solicitudes", VACATION_ACCESS, service.createRequest);
router.patch("/solicitudes/:id/decision", VACATION_ACCESS, service.decideFromApp);

router.get("/configuracion/destinatarios", CONFIG_ACCESS, service.getNotificationConfig);
router.put("/configuracion/destinatarios", CONFIG_ACCESS, service.updateNotificationConfig);

module.exports = router;
