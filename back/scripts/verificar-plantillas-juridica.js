#!/usr/bin/env node
/**
 * Revisa que las plantillas DOCX de contratos puedan identificar a una persona juridica,
 * con la MISMA regla que aplica el backend en isContratoDocPersonaJuridicaCompatible().
 *
 * Uso:   node scripts/verificar-plantillas-juridica.js
 *
 * Sirve para no tener que generar un enlace de firma solo para saber si una plantilla
 * quedo bien: si aqui sale PASA, el backend tampoco la va a bloquear.
 */
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");

// Debe reflejar CONTRATO_DOCS_SIN_IDENTIFICACION_JURIDICA en src/index.js.
const EXENTOS = new Set([
  "autorizacion_datos_personales",
  "autorizacion_datos_personales_vinculado",
  "autorizacion_datos_sensibles_vinculado",
  "politica_garantia"
]);

// Debe reflejar CONTRATO_DOC_DEFINITIONS_FULL / _VINCULADO en src/index.js.
const DOCS = [
  ["contrato_prestacion_servicios", "todoSilver", ["Contrato Prestación de Servicios .docx", "ContratoPrestacionServicioCapital.docx"]],
  ["acuerdo_confidencialidad", "todoSilver", ["Acuerdo de Confidencialidad .docx", "AcuerdoConfidencialdiadCapital.docx"]],
  ["politica_garantia", "todoSilver", ["Política de Garantía.docx", "PoliticaGarantiaCapital.docx"]],
  ["autorizacion_datos_personales", "todoSilver", ["AUTORIZACIÓN EXPRESA PARA EL TRATAMIENTO DE DATOS PERSONALES.docx", "AutorizacionTratamientoDatosCapital.docx"]],
  ["anexo_tecnico", "todoSilver", ["Anexo Técnico.docx", "AnexoTecnicoCapital.docx"]],
  ["cl_termino_indefinido", "vinculado", ["CL - TERMINO INDEFINIDO.docx"]],
  ["acuerdo_confidencialidad_vinculado", "vinculado", ["ACUERDO DE CONFIDENCIALIDAD.docx"]],
  ["autorizacion_datos_personales_vinculado", "vinculado", ["AUTORIZACIÓN EXPRESA PARA EL TRATAMIENTO DE DATOS PERSONALES.docx"]],
  ["autorizacion_datos_sensibles_vinculado", "vinculado", ["AUTORIZACIÓN EXPRESA PARA EL TRATAMIENTO DE DATOS SENSIBLES.docx"]]
];

const TRIO = ["ContratistaNombreLegal", "ContratistaDocumentoEtiqueta", "ContratistaDocumentoLegal"];

function leerTextoPlantilla(folder, file) {
  const ruta = path.resolve(__dirname, "..", "src", "static", folder, file);
  const zip = new PizZip(fs.readFileSync(ruta));
  const xml = zip.file("word/document.xml")?.asText() || "";
  return xml.replace(/<[^>]+>/g, "");
}

let bloqueados = 0;
let revisados = 0;

for (const [docKey, folder, files] of DOCS) {
  for (const file of files) {
    if (EXENTOS.has(docKey)) {
      console.log(`EXENTO   ${folder}/${file}`);
      continue;
    }
    revisados += 1;
    let texto = "";
    try {
      texto = leerTextoPlantilla(folder, file);
    } catch (err) {
      bloqueados += 1;
      console.log(`ERROR    ${folder}/${file} — ${err.message}`);
      continue;
    }

    if (texto.includes("ContratistaComparecencia")) {
      console.log(`PASA     ${folder}/${file}  (via ContratistaComparecencia)`);
      continue;
    }
    const faltan = TRIO.filter((marcador) => !texto.includes(marcador));
    if (!faltan.length) {
      console.log(`PASA     ${folder}/${file}  (via trio de identificacion)`);
      continue;
    }
    bloqueados += 1;
    console.log(`BLOQUEA  ${folder}/${file}`);
    console.log(`         falta: ${faltan.join(", ")}`);
  }
}

console.log(`\n${revisados - bloqueados}/${revisados} plantillas listas para persona juridica.`);
if (bloqueados) {
  console.log("Agrega {{ContratistaComparecencia}} o el trio en el CUERPO del documento");
  console.log("(no en encabezado, pie de pagina ni cuadro de texto: solo se lee word/document.xml).");
}
process.exitCode = bloqueados ? 1 : 0;
