const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const PizZip = require("pizzip");

const indexSource = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
const frontSource = fs.readFileSync(path.resolve(__dirname, "../../front/js/contratacion-publica.js"), "utf8");

function recorte(source, desde, hasta) {
  const start = source.indexOf(desde);
  const end = source.indexOf(hasta, start);
  assert.notEqual(start, -1, `no se encontro: ${desde}`);
  assert.notEqual(end, -1, `no se encontro: ${hasta}`);
  return source.slice(start, end);
}

test("la firma de correo es un documento comun y obligatorio para ambos flujos", () => {
  const comunes = recorte(indexSource, "const DOCS_ESTATICOS", "const DOCS_VINCULADO_LECTURA");
  assert.match(comunes, /clave: "firma_correo_silver"/);
  assert.match(comunes, /FirmaCorreoSilverConsultingl\.html/);
  assert.match(comunes, /plantilla: true/);
  assert.match(indexSource, /\.\.\.DOCS_ESTATICOS\.map\(d => d\.clave\)/);
  assert.ok(fs.existsSync(path.resolve(__dirname, "../src/static/informacion/FirmaCorreoSilverConsultingl.html")));
});

test("el backend exige constancia de descarga antes de aceptar el check", () => {
  const descarga = recorte(indexSource, "app.get(\"/contratacion/pdf/:nombre\"", "// PATCH /contratacion/check");
  const check = recorte(indexSource, "app.patch(\"/contratacion/check\"", "// GET /contratacion/docs-firma");
  assert.match(descarga, /descargaCheckKey/);
  assert.match(descarga, /checks_completados = jsonb_set/);
  assert.match(descarga, /text\/html; charset=utf-8/);
  assert.match(check, /checks_completados ->> \$3/);
  assert.match(check, /Debes descargar la plantilla antes de confirmar/);
});

test("el frontend descarga antes de registrar el documento", () => {
  const confirmar = recorte(frontSource, "async confirmarLectura()", "// DATOS PERSONALES");
  assert.ok(confirmar.indexOf("await this.descargarArchivo") < confirmar.indexOf("await this._registrarCheck"));
  assert.match(confirmar, /this\.confirmoLectura = false/);
  assert.match(frontSource, /params: \{ descarga: 1 \}/);
});

test("el contrato moderno esta configurado y conserva identificacion juridica", () => {
  assert.match(indexSource, /silver: "Contrato Prestación de Servicios\.docx"/);
  const dir = path.resolve(__dirname, "../src/static/todoSilver");
  const fileName = fs.readdirSync(dir).find((name) => name === "Contrato Prestación de Servicios.docx");
  assert.ok(fileName, "No se encontro el contrato moderno");
  const zip = new PizZip(fs.readFileSync(path.join(dir, fileName)));
  const xml = Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(name))
    .map((name) => zip.file(name).asText())
    .join("\n")
    .replace(/<[^>]+>/g, "");
  for (const tag of ["ContratistaRazonSocial", "ContratistaRepresentanteLegal", "ContratistaDocumentoLegal"]) {
    assert.match(xml, new RegExp(`\\{${tag}\\}`));
  }
});
