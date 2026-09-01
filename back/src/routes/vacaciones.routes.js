const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireAccess, requireAuthenticated } = require("../middlewares/access");
const service = require("../services/vacaciones.service");

const router = express.Router();
const CONFIG_ACCESS = requireAccess({
  roles: ["Administrador", "Talento Humano", "Administrativo"]
});
const APPROVAL_LIMIT = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

router.get("/aprobacion/:token", APPROVAL_LIMIT, service.showApproval);
router.post("/aprobacion/:token", APPROVAL_LIMIT, service.decideFromEmail);

router.get("/contexto", requireAuthenticated, service.getContext);
router.get("/personas", requireAuthenticated, service.searchPeople);
router.post("/calcular", requireAuthenticated, service.calculate);
router.get("/solicitudes", requireAuthenticated, service.listRequests);
router.post("/solicitudes", requireAuthenticated, service.createRequest);
router.patch("/solicitudes/:id/decision", requireAuthenticated, service.decideFromApp);

router.get("/configuracion/destinatarios", CONFIG_ACCESS, service.getNotificationConfig);
router.put("/configuracion/destinatarios", CONFIG_ACCESS, service.updateNotificationConfig);

module.exports = router;
