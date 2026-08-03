const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("la edición de Mesa/Fábrica fuerza la tarifa vigente en el backend", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/services/registro-asignaciones.service.js"),
    "utf8"
  );

  assert.match(
    source,
    /CASE WHEN c\.es_mesa_fabrica OR c\.es_modalidad_horas THEN c\.tarifa_calculada/
  );
  assert.match(
    source,
    /NOT \(\(SELECT es_mesa_fabrica FROM c_valores\) OR \(SELECT es_modalidad_horas FROM c_valores\)\)/
  );
});

test("editar la tarifa propaga el valor a Mesa/Fábrica abiertas o en proceso", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const start = source.indexOf("// Recalcular asignaciones activas que usan una tarifa administrada por consultor.");
  const end = source.indexOf("const result = await pool.query", start);
  const propagacion = source.slice(start, end);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(propagacion, /ra\.estado IN \('Abierto', 'Proceso'\)/);
  assert.match(propagacion, /LOWER\(ta\.titulo\) LIKE '%mesa%'/);
  assert.match(propagacion, /LOWER\(ta\.titulo\) LIKE '%fabrica%'/);
  assert.match(propagacion, /ELSE ra\.total_pagar/);
});

test("el modal consulta la tarifa vigente al abrir la asignación", async (t) => {
  const frontPath = path.resolve(__dirname, "../../front/js/mis-asignaciones-coordinador.js");
  const previousWindow = global.window;
  const previousAxios = global.axios;
  t.after(() => {
    global.window = previousWindow;
    global.axios = previousAxios;
    delete require.cache[frontPath];
  });

  global.window = { API_BASE: "http://test" };
  global.axios = {
    get: async () => ({ data: { valor_tarifa: 75000 } })
  };
  delete require.cache[frontPath];
  require(frontPath);

  const app = global.window.misAsignacionesApp();
  await app.editarAsignacion({
    id: "asignacion-1",
    cliente: "Alion",
    cliente_id: "cliente-1",
    tipo_asignacion: "Mesa de servicio",
    tipo_asignacion_id: "tipo-1",
    consultor_responsable_id: "consultor-1",
    id_modulo: "modulo-1",
    valor_hora: 70000
  });

  assert.equal(app.form.valor_hora, 75000);
  assert.equal(app.form.valor_dia, 0);
  assert.equal(app.tarifaEncontrada, true);

  await app.editarAsignacion({
    id: "asignacion-2",
    cliente: "Corona",
    cliente_id: "cliente-2",
    tipo_asignacion: "Fábrica",
    tipo_asignacion_id: "tipo-2",
    consultor_responsable_id: "consultor-1",
    id_modulo: "modulo-1",
    valor_hora: 70000
  });
  assert.equal(app.form.valor_hora, 75000);
});

test("aprobar Mesa/Fábrica recalcula el total con la tarifa vigente", async (t) => {
  const dbPath = require.resolve("../src/db");
  const indexPath = require.resolve("../src/index");
  const servicePath = require.resolve("../src/services/reportes.service");
  const previousDb = require.cache[dbPath];
  const previousIndex = require.cache[indexPath];
  const previousService = require.cache[servicePath];
  t.after(() => {
    if (previousDb) require.cache[dbPath] = previousDb;
    else delete require.cache[dbPath];
    if (previousIndex) require.cache[indexPath] = previousIndex;
    else delete require.cache[indexPath];
    if (previousService) require.cache[servicePath] = previousService;
    else delete require.cache[servicePath];
  });

  let tipoActual = "Mesa de servicio";
  const totalesEnviadosAlUpdate = [];
  const client = {
    async query(sql, params = []) {
      const query = String(sql).replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) return { rows: [] };
      if (query.includes("tarifa.valor_tarifa AS tarifa_consultor")) {
        return {
          rows: [{
            id: 10,
            horas_reportadas: 2,
            tipo_asignacion_titulo: tipoActual,
            tarifa_consultor: 75000
          }]
        };
      }
      if (query.includes("UPDATE reporte_horas") && query.includes("total_cobrar = COALESCE")) {
        totalesEnviadosAlUpdate.push(params[4]);
        return { rows: [{ id: 10, id_registro_asignacion: 20, total_cobrar: params[4] }] };
      }
      if (query.includes("SELECT rh.id") && query.includes("con.coordinador_responsable_id")) {
        return { rows: [{ id: 10 }] };
      }
      if (query.includes("ra.horas_asignadas") && query.includes("tipo_asignacion_titulo")) {
        return { rows: [{ id_tipo_asignacion: 1, tipo_asignacion_titulo: tipoActual }] };
      }
      if (query.startsWith("UPDATE registro_asignaciones")) return { rows: [] };
      throw new Error(`Consulta inesperada: ${query}`);
    },
    release() {}
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [] })
  };
  const helpers = {
    getEstadoAsignacionValues: async () => ({ abierto: "Abierto", proceso: "Proceso", cerrado: "Cerrado" }),
    getMesaFabricaScope: () => tipoActual === "Fábrica" ? "fabrica" : "mesa",
    normalizeTipoAsignacionTitulo: (value) => String(value || "").toLowerCase(),
    isTipoAsignacionMensual: () => false,
    isTipoAsignacionTiempoCostoFijo: () => false,
    toBooleanInput: () => false,
    isTipoAsignacionHoraExtra: () => false,
    isTipoAsignacionHorasPorDemanda: () => false,
    toNullableNumber: (value) => value === null || value === undefined ? null : Number(value),
    buildReporteResumen: () => "",
    isTipoAsignacionMesaOFabrica: (value) => {
      const tipo = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return tipo.includes("mesa") || tipo.includes("fabrica");
    },
    buildPortalUrl: () => "http://test",
    sendEmailSafe: async () => {},
    getGraphContext: () => ({}),
    buildEmailLayout: () => "",
    isGuid: () => true,
    withPublicId: (value) => value
  };

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };
  require.cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true, exports: helpers };
  delete require.cache[servicePath];
  const { actualizarAprobacion } = require(servicePath);

  let responseBody;
  const res = {
    status() { return this; },
    json(value) { responseBody = value; return value; }
  };
  for (const [index, tipo] of ["Mesa de servicio", "Fábrica"].entries()) {
    tipoActual = tipo;
    await actualizarAprobacion(
      {
        params: { id: `reporte-${index + 1}` },
        body: { estado: "Aprobado" },
        user: { id: 99, rol: "Administrador" }
      },
      res
    );
  }

  assert.deepEqual(totalesEnviadosAlUpdate, [150000, 150000]);
  assert.equal(responseBody.total_cobrar, 150000);
});
