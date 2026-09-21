#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");

const TAG = "{{PerfilOModulo}}";
const TEMPLATES = [
  ["contratos", "Contrato Prestación de Servicios .docx", [["SAP ABAP", TAG]]],
  ["contratos", "ContratoPrestacionServicioCapital.docx", [["[SAP]", TAG], ["[***]", TAG]]],
  ["contratos", "Anexo Técnico.docx", [
    ["SAP ABAP", TAG],
    ["han celebrad un Contrato", "han celebrado un Contrato"],
    [`${TAG}  (en adelante`, `${TAG} (en adelante`]
  ]],
  ["contratos", "AnexoTecnicoCapital.docx", [
    ["[SAP]", TAG],
    ["han celebrad un Contrato", "han celebrado un Contrato"],
    ["(en adelante el “Contrato suscrito el", "(en adelante el “Contrato”), suscrito el"]
  ]],
  ["todoSilver", "Contrato Prestación de Servicios.docx", [["SAP ABAP", TAG]]],
  ["todoSilver", "ContratoPrestacionServicioCapital.docx", [["[SAP]", TAG], ["[***]", TAG]]],
  ["todoSilver", "Anexo Técnico.docx", [
    ["SAP ABAP", TAG],
    ["han celebrad un Contrato", "han celebrado un Contrato"],
    [`${TAG}  (en adelante`, `${TAG} (en adelante`]
  ]],
  ["todoSilver", "AnexoTecnicoCapital.docx", [
    ["[SAP]", TAG],
    ["han celebrad un Contrato", "han celebrado un Contrato"],
    ["(en adelante el “Contrato suscrito el", "(en adelante el “Contrato”), suscrito el"]
  ]]
];

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function replaceFirstAcrossTextNodes(paragraph, search, replacement) {
  const nodes = [];
  const pattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let match;
  let plainText = "";

  while ((match = pattern.exec(paragraph))) {
    const decoded = decodeXml(match[1]);
    const openingTagEnd = match[0].indexOf(">");
    const closingTagStart = match[0].lastIndexOf("</w:t>");
    nodes.push({
      contentStart: match.index + openingTagEnd + 1,
      contentEnd: match.index + closingTagStart,
      textStart: plainText.length,
      textEnd: plainText.length + decoded.length,
      decoded
    });
    plainText += decoded;
  }

  const occurrenceStart = plainText.indexOf(search);
  if (occurrenceStart < 0) return { paragraph, changed: false };
  const occurrenceEnd = occurrenceStart + search.length;
  const startIndex = nodes.findIndex((node) => occurrenceStart >= node.textStart && occurrenceStart < node.textEnd);
  const endIndex = nodes.findIndex((node) => occurrenceEnd > node.textStart && occurrenceEnd <= node.textEnd);
  if (startIndex < 0 || endIndex < 0) return { paragraph, changed: false };

  const replacements = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const node = nodes[index];
    let nextText = "";
    if (index === startIndex) {
      const prefixLength = occurrenceStart - node.textStart;
      nextText = node.decoded.slice(0, prefixLength) + replacement;
    }
    if (index === endIndex) {
      const suffixStart = occurrenceEnd - node.textStart;
      nextText += node.decoded.slice(suffixStart);
    }
    replacements.push({ ...node, nextText: encodeXml(nextText) });
  }

  let output = paragraph;
  for (const node of replacements.reverse()) {
    output = output.slice(0, node.contentStart) + node.nextText + output.slice(node.contentEnd);
  }
  return { paragraph: output, changed: true };
}

function replaceAllInXml(xml, search, replacement) {
  let count = 0;
  const output = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (originalParagraph) => {
    let paragraph = originalParagraph;
    while (true) {
      const result = replaceFirstAcrossTextNodes(paragraph, search, replacement);
      if (!result.changed) break;
      paragraph = result.paragraph;
      count += 1;
    }
    return paragraph;
  });
  return { xml: output, count };
}

function updateTemplate(folder, fileName, replacements) {
  const filePath = path.resolve(__dirname, "..", "src", "static", folder, fileName);
  const zip = new PizZip(fs.readFileSync(filePath));
  let total = 0;
  let repaired = 0;

  for (const zipPath of Object.keys(zip.files).filter((name) => /^word\/.*\.xml$/.test(name))) {
    let xml = zip.file(zipPath).asText();
    const malformedTags = (xml.match(/<w:txml:space=/g) || []).length;
    if (malformedTags) {
      xml = xml.replace(/<w:txml:space=/g, "<w:t xml:space=");
      repaired += malformedTags;
    }
    for (const [search, replacement] of replacements) {
      const result = replaceAllInXml(xml, search, replacement);
      xml = result.xml;
      total += result.count;
    }
    zip.file(zipPath, xml);
  }

  if (total || repaired) {
    fs.writeFileSync(filePath, zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));
  }
  console.log(
    `${total || repaired ? "ACTUALIZADA" : "SIN CAMBIOS"} ${folder}/${fileName} ` +
    `(${total} reemplazos, ${repaired} reparaciones XML)`
  );
}

for (const [folder, fileName, replacements] of TEMPLATES) {
  updateTemplate(folder, fileName, replacements);
}
