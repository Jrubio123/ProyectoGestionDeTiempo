const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const personasJsPath = path.resolve(__dirname, "../../front/js/gestion-personas.js");
const personasHtmlPath = path.resolve(__dirname, "../../front/views/gestion-personas.html");
const consultoresHtmlPath = path.resolve(__dirname, "../../front/views/gestion-consultores.html");
const indexPath = path.resolve(__dirname, "../src/index.js");

test("gestion de personas normaliza y valida los datos de persona juridica", (t) => {
  const previousWindow = global.window;
  t.after(() => {
    global.window = previousWindow;
    delete require.cache[personasJsPath];
  });

  global.window = { API_BASE: "http://test" };
  delete require.cache[personasJsPath];
  require(personasJsPath);
  const app = global.window.gestionPersonasApp();
  app.cat.tiposDocumento = [
    { id: "doc-cc", titulo: "Cédula de Ciudadanía", codigo: "CC" },
    { id: "doc-ce", titulo: "Cédula de Extranjería", codigo: "CE" }
  ];

  assert.equal(app.valorTipoPersonaForm("Juridica"), "Juridica");
  assert.equal(app.valorTipoPersonaForm("Jurídica"), "Juridica");
  assert.equal(app.valorTipoDocumentoRepresentanteForm("Cédula de Ciudadanía"), "CC");
  assert.equal(app.addForm.tipo_persona, "Natural");

  app.ficha = {
    tipo_persona: "Jurídica",
    razon_social: "Empresa existente SAS",
    tipo_documento_representante: "Cédula de Ciudadanía"
  };
  app.abrirEdicion("personal");
  assert.equal(app.draft.personal.tipo_persona, "Juridica");
  assert.equal(app.draft.personal.razon_social, "Empresa existente SAS");
  assert.equal(app.draft.personal.tipo_documento_representante, "CC");

  const incompleto = { tipo_persona: "Juridica", razon_social: "Empresa SAS" };
  assert.match(app.prepararDatosJuridicos(incompleto), /NIT de la empresa/);
  assert.equal(incompleto.tipo_persona, "Juridica");

  const completo = {
    tipo_persona: "Jurídica",
    razon_social: " Empresa SAS ",
    nit_empresa: "900123456-1",
    representante_legal: "Ana Pérez",
    tipo_documento_representante: "CC",
    numero_documento_representante: "123456"
  };
  assert.equal(app.prepararDatosJuridicos(completo), "");
  assert.equal(completo.razon_social, "Empresa SAS");
  assert.equal(completo.tipo_documento_representante, "CC");

  completo.tipo_persona = "Natural";
  assert.equal(app.prepararDatosJuridicos(completo), "");
  assert.equal(completo.razon_social, null);
  assert.equal(completo.nit_empresa, null);
});

test("la edicion juridica queda centralizada en gestion de personas", () => {
  const personasHtml = fs.readFileSync(personasHtmlPath, "utf8");
  const consultoresHtml = fs.readFileSync(consultoresHtmlPath, "utf8");

  assert.match(personasHtml, /x-model="draft\.personal\.tipo_persona"/);
  assert.match(personasHtml, /x-model="addForm\.tipo_persona"/);
  assert.match(personasHtml, /x-model="draft\.personal\.razon_social"/);
  assert.match(personasHtml, /x-model="draft\.personal\.nit_empresa"/);
  assert.match(personasHtml, /x-model="draft\.personal\.representante_legal"/);
  assert.match(personasHtml, /x-model="draft\.personal\.tipo_documento_representante"/);
  assert.match(personasHtml, /x-model="draft\.personal\.numero_documento_representante"/);
  assert.match(personasHtml, /:value="d\.codigo \|\| d\.titulo"/);

  assert.doesNotMatch(consultoresHtml, /x-model="(?:addForm|draft\.personal)\.tipo_persona"/);
  assert.match(consultoresHtml, /se administran desde Gesti&oacute;n de Personas/);
});

test("el backend persiste y exige los campos juridicos desde gestion de personas", () => {
  const index = fs.readFileSync(indexPath, "utf8");
  const createStart = index.indexOf('app.post("/admin/personas"');
  const listStart = index.indexOf('app.get("/admin/personas"', createStart);
  const createSource = index.slice(createStart, listStart);
  const linkedEditStart = index.indexOf('app.put("/admin/personas/:id/personal"');
  const linkedEditEnd = index.indexOf('app.put("/admin/personas/:id/cobro"', linkedEditStart);
  const linkedEditSource = index.slice(linkedEditStart, linkedEditEnd);
  const consultantCreateStart = index.indexOf('app.post("/admin/consultores"');
  const consultantCreateEnd = index.indexOf('app.get("/admin/consultores/existente"', consultantCreateStart);
  const consultantCreateSource = index.slice(consultantCreateStart, consultantCreateEnd);
  const consultantUpdateStart = index.indexOf('app.put("/admin/consultores/:id"');
  const consultantUpdateEnd = index.indexOf('app.get("/admin/consultores/:id"', consultantUpdateStart);
  const consultantUpdateSource = index.slice(consultantUpdateStart, consultantUpdateEnd);
  const personaNormalizerStart = index.indexOf("function normalizeTipoPersonaForUsuariosInput");
  const personaNormalizerEnd = index.indexOf("async function normalizeTipoDocumentoRepresentanteFromCatalog", personaNormalizerStart);
  const personaNormalizerSource = index.slice(personaNormalizerStart, personaNormalizerEnd);
  const normalizeTipoPersona = Function(
    "normalizeValue",
    `"use strict"; ${personaNormalizerSource}; return normalizeTipoPersonaForUsuariosInput;`
  )((value) => String(value || "").toLowerCase().trim());

  assert.ok(createStart >= 0 && listStart > createStart);
  assert.match(createSource, /normalizePersonaJuridicaInput/);
  assert.match(createSource, /razon_social, nit_empresa, representante_legal/);
  assert.match(createSource, /tipo_documento_representante, numero_documento_representante/);
  assert.match(personaNormalizerSource, /normalize\("NFD"\)/);
  assert.match(personaNormalizerSource, /raw === "juridica"/);
  assert.equal(normalizeTipoPersona("Juridica"), "Jurídica");
  assert.equal(normalizeTipoPersona("Jurídica"), "Jurídica");
  assert.equal(normalizeTipoPersona("JurÃ­dica"), "Jurídica");
  assert.equal(normalizeTipoPersona("Jur&iacute;dica"), "Jurídica");
  assert.match(index, /normalizeTipoDocumentoRepresentanteFromCatalog/);
  assert.match(linkedEditSource, /personaJuridica\.missing\.length/);
  assert.match(linkedEditSource, /tipo_persona === undefined/);
  assert.match(linkedEditSource, /tipoPersonaEfectiva/);
  assert.doesNotMatch(consultantCreateSource, /toNullableTrimmedString\(tipo_persona\)/);
  assert.doesNotMatch(consultantUpdateSource, /toNullableTrimmedString\(tipo_persona\)/);
  assert.match(consultantUpdateSource, /COALESCE\(p\.tipo_persona, u\.tipo_persona\) AS tipo_persona_actual/);
  assert.match(consultantUpdateSource, /tipoPersonaPersistida/);
});
