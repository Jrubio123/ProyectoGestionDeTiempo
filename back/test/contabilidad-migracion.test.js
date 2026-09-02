const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(
  path.resolve(__dirname, "../../db/migrations/2026-09-02-contabilidad-proyeccion-pagos.sql"),
  "utf8"
);

test("modela los regímenes tributarios como banderas combinables", () => {
  for (const column of [
    "es_gran_contribuyente",
    "es_autorretenedor",
    "es_regimen_simple",
    "es_entidad_sin_animo_lucro"
  ]) {
    assert.match(
      migration,
      new RegExp(`ADD COLUMN IF NOT EXISTS ${column} BOOLEAN NOT NULL DEFAULT FALSE`, "i")
    );
  }
  assert.doesNotMatch(migration, /ADD COLUMN IF NOT EXISTS regimen_tributario/i);
});

test("migra y retira el régimen único si existía en una instalación anterior", () => {
  assert.match(migration, /column_name = 'regimen_tributario'/);
  assert.match(migration, /DROP COLUMN IF EXISTS regimen_tributario/);
});
