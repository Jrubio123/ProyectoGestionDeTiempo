const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const migration = fs.readFileSync(
  path.join(root, "db/migrations/2026-08-31-capacidad-fabrica-v2.sql"),
  "utf8"
);
const multipleBagsMigration = fs.readFileSync(
  path.join(root, "db/migrations/2026-09-03-multiples-bolsas-reuniones.sql"),
  "utf8"
);
const historyMigration = fs.readFileSync(
  path.join(root, "db/migrations/2026-09-09-historial-bolsas-capacidad.sql"),
  "utf8"
);
const routes = fs.readFileSync(
  path.join(root, "back/src/routes/capacidad-fabrica.routes.js"),
  "utf8"
);
const auth = fs.readFileSync(path.join(root, "front/js/auth.js"), "utf8");
const home = fs.readFileSync(path.join(root, "front/views/inicio.html"), "utf8");
const factoryView = fs.readFileSync(path.join(root, "front/views/mi-capacidad-fabrica.html"), "utf8");
const factoryScript = fs.readFileSync(path.join(root, "front/js/mi-capacidad-fabrica.js"), "utf8");

test("crea el rol Fábrica y separa el registro del Inicio", () => {
  assert.match(migration, /VALUES \('Fábrica'/);
  assert.match(auth, /return "fabrica"/);
  assert.match(home, /Silver Consulting/);
  assert.doesNotMatch(home, /Registrar reunión/);
  assert.match(factoryView, /Registrar reunión/);
  assert.match(factoryScript, /mi-reuniones/);
});

test("modela bolsa, movimientos y responsables múltiples", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS bolsas_reuniones_capacidad/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS bolsa_reuniones_movimientos/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS actividad_capacidad_responsables/);
  assert.match(migration, /UNIQUE \(persona_id, semana_inicio\)/);
  assert.match(multipleBagsMigration, /ADD COLUMN IF NOT EXISTS nombre/);
  assert.match(multipleBagsMigration, /DROP CONSTRAINT IF EXISTS uq_bolsa_reuniones_persona_semana/);
  assert.match(historyMigration, /ELIMINADA/);
  assert.match(historyMigration, /consume_bolsa BOOLEAN/);
});

test("expone endpoints separados para coordinador y usuario Fábrica", () => {
  assert.match(routes, /post\("\/bolsas-reuniones", MANAGEMENT/);
  assert.match(routes, /get\("\/mi-capacidad", SELF_FACTORY/);
  assert.match(routes, /post\("\/mi-reuniones", SELF_FACTORY/);
  assert.match(routes, /get\("\/historial", MANAGEMENT/);
  assert.match(routes, /delete\("\/bolsas-reuniones\/:id", MANAGEMENT/);
  assert.match(routes, /patch\("\/actividades\/:id\/cancelar", MANAGEMENT/);
  assert.doesNotMatch(factoryScript, /cancelarActividad/);
  assert.match(factoryScript, /bolsa_id/);
});

test("retira el calendario como fuente de capacidad", () => {
  assert.match(migration, /DROP TABLE IF EXISTS actividades_calendario_capacidad/);
  assert.equal(fs.existsSync(path.join(root, "back/src/services/microsoft-calendar.service.js")), false);
});
