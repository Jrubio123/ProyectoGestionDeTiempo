const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const {
  buildAnexoIndividualDocumentContext,
  generateAnexoIndividualManualPdfFromItems,
  labelAnexoTipo
} = require("../src/services/anexo-individual-documento.service");

function buildValidInput() {
  return {
    userRow: {
      nombre_usuario: "Ana Consultora",
      tipo_documento_codigo: "CC",
      cedula: "123456789",
      email: "ana@example.com",
      telefono: "3001234567",
      direccion: "Calle 10 # 20-30",
      ciudad: "Medellín",
      factura_en_colombia: true
    },
    correoFirmante: "firma@example.com",
    items: [
      {
        tipo_asignacion: "full_time",
        cliente_nombre: "Cliente Uno",
        modulo_titulo: "SAP ABAP",
        moneda: "COP",
        valor_tarifa: 5000000,
        fecha_inicio: "2026-08-01",
        fecha_fin: "2026-12-31"
      }
    ]
  };
}

function findTemplate(fileNameWithoutAccent) {
  const folder = path.resolve(__dirname, "../src/static/todoSilver");
  const normalize = (value) => value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const file = fs.readdirSync(folder).find((name) => normalize(name) === normalize(fileNameWithoutAccent));
  assert.ok(file, `No se encontró la plantilla ${fileNameWithoutAccent}`);
  return path.join(folder, file);
}

function renderTemplate(templatePath, data) {
  const binary = fs.readFileSync(templatePath, "binary");
  const doc = new Docxtemplater(new PizZip(binary), {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" },
    syntax: { allowUnopenedTag: true, allowUnclosedTag: true }
  });
  doc.render(data);
  const xml = doc.getZip().file("word/document.xml").asText();
  return xml
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

test("construye el contexto contractual del anexo individual", () => {
  const input = buildValidInput();
  const result = buildAnexoIndividualDocumentContext(input);

  assert.equal(result.personaContext.nombreCompleto, "Ana Consultora");
  assert.equal(result.personaContext.tipoDocumento, "CC");
  assert.equal(result.personaContext.correoPersonal, "firma@example.com");
  assert.equal(result.items.length, 1);
});

test("rechaza el anexo cuando falta la identidad requerida", () => {
  const input = buildValidInput();
  input.userRow.cedula = "";

  assert.throws(
    () => buildAnexoIndividualDocumentContext(input),
    (err) => {
      assert.equal(err?.status, 422);
      assert.equal(err?.code, "ANEXO_DOCUMENTO_INCOMPLETO");
      assert.ok(err?.missing.includes("Número de documento"));
      return true;
    }
  );
});

test("genera el anexo manual PDFKit en una sola hoja con etiquetas por horas", async () => {
  const generated = await generateAnexoIndividualManualPdfFromItems(buildValidInput());
  const pdfSource = generated.pdfBuffer.toString("latin1");

  assert.equal(generated.pageCount, 1);
  assert.match(generated.fileName, /^AnexoTecnicoIndividual_Ana_Consultora_/);
  assert.ok(generated.pdfBuffer.subarray(0, 4).equals(Buffer.from("%PDF")));
  assert.equal((pdfSource.match(/\/Type\s*\/Page\b/g) || []).length, 1);
  assert.equal(labelAnexoTipo("full_time"), "180/160 Horas");
  assert.equal(labelAnexoTipo("medio_tiempo"), "80/90 Horas");
});

test("el flujo manual usa PDFKit y comparte una carpeta estable por persona", () => {
  const manualService = fs.readFileSync(
    path.resolve(__dirname, "../src/services/anexo-individual.service.js"),
    "utf8"
  );
  const indexSource = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");

  assert.doesNotMatch(manualService, /generateAnexoIndividualPdfFromItems/);
  assert.equal(
    (manualService.match(/generateAnexoIndividualManualPdfFromItems\(/g) || []).length,
    2
  );
  assert.match(indexSource, /folderName: sanitizePathSegment\(`\$\{nombre\}_\$\{fallbackIdentity\}`/);
  assert.match(indexSource, /return uploadAnexoIndividualFirmadoToOneDrive\(proceso, pdfBuffer, fileName\)/);
});

test("permite modulo opcional y tarifa cero, como admite la base de datos", () => {
  const input = buildValidInput();
  input.items[0].modulo_titulo = "";
  input.items[0].valor_tarifa = 0;

  assert.doesNotThrow(() => buildAnexoIndividualDocumentContext(input));
});

for (const templateName of ["Anexo Tecnico.docx", "AnexoTecnicoCapital.docx"]) {
  test(`la plantilla ${templateName} imprime todos los items`, () => {
    const output = renderTemplate(findTemplate(templateName), {
      NombreCompleto: "ANA CONSULTORA",
      TipoDocumento: "CC",
      NumeroDocumento: "123456789",
      Direccion: "Calle 10 # 20-30",
      DiaMes: "03",
      MesTexto: "agosto",
      Anio: "2026",
      items: [
        {
          tipo: "180/160 Horas - Módulo: SAP ABAP",
          cliente: "CLIENTE_UNO_UNICO",
          valorTarifa: "$ 5.000.000 / mes",
          fechaInicio: "01/08/2026",
          fechaFin: "31/12/2026"
        },
        {
          tipo: "Proyecto",
          cliente: "CLIENTE_DOS_UNICO",
          valorTarifa: "$ 9.000.000 (proyecto)",
          fechaInicio: "01/09/2026",
          fechaFin: "30/11/2026"
        }
      ]
    });

    assert.match(output, /CLIENTE_UNO_UNICO/);
    assert.match(output, /CLIENTE_DOS_UNICO/);
    assert.match(output, /180\/160 Horas/);
    assert.match(output, /Módulo: SAP ABAP/);
    assert.match(output, /Proyecto/);
  });
}
