const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolveDocumentoIdentidadId } = require("../src/services/documento-identidad.service");

const documentos = [
  { id: 1, public_id: "11111111-1111-4111-8111-111111111111", titulo: "Cédula", codigo: "CC" },
  { id: 2, public_id: "22222222-2222-4222-8222-222222222222", titulo: "Cédula de extranjería", codigo: "CE" },
  { id: 3, public_id: "33333333-3333-4333-8333-333333333333", titulo: "Nit", codigo: "NIT" },
  { id: 4, public_id: "44444444-4444-4444-8444-444444444444", titulo: "Tarjeta de Identidad", codigo: "TI" },
  { id: 5, public_id: "55555555-5555-4555-8555-555555555555", titulo: "Pasaporte", codigo: "PA" },
  { id: 6, public_id: "66666666-6666-4666-8666-666666666666", titulo: "DNI", codigo: "DNI" },
  { id: 7, public_id: "77777777-7777-4777-8777-777777777777", titulo: "Permiso de Protección Temporal", codigo: "PPT" },
  { id: 8, public_id: "88888888-8888-4888-8888-888888888888", titulo: "Otras", codigo: "OT" }
];

function fakeDb() {
  return {
    async query(sql) {
      assert.match(sql, /WHERE activo = true/);
      return { rows: documentos };
    }
  };
}

test("resuelve cualquier documento activo por UUID, título o código", async () => {
  const db = fakeDb();
  for (const documento of documentos) {
    assert.equal(await resolveDocumentoIdentidadId(db, documento.public_id), documento.id);
    assert.equal(await resolveDocumentoIdentidadId(db, documento.titulo), documento.id);
    assert.equal(await resolveDocumentoIdentidadId(db, documento.codigo), documento.id);
  }
});

test("mantiene los nombres antiguos sin confundir extranjería con cédula común", async () => {
  const db = fakeDb();
  assert.equal(await resolveDocumentoIdentidadId(db, "Cedula de Ciudadania"), 1);
  assert.equal(await resolveDocumentoIdentidadId(db, "Cedula de Extranjeria"), 2);
});

test("Reclutamiento usa el catálogo dinámico y envía tipo_documento_id", async (t) => {
  const frontPath = path.resolve(__dirname, "../../front/js/solicitudes-recl.js");
  const viewPath = path.resolve(__dirname, "../../front/views/solicitudesRecl.html");
  const previousWindow = global.window;
  const previousAlert = global.alert;
  t.after(() => {
    global.window = previousWindow;
    global.alert = previousAlert;
    delete require.cache[frontPath];
  });

  global.window = { API_BASE: "http://test" };
  global.alert = () => {};
  delete require.cache[frontPath];
  require(frontPath);

  const app = global.window.solicitudesReclApp();
  app.documentosIdentidad = documentos.map(({ public_id, titulo, codigo }) => ({ id: public_id, titulo, codigo }));
  assert.equal(
    app.resolverTipoDocumentoId({ tipo_documento: "Permiso de Protección Temporal" }),
    documentos[6].public_id
  );

  app.solicitudObjetivo = { id: "solicitud-1" };
  app.formS1 = {
    nombre: "Ada",
    apellidos: "Lovelace",
    tipo_documento_id: documentos[6].public_id,
    numero_documento: "123",
    telefono: "",
    correo_personal: "ada@example.com",
    pais_ubicacion: "Colombia",
    ciudad: "Bogotá",
    moneda: "COP",
    factura_en_colombia: "false",
    tarifa_mes: 100,
    tarifa_hora: ""
  };

  let sentPayload = null;
  app.requestWithApiFallback = async (_method, _route, payload) => { sentPayload = payload; };
  app.cargarPreregistros = async () => {};
  app.hidratarSolicitudesConPreregistro = () => {};
  await app.guardarSeccion1();

  assert.equal(sentPayload.tipo_documento_id, documentos[6].public_id);
  assert.equal(Object.hasOwn(sentPayload, "tipo_documento"), false);

  const view = fs.readFileSync(viewPath, "utf8");
  assert.match(view, /x-for="doc in documentosIdentidad"/);
  assert.doesNotMatch(view, /value="Cedula de Ciudadania"/);
});
