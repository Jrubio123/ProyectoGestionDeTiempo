const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const {
  PERFIL_MODULO_FALLBACK,
  resolvePerfilModuloConsultoria
} = require("../src/services/contrato-perfil-modulo.service");

const TEMPLATES = [
  ["contratos", "Contrato Prestación de Servicios .docx"],
  ["contratos", "ContratoPrestacionServicioCapital.docx"],
  ["contratos", "Anexo Técnico.docx"],
  ["contratos", "AnexoTecnicoCapital.docx"],
  ["todoSilver", "Contrato Prestación de Servicios.docx"],
  ["todoSilver", "ContratoPrestacionServicioCapital.docx"],
  ["todoSilver", "Anexo Técnico.docx"],
  ["todoSilver", "AnexoTecnicoCapital.docx"]
];

function getTemplatePath(folder, fileName) {
  return path.resolve(__dirname, "../src/static", folder, fileName);
}

function getDocumentText(buffer) {
  const xml = new PizZip(buffer).file("word/document.xml").asText();
  return xml
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

test("resuelve el perfil o modulo que describe la consultoria", () => {
  assert.equal(
    resolvePerfilModuloConsultoria({ modulo_nombre: "BASIS", cargo: "Consultor técnico" }),
    "BASIS"
  );
  assert.equal(
    resolvePerfilModuloConsultoria({}, [
      { modulo_titulo: "ABAP" },
      { modulo_nombre: "BASIS" },
      { modulo_titulo: "abap" }
    ]),
    "ABAP y BASIS"
  );
  assert.equal(
    resolvePerfilModuloConsultoria({ perfilSolicitud: "Consultoría en SAP FI." }),
    "SAP FI"
  );
  assert.equal(resolvePerfilModuloConsultoria(), PERFIL_MODULO_FALLBACK);
});

test("contrato y anexo toman el alcance de los mismos items persistidos", () => {
  const indexSource = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const start = indexSource.indexOf("async function buildContratoTemplatePayload");
  const end = indexSource.indexOf("function isContratoDocPersonaJuridicaCompatible", start);
  const source = indexSource.slice(start, end);

  assert.match(source, /\["contrato_prestacion_servicios", "anexo_tecnico"\]/);
  assert.match(source, /requirePersistedAnexoFromProceso\(proceso, personaContext\)/);
  assert.match(source, /resolvePerfilModuloConsultoria\(personaContext, items\)/);
});

for (const [folder, fileName] of TEMPLATES) {
  test(`${folder}/${fileName} usa el perfil o modulo dinamico`, () => {
    const filePath = getTemplatePath(folder, fileName);
    const binary = fs.readFileSync(filePath);
    const sourceText = getDocumentText(binary);

    assert.match(sourceText, /\{\{PerfilOModulo\}\}/);
    assert.doesNotMatch(sourceText, /SAP ABAP|\[SAP\]|\[\*\*\*\]/);

    const doc = new Docxtemplater(new PizZip(binary), {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: "{{", end: "}}" },
      syntax: { allowUnopenedTag: true, allowUnclosedTag: true },
      nullGetter: () => ""
    });
    doc.render({ PerfilOModulo: "BASIS", items: [] });
    const renderedText = getDocumentText(doc.getZip().generate({ type: "nodebuffer" }));
    assert.match(renderedText, /Consultoría en BASIS/i);
  });
}
