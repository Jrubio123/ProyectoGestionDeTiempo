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
    recorte(source, "function isClickSignSignedFileEntry", "async function fetchClickSignFileListEntries"),
    "globalThis.__merge = mergeContratoDocPatch;",
    "globalThis.__complete = contratoDocSyncCompleted;",
    "globalThis.__needs = contratoDocNeedsReconciliation;",
    "globalThis.__isSignedFile = isClickSignSignedFileEntry;"
  ].join("\n"), context);
  return context;
}

test("firma confirmada completa el documento aunque OneDrive falle", () => {
  const helpers = cargarHelpersFirma();
  assert.equal(helpers.__complete({ estado: "signed", onedrive_url: "" }), true);
  assert.equal(helpers.__needs({ estado: "signed", request_id: "CF-1", onedrive_url: "" }), true);
});

test("solo file_group signed se acepta como PDF firmado", () => {
  const helpers = cargarHelpersFirma();
  assert.equal(helpers.__isSignedFile({ fileGroup: "signed", status: "available" }), true);
  assert.equal(helpers.__isSignedFile({ fileGroup: "signed", status: "pending" }), false);
  assert.equal(helpers.__isSignedFile({ fileGroup: "original", fileName: "contrato_signed.pdf" }), false);
  assert.equal(helpers.__isSignedFile({ fileType: "signed_contract", fileName: "firmado.pdf" }), false);

  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const resolver = recorte(source, "async function resolveClickSignArtifacts", "async function resolveCuentaFirmaFirmadaAcrossAttempts");
  assert.doesNotMatch(resolver, /get_file_catalog_fallback/);
  assert.doesNotMatch(resolver, /resolveSignedPdfFromClickSign/);
  assert.match(resolver, /selectedFile/);
});

test("una referencia invalida temporal puede volver a reconciliarse", () => {
  const helpers = cargarHelpersFirma();
  assert.equal(helpers.__needs({
    estado: "sent",
    request_id: "CF-1",
    ultimo_evento: "INVALID_SIGNATURE_REFERENCE"
  }), true);
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
  assert.match(service, /CLICKSIGN_ARCHIVO_FIRMADO_PENDIENTE/);
  assert.match(service, /handledContrato\?\.retry/);

  const { __private } = require("../src/services/clicksign.service");
  const pendingError = __private.buildArchivoFirmadoPendienteError("contrato", "file_group_signed_pendiente");
  assert.equal(__private.isArchivoFirmadoPendienteError(pendingError), true);

  const backend = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  assert.doesNotMatch(backend, /scheduleContratoWebhookRetry/);
  assert.match(backend, /file_group_signed_pendiente/);
});

test("reconciliador sigue archivando procesos ya firmados", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const job = recorte(source, "async function jobReconciliarContratosEnFirma", "async function jobReintentarCorreosCuentasCobro");
  assert.match(job, /tf\.estado IN \('en_proceso', 'completado'\)/);
  assert.match(job, /onedrive_url/);
});

test("correo de contrato espera los archivos y conserva cierre legal independiente", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const mutacion = recorte(source, "async function mutateContratoDocsFirma", "async function patchContratoDocFirmaSafely");
  const notificacion = recorte(source, "async function notifyContratoFirmaCompletada", "async function resolveProcesoForPersona");

  assert.match(mutacion, /WHEN \$2 = 'completado'/);
  assert.match(mutacion, /firma_completada_notificacion_pendiente_at/);
  assert.match(notificacion, /const todosArchivados = docsNormalizados\.every/);
  assert.match(notificacion, /if \(!todosArchivados && !esperaVencida\)/);
  assert.ok(notificacion.indexOf('skipped: "files_pending"') < notificacion.indexOf("sendEmailSafe"));
  assert.match(notificacion, /firma_completada_notificada_at = NOW\(\)/);
  assert.match(notificacion, /enviado_por_timeout: !todosArchivados && esperaVencida/);
});

test("job rescata notificaciones pendientes aunque ya no haya archivos por conciliar", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const job = recorte(source, "async function jobReconciliarContratosEnFirma", "async function jobReintentarCorreosCuentasCobro");

  assert.match(job, /tf\.firma_completada_notificada_at IS NULL/);
  assert.match(job, /if \(pendientesAntes === 0\)/);
  assert.match(job, /await notifyContratoFirmaCompletada\(procesoActual\.id\)/);
});

test("correo diferencia las carpetas del contrato y del anexo sin repetir el encabezado", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const context = vm.createContext({ URL });
  vm.runInContext([
    recorte(source, "function escapeHtmlText", "async function notifyContratoFirmaCompletada"),
    "globalThis.__buildEmail = buildContratoFirmaCompletadaEmail;"
  ].join("\n"), context);

  const unaCarpeta = context.__buildEmail({
    proceso: { nombre_persona: "Persona Prueba" },
    docs: [{ titulo: "Contrato", url: "https://example.com/Contratos/contrato.pdf", archivo_estado: "subido" }]
  });
  assert.equal((unaCarpeta.text.match(/Carpeta OneDrive:/g) || []).length, 1);

  const dosCarpetas = context.__buildEmail({
    proceso: { nombre_persona: "Persona Prueba" },
    docs: [
      { titulo: "Contrato", url: "https://example.com/Contratos/contrato.pdf", archivo_estado: "subido" },
      { titulo: "Anexo Tecnico", url: "https://example.com/AnexoTecnico/anexo.pdf", archivo_estado: "subido" }
    ]
  });
  assert.match(dosCarpetas.text, /Carpetas OneDrive:/);
  assert.match(dosCarpetas.text, /Contrato: https:\/\/example\.com\/Contratos/);
  assert.match(dosCarpetas.text, /Anexo Tecnico: https:\/\/example\.com\/AnexoTecnico/);
});

test("migracion agrega trazabilidad durable de la notificacion", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-12-contrato-notificacion-archivos.sql"),
    "utf8"
  );
  assert.match(migration, /firma_completada_notificacion_pendiente_at/);
  assert.match(migration, /firma_completada_notificacion_intentos/);
  assert.match(migration, /firma_completada_notificacion_error/);
  assert.match(migration, /firma_completada_notificada_at IS NULL/);
});

test("la UI sigue consultando cuando el inicio queda ambiguo", () => {
  const frontend = fs.readFileSync(path.resolve(__dirname, "../../front/js/contratacion-publica.js"), "utf8");
  assert.match(frontend, /recuperacion_automatica/);
  assert.match(frontend, /this\.iniciarPolling\(\)/);

  const backend = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  assert.match(backend, /INVALID_SIGNATURE_REFERENCE/);
  assert.match(backend, /firma_inicio_error_ambiguo/);
});

test("la UI reconcilia cada 30 segundos mientras permanezca abierta", () => {
  const frontend = fs.readFileSync(path.resolve(__dirname, "../../front/js/contratacion-publica.js"), "utf8");
  assert.match(frontend, /FIRMA_POLLING_INTERVAL_MS = 30000/);
  assert.doesNotMatch(frontend, /FIRMA_POLLING_MAX_ATTEMPTS/);
  assert.match(frontend, /document\.hidden/);
  assert.doesNotMatch(frontend, /pollingIntentos/);
  assert.match(frontend, /this\.docsFirmaOrdenados\.filter\(\(doc\) => this\.puedeReconciliarDoc\(doc\)\)/);
  assert.match(frontend, /`\$\{API\}\/contratacion\/firma\/reconciliar`,\s*\{ doc_index: Number\(doc\.doc_index\) \}/);

  const backend = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  assert.doesNotMatch(backend, /skipped: "doc_index_required"/);
  assert.match(backend, /RECONCILIACION_CONTRATOS_JOB_HABILITADO \|\| "true"/);
  assert.match(backend, /RECONCILIACION_CONTRATOS_INTERVAL_SEGUNDOS \|\| 300/);
  assert.match(backend, /archivo_file_group/);
  assert.match(backend, /archivo_catalogo/);
});

test("el catalogo se consulta para archivar solo cuando la firma ya esta confirmada", () => {
  const backend = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const reconciliador = recorte(
    backend,
    "async function reconcileContratoDocsForProcess",
    "const contratoReconciliationTimers"
  );
  assert.match(reconciliador, /if \(nextStatus === "signed"\) \{\s*const artifacts = await resolveClickSignArtifacts/);
});

test("anexo individual conserva firma legal y trazabilidad mientras espera el PDF", () => {
  const backend = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const pending = recorte(
    backend,
    "async function markAnexoIndividualSignedPending",
    "async function markAnexoIndividualSignedWithOneDrive"
  );
  assert.match(pending, /SET estado = 'firmado'/);
  assert.match(pending, /archivo_estado = \$3/);
  assert.match(pending, /archivo_file_group = \$7/);
  assert.match(pending, /archivo_catalogo = \$11::jsonb/);

  const handler = recorte(
    backend,
    "async function handleClickSignAnexoIndividualWebhook",
    "function normalizeTemplateFileName"
  );
  assert.match(handler, /markAnexoIndividualSignedPending/);
  assert.match(handler, /retry: true/);
});

test("no quedan resolutores inseguros ni configuracion legacy del PDF firmado", () => {
  const backend = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  assert.doesNotMatch(backend, /resolveSignedPdfFromClickSign/);
  assert.doesNotMatch(backend, /isClickSignSecondaryFileEntry/);
  assert.doesNotMatch(backend, /isClickSignUploadedOrOriginalGroup/);
  assert.doesNotMatch(backend, /CLICKSIGN_SIGNED_FILE_URL_TEMPLATE/);
});
