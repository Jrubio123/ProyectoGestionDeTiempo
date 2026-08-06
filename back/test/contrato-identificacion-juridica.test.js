const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function recorte(source, desde, hasta) {
  const start = source.indexOf(desde);
  const end = source.indexOf(hasta, start);
  assert.notEqual(start, -1, `no se encontró: ${desde}`);
  assert.notEqual(end, -1, `no se encontró: ${hasta}`);
  return source.slice(start, end);
}

function cargarValidador() {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  // Objeto compartido por referencia entre el host y el VM: una funcion creada aqui
  // no puede leer el globalThis del contexto.
  const plantilla = { xml: "" };
  const context = vm.createContext({
    toNullableTrimmedString(value) {
      const texto = String(value ?? "").trim();
      return texto || null;
    },
    getDocxTemplateBinary: () => "binario-simulado",
    PizZip: function PizZipFake() {
      return { file: () => ({ asText: () => plantilla.xml }) };
    }
  });

  vm.runInContext(
    [
      recorte(source, "const CONTRATO_DOCS_SIN_IDENTIFICACION_JURIDICA", "const CONTRATO_DOC_DEFINITIONS_BY_KEY"),
      recorte(source, "function isContratoDocPersonaJuridicaCompatible", "async function generateContratoPdfFromTemplate"),
      "globalThis.__esCompatible = isContratoDocPersonaJuridicaCompatible;"
    ].join("\n"),
    context
  );

  return {
    esCompatible: context.__esCompatible,
    setXml: (xml) => { plantilla.xml = xml; }
  };
}

const PLANTILLA_SIN_MARCADORES = "<w:t>Contrato entre las partes sin identificacion juridica</w:t>";

test("los documentos que no identifican a la parte quedan exentos", () => {
  const { esCompatible, setXml } = cargarValidador();
  setXml(PLANTILLA_SIN_MARCADORES);

  for (const docKey of [
    // Autorizaciones: las firma una persona natural sobre sus propios datos.
    "autorizacion_datos_personales",
    "autorizacion_datos_personales_vinculado",
    "autorizacion_datos_sensibles_vinculado",
    // Politica de garantia: toma la definicion de EL CONTRATISTA del contrato al que se adhiere.
    "politica_garantia"
  ]) {
    assert.equal(
      esCompatible({ doc_key: docKey, template_file: "cualquiera.docx" }),
      true,
      docKey
    );
  }
});

test("la exención no depende de la plantilla: aplica incluso sin template_file", () => {
  const { esCompatible } = cargarValidador();
  assert.equal(esCompatible({ doc_key: "autorizacion_datos_personales" }), true);
});

test("un contrato sin marcadores sigue bloqueado", () => {
  const { esCompatible, setXml } = cargarValidador();
  setXml(PLANTILLA_SIN_MARCADORES);

  for (const docKey of [
    "contrato_prestacion_servicios",
    "acuerdo_confidencialidad",
    "anexo_tecnico",
    "cl_termino_indefinido"
  ]) {
    assert.equal(
      esCompatible({ doc_key: docKey, template_file: "cualquiera.docx" }),
      false,
      docKey
    );
  }
});

test("un contrato con ContratistaComparecencia pasa", () => {
  const { esCompatible, setXml } = cargarValidador();
  setXml("<w:t>y por otra parte, {{ContratistaComparecencia}}, quien en adelante</w:t>");

  assert.equal(
    esCompatible({ doc_key: "acuerdo_confidencialidad", template_file: "cualquiera.docx" }),
    true
  );
});

test("un contrato con el trio de identificacion legal pasa", () => {
  const { esCompatible, setXml } = cargarValidador();
  setXml(
    "<w:t>Nombre: {{ContratistaNombreLegal}}</w:t>" +
    "<w:t>{{ContratistaDocumentoEtiqueta}}: {{ContratistaDocumentoLegal}}</w:t>"
  );

  assert.equal(
    esCompatible({ doc_key: "anexo_tecnico", template_file: "cualquiera.docx" }),
    true
  );
});

test("el trio incompleto no alcanza", () => {
  const { esCompatible, setXml } = cargarValidador();
  setXml("<w:t>Nombre: {{ContratistaNombreLegal}}</w:t>");

  assert.equal(
    esCompatible({ doc_key: "anexo_tecnico", template_file: "cualquiera.docx" }),
    false
  );
});
