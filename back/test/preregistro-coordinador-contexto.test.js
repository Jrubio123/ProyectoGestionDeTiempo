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

test("Retiro conserva el coordinador valido cuando la persona solo trae el nombre del supervisor", (t) => {
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
  app.tipoModal = "Retiro";
  app.form.supervisor_id = "coordinador-1";
  app.form.supervisor_nombre = "Coordinador actual";
  app.form.supervisor_email = "coordinador@silver.test";
  app.busquedaSupervisor = "Coordinador actual";

  app.poblarFormularioDesdePersona({
    nombre_usuario: "Persona Consultora",
    supervisor_nombre: "Referencia historica sin ID"
  });

  assert.equal(app.form.supervisor_id, "coordinador-1");
  assert.equal(app.form.supervisor_nombre, "Coordinador actual");
  assert.equal(app.busquedaSupervisor, "Coordinador actual");
});

test("Nuevo exige tipo y fecha fin, proponiendo el 31 de diciembre editable", (t) => {
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
  app.abrirModal("Nuevo");
  assert.match(app.form.fecha_fin, /^\d{4}-12-31$/);

  app.form.fecha_inicio = "2027-02-03";
  app.onFechaInicioNuevoChange();
  assert.equal(app.form.fecha_fin, "2027-12-31");

  app.form.fecha_fin = "2027-06-30";
  app.form.fecha_inicio = "2027-03-01";
  app.onFechaInicioNuevoChange();
  assert.equal(app.form.fecha_fin, "2027-06-30");

  app.form.tipo_asignacion = "";
  assert.ok(app.validarFormulario().includes("Tipo de asignacion"));
});

test("la vista busca supervisores en Microsoft 365 y el backend devuelve el contexto libre", () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, "../../front/views/preregistrosCoord.html"),
    "utf8"[capacidad - fabrica.js](c: /Users/JuanPabloRubioMejía / Downloads / ProyectosDesarrollo / ProyectoGestionDeTiempo / front / js / capacidad - fabrica.js)
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

test("Solicitud Nuevo persiste el anexo antes de enviar correos y acepta cliente prospecto", () => {
  const routes = fs.readFileSync(
    path.resolve(__dirname, "../src/contrataciones-routes.js"),
    "utf8"
  );
  const index = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-12-anexo-cliente-prospecto.sql"),
    "utf8"
  );

  const createStart = routes.indexOf('"/contrataciones/solicitudes"');
  const completeStart = routes.indexOf('"/contrataciones/solicitudes/:id/completar"');
  const createSource = routes.slice(createStart, completeStart);
  assert.ok(createStart >= 0 && completeStart > createStart);
  assert.ok(createSource.indexOf("strict: tipoSolicitud === TIPO_NUEVO") < createSource.indexOf("dispatchAndFinalizeSolicitud"));
  assert.match(createSource, /DELETE FROM solicitudes_contratacion WHERE id = \$1/);
  assert.match(createSource, /missing\.push\("tipo_asignacion"\)/);
  assert.match(createSource, /missing\.push\("fecha_fin"\)/);
  assert.match(index, /!resolvedClienteId && !resolvedClienteNombre/);
  assert.match(migration, /NULLIF\(BTRIM\(cliente_nombre\), ''\) IS NOT NULL/);
});

test("el anexo manual reactiva y solo Admin puede cambiar el estado de un consultor", () => {
  const anexoService = fs.readFileSync(
    path.resolve(__dirname, "../src/services/anexo-individual.service.js"),
    "utf8"
  );
  const index = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const gestionJs = fs.readFileSync(
    path.resolve(__dirname, "../../front/js/gestion-consultores.js"),
    "utf8"
  );
  const gestionHtml = fs.readFileSync(
    path.resolve(__dirname, "../../front/views/gestion-consultores.html"),
    "utf8"
  );

  const createSource = anexoService.slice(
    anexoService.indexOf("async function createAnexoIndividualItem"),
    anexoService.indexOf("async function updateAnexoIndividualItem")
  );
  assert.match(createSource, /persona_reactivada AS/);
  assert.match(createSource, /usuario_reactivado AS/);
  assert.match(createSource, /SET estado = 'activo', updated_at = NOW\(\)/);
  assert.match(createSource, /SET activo = true, updated_at = NOW\(\)/);

  const listSource = index.slice(
    index.indexOf('app.get("/admin/consultores"'),
    index.indexOf('app.post("/admin/consultores"')
  );
  const detailSource = index.slice(
    index.indexOf('app.get("/admin/consultores/:id"'),
    index.indexOf('app.get("/admin/personas/:id"')
  );
  const identitySource = index.slice(
    index.indexOf('app.put("/admin/personas/:id/identidad"'),
    index.indexOf('app.put("/admin/personas/:id/personal"')
  );
  assert.doesNotMatch(listSource, /WHERE u\.activo = true/);
  assert.doesNotMatch(detailSource, /AND u\.activo = true/);
  assert.match(identitySource, /normalizeValue\(req\.user\?\.rol\) !== "administrador"/);
  assert.match(identitySource, /estado = CASE WHEN \$4::boolean THEN 'activo' ELSE 'inactivo' END/);
  assert.match(gestionJs, /this\.puedeCambiarEstado = roleKey === "admin"/);
  assert.match(gestionHtml, /x-show="puedeCambiarEstado"/);
});
