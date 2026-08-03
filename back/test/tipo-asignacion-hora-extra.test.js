const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function cargarHelperHoraExtra() {
  const indexPath = path.resolve(__dirname, "../src/index.js");
  const source = fs.readFileSync(indexPath, "utf8");
  const start = source.indexOf("function normalizeTipoAsignacionTitulo");
  const end = source.indexOf("function isTipoAsignacionMesa(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const context = vm.createContext({});
  vm.runInContext(
    `${source.slice(start, end)}
     globalThis.__isTipoAsignacionHoraExtra = isTipoAsignacionHoraExtra;`,
    context
  );
  return context.__isTipoAsignacionHoraExtra;
}

test("reconoce los tipos de hora adicional y el alias hora extra", () => {
  const isHoraExtra = cargarHelperHoraExtra();

  for (const titulo of [
    "Hora Adicional Diurna",
    "Hora Adicional Nocturna",
    "Hora Adicional Nocturna Dominical/Festivo",
    "Hora Adicional Diurna Dominical/Festivo",
    "Hora Extra Nocturna"
  ]) {
    assert.equal(isHoraExtra(titulo), true, titulo);
  }

  assert.equal(isHoraExtra("Horas por demanda"), false);
  assert.equal(isHoraExtra("Full time"), false);
});
