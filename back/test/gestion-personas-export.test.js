const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("la exportacion de personas filtra por rol, incluye sin rol y deja auditoria", () => {
  const index = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-12-exportaciones-personas.sql"),
    "utf8"
  );
  const exportStart = index.indexOf('app.get("/admin/personas/exportar"');
  const listStart = index.indexOf('app.get("/admin/personas"', exportStart);
  const route = index.slice(exportStart, listStart);

  assert.ok(exportStart >= 0 && listStart > exportStart);
  assert.match(route, /Administrador.*Talento Humano/);
  assert.match(route, /normalizeValue\(req\.user\?\.rol\) !== "talento humano"/);
  assert.match(route, /__sin_rol__/);
  assert.match(route, /LOWER\(r\.titulo\) = LOWER\(\$1\)/);
  assert.match(route, /INSERT INTO exportaciones_personas_auditoria/);
  assert.doesNotMatch(route, /password_hash/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS exportaciones_personas_auditoria/);
});

test("la interfaz genera XLSX operativo o completo usando el filtro de rol actual", () => {
  const js = fs.readFileSync(
    path.resolve(__dirname, "../../front/js/gestion-personas.js"),
    "utf8"
  );
  const html = fs.readFileSync(
    path.resolve(__dirname, "../../front/views/gestion-personas.html"),
    "utf8"
  );

  assert.match(js, /\/admin\/personas\/exportar/);
  assert.match(js, /params\.rol = this\.filtroRol/);
  assert.match(js, /xlsx\.full\.min\.js/);
  assert.match(js, /XLSX\.writeFile/);
  assert.match(html, /Excel operativo/);
  assert.match(html, /Excel completo \(TH\)/);
});
