const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function cargarApp(t) {
  const frontPath = path.resolve(__dirname, "../../front/js/preregistros-coord.js");
  const previousWindow = global.window;
  t.after(() => {
    global.window = previousWindow;
    delete require.cache[frontPath];
  });
  global.window = { API_BASE: "http://test" };
  delete require.cache[frontPath];
  require(frontPath);
  return global.window.preregistrosCoordApp();
}

test("Extension sin anexo exige datos del primer anexo y conserva el tipo de solicitud", (t) => {
  const app = cargarApp(t);
  app.tipoModal = "Extension";
  app.seleccionarPersona({
    usuario_id: "usuario-1",
    nombre_usuario: "Ana Perez",
    numero_documento: "123",
    correo_personal: "ana@example.com",
    moneda: "COP",
    perfil: "SAP",
    modulo_id: "modulo-1",
    tipo_asignacion: "horas",
    tarifa_hora: 100,
    anexos_activos: []
  });

  assert.equal(app.extensionSinAnexoActivo, true);
  assert.equal(app.form.tipo_asignacion, "");
  assert.equal(app.form.tarifa_hora, "");
  assert.ok(app.validarFormulario().includes("Tipo de asignacion"));
  assert.ok(app.validarFormulario().includes("Fecha de inicio del anexo"));

  app.form.tipo_asignacion = "full_time";
  app.form.tarifa_mes = 5000000;
  app.form.fecha_extension_desde = "2026-10-01";
  app.form.fecha_extension_hasta = "2026-12-31";
  app.form.cliente_id = "cliente-1";

  assert.deepEqual(app.validarFormulario(), []);
  const payload = app.construirPayload();
  assert.equal(payload.tipo_solicitud, "Extension");
  assert.equal(payload.modalidad_contrato, "Full time");
  assert.equal(payload.datos_extra.tipo_asignacion, "full_time");
});

test("Extension autocompleta tipo y tarifa desde el anexo activo", (t) => {
  const app = cargarApp(t);
  app.tipoModal = "Extension";
  app.seleccionarPersona({
    usuario_id: "usuario-2",
    nombre_usuario: "Luis Mora",
    numero_documento: "456",
    correo_personal: "luis@example.com",
    moneda: "USD",
    perfil: "Oracle",
    modulo_id: "modulo-2",
    anexos_activos: [{
      id: "anexo-1",
      tipo_asignacion: "horas",
      tipo_asignacion_label: "Horas",
      valor_tarifa: 85,
      moneda: "USD",
      modulo_id: "modulo-2",
      modulo_nombre: "Oracle",
      fecha_inicio: "2026-01-01",
      fecha_fin: "2026-12-31"
    }]
  });

  assert.equal(app.extensionSinAnexoActivo, false);
  assert.equal(app.anexoSeleccionadoId, "anexo-1");
  assert.equal(app.form.tipo_asignacion, "horas");
  assert.equal(app.form.tarifa_hora, 85);
});

test("backend valida y persiste el anexo de Extension sin iniciar firma contractual", () => {
  const routes = fs.readFileSync(
    path.resolve(__dirname, "../src/contrataciones-routes.js"),
    "utf8"
  );
  const index = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");

  assert.match(routes, /function validateExtensionAnexoRequest/);
  assert.match(routes, /La persona no tiene un anexo activo; debes seleccionar el tipo de asignacion/);
  assert.equal(
    (routes.match(/strict: tipoSolicitud === TIPO_NUEVO \|\| tipoSolicitud === TIPO_EXTENSION/g) || []).length,
    2
  );

  const extensionDispatch = routes.slice(
    routes.indexOf("if (solicitud.tipo_solicitud === TIPO_EXTENSION)"),
    routes.indexOf("if (solicitud.tipo_solicitud === TIPO_RETIRO)")
  );
  assert.match(extensionDispatch, /buildMailThExtension/);
  assert.doesNotMatch(extensionDispatch, /ClickSign|firmar|sendMail\([^,]+,\s*solicitud\.correo/);

  const syncExtension = index.slice(
    index.indexOf("async function syncExtensionAnexoFromContext"),
    index.indexOf("function buildAnexoItemForTemplateRow")
  );
  assert.match(syncExtension, /if \(!currentItem\)/);
  assert.match(syncExtension, /insertAnexoTecnicoItem\(payload\)/);
  assert.match(syncExtension, /const fechaFinExtension = normalizeDateOnlyInput\(personaContext\?\.fecha_extension_hasta\)/);
  assert.match(syncExtension, /if \(fechaFinExtension\)/);
});
