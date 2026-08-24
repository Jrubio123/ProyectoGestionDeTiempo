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
