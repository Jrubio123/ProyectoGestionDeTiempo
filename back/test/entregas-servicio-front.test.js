const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.resolve(__dirname, "../../front/js/entregas-servicio.js");

function createApp() {
  global.window = {
    auth: { getRoleKey: () => "comercial" }
  };
  delete require.cache[scriptPath];
  require(scriptPath);
  return global.window.entregasServicioApp();
}

function fillBase(app) {
  app.form.cliente_id = "cliente";
  app.form.coordinador_id = "coordinador";
  app.form.perfil_cliente = "CLAVE";
  app.form.analisis_adaptabilidad = "Adaptable";
  app.form.contacto_nuevo = { nombre: "Contacto", cargo: "Interventor", telefono: "300", email: "" };
  app.form.modulos_ids = ["modulo"];
}

test("el formulario de proyecto valida los campos comerciales", () => {
  const app = createApp();
  fillBase(app);
  app.form.propuesta_url = "https://empresa.com/propuesta.pdf";
  Object.assign(app.form.detalle, {
    nombre_proyecto: "Proyecto Uno",
    objeto_proyecto: "Implementación",
    valor_total: 100,
    forma_pago: "Contado",
    equipo_estimacion: "Equipo comercial",
    tarifas_consultoria: "100/h"
  });
  assert.equal(app.formularioValido, true);
});

test("el frontend exige consultor en outsourcing", () => {
  const app = createApp();
  fillBase(app);
  app.form.tipo_servicio = "OUTSOURCING";
  Object.assign(app.form.detalle, {
    tiempo_descripcion: "6 meses",
    tarifa: 100,
    valor_cliente: 150,
    tiene_contrato: "true"
  });
  assert.equal(app.formularioValido, false);
  app.form.consultores_ids = ["consultor"];
  assert.equal(app.formularioValido, true);
});

test("solo Comercial puede abrir nuevas entregas", () => {
  const app = createApp();
  assert.equal(app.puedeCrear, true);
  global.window.auth.getRoleKey = () => "coordinador";
  assert.equal(app.puedeCrear, false);
  global.window.auth.getRoleKey = () => "admin";
  assert.equal(app.puedeCrear, false);
});

test("adapta el historial al rol que consulta", () => {
  const app = createApp();
  assert.equal(app.historialTitulo, "Mis entregas realizadas");
  global.window.auth.getRoleKey = () => "coordinador";
  assert.equal(app.historialTitulo, "Servicios entregados a mí");
  global.window.auth.getRoleKey = () => "admin";
  assert.equal(app.historialTitulo, "Todas las entregas de servicio");
});
