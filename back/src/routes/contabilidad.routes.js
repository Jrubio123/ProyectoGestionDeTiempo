const express = require("express");
const { requireAccess } = require("../middlewares/access");
const service = require("../services/contabilidad.service");

const router = express.Router();
const CONTABILIDAD_ACCESS = requireAccess({
  roles: ["Administrador", "Contabilidad", "Talento Humano"]
});

router.use(CONTABILIDAD_ACCESS);

router.post("/retenciones/simular", service.simularRetenciones);
router.post("/proyeccion/generar", service.generarProyeccion);
router.get("/proyeccion/:id/detalles", service.getDetallesProyeccion);
router.put("/proyeccion/detalle/:id_detalle/retenciones", service.actualizarRetencionesDetalle);
router.post("/proyeccion/:id/transicion", service.transicionarProyeccion);
router.put("/cuenta_cobro/:id/ciclo", service.actualizarCicloCuentaCobro);

module.exports = router;
