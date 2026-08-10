const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function recorte(source, desde, hasta) {
  const start = source.indexOf(desde);
  const end = source.indexOf(hasta, start);
  assert.notEqual(start, -1, `no se encontro: ${desde}`);
  assert.notEqual(end, -1, `no se encontro: ${hasta}`);
  return source.slice(start, end);
}

function cargarHelpersFirma() {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const context = vm.createContext({ ONEDRIVE_ENABLED: true });
  vm.runInContext([
    recorte(source, "function normalizeDocStatus", "function isDocxTemplateFailureMessage"),
    recorte(source, "function mergeContratoFirmaStatus", "function buildContratoDocPatch"),
    recorte(source, "function contratoDocNeedsReconciliation", "function isClickSignInvalidSignatureReference"),
    "globalThis.__merge = mergeContratoDocPatch;",
    "globalThis.__complete = contratoDocSyncCompleted;",
    "globalThis.__needs = contratoDocNeedsReconciliation;"
  ].join("\n"), context);
  return context;
}

test("firma confirmada completa el documento aunque OneDrive falle", () => {
  const helpers = cargarHelpersFirma();
  assert.equal(helpers.__complete({ estado: "signed", onedrive_url: "" }), true);
  assert.equal(helpers.__needs({ estado: "signed", request_id: "CF-1", onedrive_url: "" }), true);
});

test("una escritura concurrente nunca degrada firma ni archivo confirmados", () => {
  const helpers = cargarHelpersFirma();
  const merged = helpers.__merge(
    { estado: "signed", firma_estado: "signed", onedrive_url: "https://onedrive/doc.pdf", archivo_estado: "subido" },
    { estado: "sent", firma_estado: "sent", onedrive_url: null, archivo_estado: "error" }
  );
  assert.equal(merged.estado, "signed");
  assert.equal(merged.firma_estado, "signed");
  assert.equal(merged.onedrive_url, "https://onedrive/doc.pdf");
  assert.equal(merged.archivo_estado, "subido");
});

test("reserva identificadores antes de llamar START_SIGNATURE", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const route = recorte(source, "app.post(\"/contratacion/firmar\"", "app.use(require(\"./routes/health.routes\"))");
  const reserva = route.indexOf("await mutateContratoDocsFirma");
  const llamada = route.indexOf("clicksignRes = await jsonRequest");
  assert.ok(reserva >= 0 && llamada > reserva);
  assert.match(route, /START_SIGNATURE_RESERVED/);
  assert.match(route, /firma_inicio_error_ambiguo/);
});

test("webhook se guarda antes de responder y tiene reintento durable", () => {
  const route = fs.readFileSync(path.resolve(__dirname, "../src/routes/webhook.routes.js"), "utf8");
  assert.ok(route.indexOf("enqueueSignatureEvent") < route.indexOf("res.status(200)"));
  assert.match(route, /processQueuedSignatureEvent/);

  const service = fs.readFileSync(path.resolve(__dirname, "../src/services/clicksign.service.js"), "utf8");
  assert.match(service, /clicksign_webhook_eventos/);
  assert.match(service, /siguiente_intento_at/);
  assert.match(service, /jobProcesarWebhooksClickSignPendientes/);
});

test("reconciliador sigue archivando procesos ya firmados", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const job = recorte(source, "async function jobReconciliarContratosEnFirma", "async function jobReintentarCorreosCuentasCobro");
  assert.match(job, /tf\.estado IN \('en_proceso', 'completado'\)/);
  assert.match(job, /onedrive_url/);
});

test("la UI sigue consultando cuando el inicio queda ambiguo", () => {
  const frontend = fs.readFileSync(path.resolve(__dirname, "../../front/js/contratacion-publica.js"), "utf8");
  assert.match(frontend, /recuperacion_automatica/);
  assert.match(frontend, /this\.iniciarPolling\(\)/);

  const backend = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  assert.match(backend, /INVALID_SIGNATURE_REFERENCE/);
  assert.match(backend, /firma_inicio_error_ambiguo/);
});
