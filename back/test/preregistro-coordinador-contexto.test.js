const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("precarga el cliente libre como prospecto y conserva su nombre al guardar", (t) => {
  const frontPath = path.resolve(__dirname, "../../front/js/preregistros-coord.js");
  const previousWindow = global.window;
  t.after(() => {
    global.window = previousWindow;
    delete require.cache[frontPath];
  });

  global.window = { API_BASE: "http://test" };
  delete require.cache[frontPath];
  require(frontPath);
  const app = global.window.preregistrosCoordApp();
  const form = app.mapSolicitudToForm({
    tipo_solicitud: "Nuevo",
    datos_extra: { cliente_nombre: "Silver Consulting" }
  });

  assert.equal(form.cliente_id, "__prospecto__");
  assert.equal(form.cliente_nombre_prospecto, "Silver Consulting");

  app.tipoModal = "Nuevo";
  app.form = form;
  const payload = app.construirPayload();
  assert.equal(payload.cliente_id, null);
  assert.equal(payload.datos_extra.cliente_nombre, "Silver Consulting");
});

test("un supervisor de Entra sin usuario local se conserva por OID, nombre y correo", (t) => {
  const frontPath = path.resolve(__dirname, "../../front/js/preregistros-coord.js");
  const previousWindow = global.window;
  t.after(() => {
    global.window = previousWindow;
    delete require.cache[frontPath];
  });

  global.window = { API_BASE: "http://test" };
  delete require.cache[frontPath];
  require(frontPath);
  const app = global.window.preregistrosCoordApp();
  app.tipoModal = "Nuevo";
  app.seleccionarSupervisorTenant({
    usuario_id: null,
    azure_oid: "entra-oid-123",
    nombre_usuario: "Supervisora Externa",
    email: "supervisora@silverconsulting.com.co"
  });

  const payload = app.construirPayload();
  assert.equal(payload.supervisor_id, null);
  assert.equal(payload.datos_extra.supervisor_azure_oid, "entra-oid-123");
  assert.equal(payload.datos_extra.supervisor_nombre, "Supervisora Externa");
  assert.equal(payload.datos_extra.supervisor_email, "supervisora@silverconsulting.com.co");
});

test("la vista busca supervisores en Microsoft 365 y el backend devuelve el contexto libre", () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, "../../front/views/preregistrosCoord.html"),
    "utf8"
  );
  const routes = fs.readFileSync(
    path.resolve(__dirname, "../src/contrataciones-routes.js"),
    "utf8"
  );
  const index = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");

  assert.match(html, /Buscar responsable \/ supervisor en Microsoft 365/);
  assert.doesNotMatch(html, /x-for="sup in supervisores"/);
  assert.match(routes, /row\.cliente_nombre \|\| toNullableString\(datosExtra\.cliente_nombre\)/);
  assert.match(routes, /datosExtra\.supervisor_azure_oid/);
  assert.match(index, /public_id::text AS usuario_id, azure_oid, LOWER\(email\) AS email/);
});

test("Solicitud Nuevo reactiva la persona y el anexo permite consultar inactivos", () => {
  const routes = fs.readFileSync(
    path.resolve(__dirname, "../src/contrataciones-routes.js"),
    "utf8"
  );
  const anexoService = fs.readFileSync(
    path.resolve(__dirname, "../src/services/anexo-individual.service.js"),
    "utf8"
  );
  const index = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const coordHtml = fs.readFileSync(
    path.resolve(__dirname, "../../front/views/preregistrosCoord.html"),
    "utf8"
  );
  const thHtml = fs.readFileSync(
    path.resolve(__dirname, "../../front/views/onboardingTH.html"),
    "utf8"
  );

  assert.equal((routes.match(/persona_reactivada AS/g) || []).length, 2);
  assert.match(routes, /SET estado = 'activo', updated_at = NOW\(\)/);
  assert.match(routes, /SET activo = true, updated_at = NOW\(\)/);

  const searchSource = anexoService.slice(
    anexoService.indexOf("async function searchAnexoIndividualUsuarios"),
    anexoService.indexOf("async function getAnexoIndividualUsuarioItems")
  );
  assert.doesNotMatch(searchSource, /u\.activo = true/);
  assert.match(searchSource, /COALESCE\(u\.activo, false\) AS activo/);

  const resolverSource = index.slice(
    index.indexOf("async function getUsuarioAnexoIndividualById"),
    index.indexOf("async function resolveSuggestedAnexoFirmanteEmailForUser")
  );
  assert.doesNotMatch(resolverSource, /AND u\.activo = true/);
  assert.match(coordHtml, /Se reactivara al crear la solicitud nueva/);
  assert.match(thHtml, /activas o inactivas/);
});
