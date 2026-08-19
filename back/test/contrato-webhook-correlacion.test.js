const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Click&Sign manda varios eventos por documento (ready, new, signed, stamp_generated,
// evidence_generated). Solo el final tiene algo que correlacionar; el resto no debe
// consumir los reintentos de la cola.
function cargarManejador({ proceso = null } = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const start = source.indexOf("async function handleClickSignContratoWebhook");
  const end = source.indexOf("// Ruta Default para SPA", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const llamadas = { buscar: 0, notificar: 0, notificacion: null };
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    ONEDRIVE_ENABLED: false,
    extractClickSignDocumentStatus: () => ({ status: "", rawStatus: "" }),
    extractClickSignSignatureId: () => "",
    pickStringByPaths: (event) => String(event?.rejection_reason || ""),
    async findContratoProcessByClickSignIdentifiers() {
      llamadas.buscar += 1;
      return proceso;
    },
    async patchContratoDocFirmaSafely() {
      return { meta: { matched: true }, docs_firma: [], estado: "en_proceso" };
    },
    async syncAnexoItemsEstadoFirmaDesdeDocsContrato() {},
    async notifyContratoFirmaRechazada(payload) {
      llamadas.notificar += 1;
      llamadas.notificacion = payload;
      return { ok: true, sent: true };
    }
  });

  vm.runInContext(
    `${source.slice(start, end)}
     globalThis.__handler = handleClickSignContratoWebhook;`,
    context
  );

  return { handler: context.__handler, llamadas };
}

const EVENTO = {
  contractId: "contrato_abc_contrato_prestacion_servicios_1",
  signatureId: "17865443360400001",
  requestId: ""
};

function cargarConstructorCorreoRechazo() {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const start = source.indexOf("function buildContratoFirmaRechazadaEmail");
  const end = source.indexOf("async function notifyContratoFirmaRechazada", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = vm.createContext({
    escapeHtmlText: (value) => String(value ?? ""),
    buildEmailLayout: (payload) => JSON.stringify(payload)
  });
  vm.runInContext(
    `${source.slice(start, end)}
     globalThis.__builder = buildContratoFirmaRechazadaEmail;`,
    context
  );
  return context.__builder;
}

test("los estados intermedios se acusan como atendidos y no buscan proceso", async () => {
  for (const rawStatus of ["ready", "new", "stamp_generated", "evidence_generated"]) {
    const { handler, llamadas } = cargarManejador();
    const resultado = await handler({ event: {}, ...EVENTO, status: rawStatus, rawStatus });

    assert.ok(resultado, `${rawStatus} deberia devolver un valor verdadero`);
    assert.equal(resultado.ignorado, true, rawStatus);
    assert.match(resultado.motivo, /estado no final/);
    assert.equal(llamadas.buscar, 0, "no debe consultar la base para un estado intermedio");
  }
});

test("un estado final sin proceso asociado devuelve false para que se reintente", async () => {
  const { handler, llamadas } = cargarManejador({ proceso: null });
  const resultado = await handler({ event: {}, ...EVENTO, status: "signed", rawStatus: "signed" });

  assert.equal(resultado, false);
  assert.equal(llamadas.buscar, 1, "un estado final si debe intentar correlacionar");
});

test("el rechazo tambien intenta correlacionar", async () => {
  const { handler, llamadas } = cargarManejador({ proceso: null });
  const resultado = await handler({ event: {}, ...EVENTO, status: "rejected", rawStatus: "rejected" });

  assert.equal(resultado, false);
  assert.equal(llamadas.buscar, 1);
});

test("un rechazo correlacionado notifica a TH con la persona y el documento", async () => {
  const encontrado = {
    proceso: { id: 42, nombre_persona: "Ana Prueba" },
    matchedDoc: {
      doc_index: 2,
      titulo: "Acuerdo de confidencialidad",
      signature_id: EVENTO.signatureId,
      contract_id: EVENTO.contractId
    }
  };
  const { handler, llamadas } = cargarManejador({ proceso: encontrado });
  const resultado = await handler({
    event: { rejection_reason: "No acepta las condiciones" },
    ...EVENTO,
    status: "rejected",
    rawStatus: "declined"
  });

  assert.equal(resultado, true);
  assert.equal(llamadas.notificar, 1);
  assert.equal(llamadas.notificacion.tokenId, 42);
  assert.equal(llamadas.notificacion.docIndex, 2);
  assert.equal(llamadas.notificacion.rawStatus, "declined");
  assert.equal(llamadas.notificacion.motivo, "No acepta las condiciones");
});

test("el correo de rechazo identifica persona, archivo y motivo", () => {
  const buildEmail = cargarConstructorCorreoRechazo();
  const correo = buildEmail({
    proceso: { nombre_persona: "Ana Prueba", correo_personal: "ana@example.com" },
    doc: { doc_index: 2, titulo: "Acuerdo de confidencialidad", rechazado_en: "2026-08-19T12:00:00.000Z" },
    rawStatus: "declined",
    motivo: "No acepta las condiciones"
  });

  assert.match(correo.subject, /Ana Prueba/);
  assert.match(correo.subject, /Acuerdo de confidencialidad/);
  assert.match(correo.text, /declinó la firma digital/);
  assert.match(correo.text, /No acepta las condiciones/);
});

test("la notificación de rechazo conserva una marca idempotente por intento", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const start = source.indexOf("async function notifyContratoFirmaRechazada");
  const end = source.indexOf("async function notifyContratoFirmaCompletada", start);
  const notification = source.slice(start, end);

  assert.match(notification, /rechazo_notificacion_intento/);
  assert.match(notification, /already_notified/);
  assert.match(notification, /FOR UPDATE OF t/);
});
