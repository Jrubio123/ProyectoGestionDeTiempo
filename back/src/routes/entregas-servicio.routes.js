const express = require("express");
const { requireAccess } = require("../middlewares/access");
const service = require("../services/entregas-servicio.service");

const router = express.Router();
const ACCESS = requireAccess({ roles: service.ALLOWED_ROLES });
const CREATE = requireAccess({ roles: ["Comercial"] });
const ADMIN = requireAccess({ roles: ["Administrador"] });

router.get("/catalogos", ACCESS, service.getCatalogs);
router.get("/clientes/:clienteId/contactos", ACCESS, service.listClientContacts);
router.get("/", ACCESS, service.listDeliveries);
router.post("/", CREATE, service.createDelivery);
router.get("/:id", ACCESS, service.getDelivery);
router.patch("/:id/asignacion", ADMIN, service.reassignDelivery);
router.patch("/:id/estado", ACCESS, service.updateDeliveryStatus);
router.post("/:id/notificar", ACCESS, service.retryNotification);

module.exports = router;
