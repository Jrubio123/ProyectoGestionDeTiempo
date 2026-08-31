const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const scriptPath = path.resolve(__dirname, "../../front/js/capacidad-fabrica.js");

function createApp() {
  global.window = {};
  delete require.cache[scriptPath];
  require(scriptPath);
  return global.window.capacidadFabricaApp();
}

test("calcula las horas cuando cambia el porcentaje", () => {
  const app = createApp();
  const item = { porcentaje: 0, horas: 0 };

  app.updateFromPercentage(item, "55", 80);

  assert.equal(item.porcentaje, 55);
  assert.equal(item.horas, 44);
});

test("calcula el porcentaje cuando cambian las horas", () => {
  const app = createApp();
  const item = { porcentaje: 0, horas: 0 };

  app.updateFromHours(item, "44", 80);

  assert.equal(item.horas, 44);
  assert.equal(item.porcentaje, 55);
});

test("exige que porcentajes y horas completen el Effort", () => {
  const app = createApp();
  const distribution = [
    { porcentaje: 55, horas: 44 },
    { porcentaje: 45, horas: 36 }
  ];

  assert.equal(app.distributionIsValid(distribution, 80), true);
  distribution[1].horas = 35;
  assert.equal(app.distributionIsValid(distribution, 80), false);
});

test("recalcula las horas manuales cuando cambia el Effort", () => {
  const app = createApp();
  app.manual = {
    effort_total: "",
    distribucion: [{ porcentaje: 25, horas: null }]
  };

  app.updateManualEffort("80");

  assert.equal(app.manual.effort_total, 80);
  assert.equal(app.manual.distribucion[0].horas, 20);
});

test("inicializa una actividad puntual de estimación", () => {
  const app = createApp();
  app.weekDate = "2026-08-31";
  app.catalogos.categorias = [
    { codigo: "REUNIONES", nombre: "Reuniones" },
    { codigo: "ESTIMACION", nombre: "Estimación" }
  ];

  app.abrirActividad();

  assert.equal(app.modalActividad, true);
  assert.equal(app.actividad.categoria_codigo, "ESTIMACION");
  assert.equal(app.actividad.fecha, "2026-08-31");
  assert.equal(app.actividad.cliente_id, "");
});

test("limita los estados disponibles para actividades puntuales", () => {
  const app = createApp();
  app.catalogos.estados = [
    { codigo: "PLANIFICADO" },
    { codigo: "EN_DESARROLLO" },
    { codigo: "CERRADO" },
    { codigo: "CANCELADO" }
  ];

  assert.deepEqual(
    app.estadosParaItem({ tipo_registro: "ACTIVIDAD" }).map((item) => item.codigo),
    ["PLANIFICADO", "CERRADO", "CANCELADO"]
  );
});

test("bloquea actividades puntuales cerradas o canceladas", () => {
  const app = createApp();

  assert.equal(app.actividadFinalizada({ tipo_registro: "ACTIVIDAD", estado_codigo: "CERRADO" }), true);
  assert.equal(app.actividadFinalizada({ tipo_registro: "ACTIVIDAD", estado_codigo: "CANCELADO" }), true);
  assert.equal(app.actividadFinalizada({ tipo_registro: "ACTIVIDAD", estado_codigo: "PLANIFICADO" }), false);
  assert.equal(app.actividadFinalizada({ tipo_registro: "REQUERIMIENTO", estado_codigo: "CERRADO" }), false);
});
