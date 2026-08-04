const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildDatosLaboralesResponse
} = require("../src/services/firma-contratos.service");

test("TH abre datos laborales y hereda tarifa con su moneda aunque aun no exista persona", () => {
  let contextoValidado = null;
  const response = buildDatosLaboralesResponse(
    {
      persona_id: null,
      grupoDistribucion: "Vinculados",
      perfilSolicitud: "ABAP",
      tarifaMes: 13000000,
      moneda: "USD",
      supervisorNombre: "Karla Vanegas",
      fecha_inicio: "2026-09-01",
      ciudad: "Medellín"
    },
    (contexto) => {
      contextoValidado = contexto;
      return ["Tipo de trabajador"];
    }
  );

  assert.equal(response.persona_id, null);
  assert.equal(response.tipo_contratacion_sugerido, "vinculado");
  assert.equal(response.requiere_laboral, true);
  assert.equal(response.datos.cargo, "ABAP");
  assert.equal(response.datos.salario_mensual, 13000000);
  assert.equal(response.datos.salario_moneda, "USD");
  assert.equal(response.datos.jefe_inmediato, "Karla Vanegas");
  assert.equal(response.datos.fecha_inicio_labores, "2026-09-01");
  assert.equal(response.datos.lugar_celebracion, "Medellín");
  assert.equal(contextoValidado.tipo_contrato, "Vinculado");
  assert.deepEqual(response.faltantes, ["Tipo de trabajador"]);
});

test("TH conserva salario y moneda laborales cuando ya fueron definidos", () => {
  const response = buildDatosLaboralesResponse(
    {
      persona_id: 10,
      grupoDistribucion: "Vinculados",
      salarioMensual: 5000000,
      salarioMoneda: "COP",
      tarifaMes: 9000,
      moneda: "USD"
    },
    () => []
  );

  assert.equal(response.datos.salario_mensual, 5000000);
  assert.equal(response.datos.salario_moneda, "COP");
});

test("el formulario usa selección única y limpia accesos técnicos para vinculados", (t) => {
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
  app.form.grupo_distribucion = "Vinculados";
  app.form.vpn_corona = true;
  app.form.necesita_s_user = true;

  app.onGrupoDistribucionChange();
  const payload = app.construirPayload();

  assert.equal(app.grupoDistribucionEsVinculado, true);
  assert.equal(app.form.vpn_corona, false);
  assert.equal(app.form.necesita_s_user, false);
  assert.equal(payload.grupo_distribucion, "Vinculados");
  assert.equal(payload.vpn_corona, false);
  assert.equal(payload.necesita_s_user, false);

  const html = fs.readFileSync(
    path.resolve(__dirname, "../../front/views/preregistrosCoord.html"),
    "utf8"
  );
  assert.match(html, /x-model="form\.grupo_distribucion"/);
  assert.doesNotMatch(html, /grupo_distribucion_todos_silver|grupo_distribucion_vinculados/);
});

test("el backend restringe el grupo y fuerza accesos falsos para vinculados", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/contrataciones-routes.js"),
    "utf8"
  );

  assert.match(source, /new Set\(\["Todos Silver", "Vinculados"\]\)/);
  assert.match(source, /grupoDistribucion === "Vinculados"/);
  assert.match(source, /datosExtra\.vpn_corona = false/);
  assert.match(source, /datosExtra\.necesita_s_user = false/);
  assert.equal(
    source.match(/tipoSolicitud === TIPO_NUEVO && !GRUPOS_DISTRIBUCION_CONTRATACION\.has\(grupoDistribucion\)/g)?.length,
    2
  );
  assert.doesNotMatch(
    source,
    /grupoDistribucion && !GRUPOS_DISTRIBUCION_CONTRATACION\.has\(grupoDistribucion\)/
  );
});

test("editar seccion 2 valida el grupo efectivo y limpia accesos de Vinculados", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/preregistro-routes.js"),
    "utf8"
  );
  const routeStart = source.indexOf('/api/preregistros/:public_id/seccion-2/editar');
  const routeEnd = source.indexOf('/api/preregistros/:public_id/seccion-3', routeStart);
  const routeSource = source.slice(routeStart, routeEnd);

  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(routeSource, /GRUPOS_DISTRIBUCION_CONTRATACION\.has\(grupoDistribucionNorm\)/);
  assert.match(routeSource, /body\.vpn_corona = false/);
  assert.match(routeSource, /body\.necesita_s_user = false/);
  assert.doesNotMatch(source, /\["responsable", "responsables"\]/);
});

test("TH expande datos laborales al recibir Vinculados sin esperar un change manual", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../front/js/firma-contratos-admin.js"),
    "utf8"
  );

  assert.match(
    source,
    /this\.modal\.requiere_laboral = this\.modal\.tipo_contratacion === "vinculado";/
  );
  assert.doesNotMatch(
    source,
    /this\.modal\.requiere_laboral = Boolean\(res\.data\?\.requiere_laboral\);/
  );
});
