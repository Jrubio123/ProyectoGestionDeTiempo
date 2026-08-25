const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSource = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
const routesSource = fs.readFileSync(path.resolve(__dirname, "../src/contrataciones-routes.js"), "utf8");
const preregistroSource = fs.readFileSync(path.resolve(__dirname, "../src/preregistro-routes.js"), "utf8");
const personaServiceSource = fs.readFileSync(
  path.resolve(__dirname, "../src/services/persona-contratacion.service.js"),
  "utf8"
);

function cargarApp(relativePath, factoryName) {
  const scriptPath = path.resolve(__dirname, relativePath);
  delete require.cache[scriptPath];
  global.window = { API_BASE: "http://test" };
  require(scriptPath);
  return global.window[factoryName]();
}

test("Remoto no se trata como pais en coordinacion ni TH", (t) => {
  const previousWindow = global.window;
  t.after(() => { global.window = previousWindow; });

  const coord = cargarApp("../../front/js/preregistros-coord.js", "preregistrosCoordApp");
  assert.equal(coord.mapSolicitudToForm({ ubicacion: "Remoto", datos_extra: {} }).pais_ubicacion, "");
  assert.equal(coord.mapSolicitudToForm({ ubicacion: "Colombia", datos_extra: {} }).pais_ubicacion, "Colombia");

  const th = cargarApp("../../front/js/onboarding-th.js", "onboardingThApp");
  assert.equal(th.mapContratacionToRegistro({ ubicacion: "Remoto", datos_extra: {} }).pais_ubicacion, null);
  assert.equal(th.mapContratacionToRegistro({ ubicacion: "Colombia", datos_extra: {} }).pais_ubicacion, "Colombia");
});

test("el backend separa modalidad laboral de ciudad y pais de residencia", () => {
  assert.match(indexSource, /normalizeResidenceLocationValue\(solicitud\?\.ubicacion\)/);
  assert.doesNotMatch(routesSource, /ciudad_residencia:\s*solicitudRow\.ubicacion/);
  assert.match(routesSource, /pais_residencia:\s*residencia\.pais/);
  assert.match(preregistroSource, /normalizeResidenceCountry\(pais_ubicacion\)/);
  assert.match(personaServiceSource, /pais_residencia\s+= COALESCE\(EXCLUDED\.pais_residencia/);
});
