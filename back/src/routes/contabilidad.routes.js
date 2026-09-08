const express = require("express");
const { requireAccess } = require("../middlewares/access");
const service = require("../services/contabilidad.service");
const operation = require("../services/contabilidad-operacion.service");

const router = express.Router();
const CONTABILIDAD_ACCESS = requireAccess({
  roles: ["Administrador", "Contabilidad", "Talento Humano"]
});

router.use(CONTABILIDAD_ACCESS);

router.get("/proyecciones", operation.listarProyecciones);
router.get("/beneficiarios", operation.buscarBeneficiarios);
router.post("/beneficiarios", operation.crearBeneficiario);
router.put("/beneficiarios/:id/perfil-tributario", operation.actualizarPerfilTributario);
router.get("/catalogos-proveedores", operation.listarCatalogosProveedores);
router.get("/facturas-proveedores", operation.listarFacturas);
router.post("/facturas-proveedores", operation.crearFactura);
router.put("/facturas-proveedores/:id", operation.actualizarFactura);
router.delete("/facturas-proveedores/:id", operation.anularFactura);
router.get("/configuracion/reglas", operation.listarReglas);
router.post("/configuracion/reglas", operation.crearRegla);
router.put("/configuracion/reglas/:id", operation.actualizarRegla);
router.post("/retenciones/simular", service.simularRetenciones);
router.post("/proyeccion/previsualizar", service.previsualizarProyeccion);
router.post("/proyeccion/generar", service.generarProyeccion);
router.post("/proyeccion/:id/agregar-pendientes", service.sincronizarProyeccion);
router.get("/proyeccion/:id/auditoria", operation.consultarAuditoria);
router.get("/proyeccion/:id/exportar-banco", operation.exportarArchivoBancario);
router.get("/proyeccion/:id/detalles", service.getDetallesProyeccion);
router.put("/proyeccion/detalle/:id_detalle/retenciones", service.actualizarRetencionesDetalle);
router.post("/proyeccion/:id/transicion", service.transicionarProyeccion);
router.put("/cuenta_cobro/:id/ciclo", service.actualizarCicloCuentaCobro);

module.exports = router;
