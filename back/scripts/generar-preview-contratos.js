#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

function getArgument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) return fallback;
  return String(process.argv[index + 1]).trim() || fallback;
}

function normalizeFileName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function findTemplate(templateDir, expectedName) {
  const expected = normalizeFileName(expectedName);
  const actualName = fs.readdirSync(templateDir)
    .find((name) => normalizeFileName(name) === expected);
  if (!actualName) throw new Error(`No se encontro la plantilla ${expectedName}`);
  return path.join(templateDir, actualName);
}

function renderTemplate(templatePath, outputPath, data) {
  const binary = fs.readFileSync(templatePath, "binary");
  const doc = new Docxtemplater(new PizZip(binary), {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" },
    syntax: { allowUnopenedTag: true, allowUnclosedTag: true },
    nullGetter: () => ""
  });
  doc.render(data);
  const buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(outputPath, buffer);
}

const modulo = getArgument("modulo", "BASIS");
const outputDir = path.resolve(
  getArgument("salida", path.resolve(__dirname, "..", "generated", "contratos-preview"))
);
const templateDir = path.resolve(__dirname, "..", "src", "static", "todoSilver");
const fecha = new Date();
const dia = new Intl.DateTimeFormat("es-CO", { day: "2-digit", timeZone: "America/Bogota" }).format(fecha);
const mes = new Intl.DateTimeFormat("es-CO", { month: "long", timeZone: "America/Bogota" }).format(fecha);
const anio = new Intl.DateTimeFormat("es-CO", { year: "numeric", timeZone: "America/Bogota" }).format(fecha);

fs.mkdirSync(outputDir, { recursive: true });

const persona = {
  PerfilOModulo: modulo,
  NombreCompleto: "FERNANDO CONSULTOR DEMO",
  TipoDocumento: "CC",
  NumeroDocumento: "1234567890",
  Direccion: "Calle 10 # 20-30, Medellin",
  Correo: "fernando.demo@example.com",
  CorreoPersonal: "fernando.demo@example.com",
  Telefono: "3001234567",
  DiaMes: dia,
  MesTexto: mes,
  Anio: anio,
  FechaInicioDia: dia,
  FechaInicioMesTexto: mes,
  FechaInicioAnio: anio,
  ContratistaNombreLegal: "FERNANDO CONSULTOR DEMO",
  ContratistaDocumentoEtiqueta: "CC",
  ContratistaDocumentoLegal: "1234567890",
  ContratistaRazonSocial: "",
  ContratistaRepresentanteLegal: "",
  ContratistaTipoDocumentoRepresentante: "",
  ContratistaNumeroDocumentoRepresentante: "",
  ContratistaFirmaNombre: "FERNANDO CONSULTOR DEMO",
  ContratistaFirmaDocumento: "CC 1234567890",
  ContratistaFirmaCargo: "EL CONTRATISTA",
  ContratistaFirmaNit: "",
  items: [
    {
      tipo: `180/160 Horas - Módulo: ${modulo}`,
      cliente: "CLIENTE DEMOSTRACION",
      modulo,
      valorTarifa: "$ 5.000.000 / mes",
      fechaInicio: `${dia}/${String(fecha.getMonth() + 1).padStart(2, "0")}/${anio}`,
      fechaFin: `31/12/${anio}`
    }
  ]
};

const empresas = [
  {
    key: "Silver",
    templates: {
      contrato: "Contrato Prestacion de Servicios.docx",
      anexo: "Anexo Tecnico.docx"
    },
    data: {
      EmpresaRazonSocial: "SILVER CONSULTING S.A.S.",
      EmpresaRepresentanteLegal: "DANIELA BELTRAN GOMEZ",
      EmpresaCedulaRepresentante: "1128472903",
      EmpresaNit: "901149190-0",
      EmpresaDomicilio: "Medellin - Antioquia",
      RepresentanteLegal: "DANIELA BELTRAN GOMEZ",
      CedulaRL: "1128472903",
      NitSilver: "901149190-0"
    }
  },
  {
    key: "Capital",
    templates: {
      contrato: "ContratoPrestacionServicioCapital.docx",
      anexo: "AnexoTecnicoCapital.docx"
    },
    data: {
      EmpresaRazonSocial: "CAPITALINK S.A.S.",
      EmpresaRepresentanteLegal: "CINDY CATALINA LOAIZA CARDONA",
      EmpresaCedulaRepresentante: "1036629658",
      EmpresaNit: "901473416-8",
      EmpresaDomicilio: "Medellin - Antioquia",
      RepresentanteLegal: "CINDY CATALINA LOAIZA CARDONA",
      CedulaRL: "1036629658",
      NitSilver: "901473416-8"
    }
  }
];

for (const empresa of empresas) {
  const data = { ...persona, ...empresa.data };
  for (const [tipo, templateName] of Object.entries(empresa.templates)) {
    const templatePath = findTemplate(templateDir, templateName);
    const outputName = `${tipo === "contrato" ? "Contrato" : "Anexo"}_Preview_${empresa.key}_${modulo}.docx`
      .replace(/[^a-zA-Z0-9_.-]+/g, "_");
    const outputPath = path.join(outputDir, outputName);
    renderTemplate(templatePath, outputPath, data);
    console.log(outputPath);
  }
}
