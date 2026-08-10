const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function recorte(source, desde, hasta) {
  const start = source.indexOf(desde);
  const end = source.indexOf(hasta, start);
  assert.notEqual(start, -1, `no se encontró: ${desde}`);
  assert.notEqual(end, -1, `no se encontró: ${hasta}`);
  return source.slice(start, end);
}

function cargarSincronizador() {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const context = vm.createContext({
    console,
    pool: null,
    ONEDRIVE_ENABLED: true,
    LEGACY_DOC_INDEX_TO_KEY: new Map()
  });

  vm.runInContext(
    [
      recorte(source, "function normalizeTextKey", "function normalizeAnexoTipoInput"),
      recorte(source, "function normalizeDocStatus", "function isDocxTemplateFailureMessage"),
      recorte(source, "function contratoDocSyncCompleted", "function isClickSignInvalidSignatureReference"),
      recorte(source, "function isAnexoTecnicoContratoDoc", "function buildContratoOneDriveFolderNames"),
      "globalThis.__sync = syncAnexoItemsEstadoFirmaDesdeDocsContrato;"
    ].join("\n"),
    context
  );
  return context.__sync;
}

function ejecutorFalso() {
  const queries = [];
  return {
    queries,
    async query(text, values) {
      // JSON round-trip: los arreglos nacen dentro del VM y no son comparables entre realms.
      queries.push({
        text: String(text).replace(/\s+/g, " ").trim(),
        values: JSON.parse(JSON.stringify(values))
      });
      return { rowCount: 0, rows: [] };
    }
  };
}

const anexoFirmado = {
  doc_index: 5,
  doc_key: "anexo_tecnico",
  estado: "signed",
  onedrive_url: "https://onedrive/anexo.pdf",
  anexo_item_ids: [11, 12]
};

test("marca firmados los items retratados cuando el anexo del paquete queda firmado y guardado", async () => {
  const sync = cargarSincronizador();
  const db = ejecutorFalso();

  await sync([{ doc_index: 1, doc_key: "confidencialidad", estado: "signed" }, anexoFirmado], db);

  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0].text, /estado_firma = 'firmado'/);
  assert.match(db.queries[0].text, /IS DISTINCT FROM 'firmado'/);
  assert.deepEqual(db.queries[0].values, [[11, 12]]);
});

test("la firma legal marca el anexo aunque OneDrive siga pendiente", async () => {
  const sync = cargarSincronizador();
  const db = ejecutorFalso();

  await sync([{ ...anexoFirmado, onedrive_url: "" }], db);

  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0].text, /estado_firma = 'firmado'/);
  assert.deepEqual(db.queries[0].values, [[11, 12]]);
});

test("devuelve los items a pendiente cuando la firma se rechaza", async () => {
  const sync = cargarSincronizador();
  const db = ejecutorFalso();

  await sync([{ ...anexoFirmado, estado: "rejected" }], db);

  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0].text, /estado_firma = 'pendiente'/);
  assert.deepEqual(db.queries[0].values, [[11, 12]]);
});

test("ignora los documentos del paquete que no son el anexo técnico", async () => {
  const sync = cargarSincronizador();
  const db = ejecutorFalso();

  await sync(
    [
      {
        doc_index: 2,
        doc_key: "contrato_prestacion_servicios",
        estado: "signed",
        onedrive_url: "https://onedrive/contrato.pdf",
        anexo_item_ids: [11, 12]
      }
    ],
    db
  );

  assert.deepEqual(db.queries, []);
});

test("no consulta la base si el documento no trae la foto de items", async () => {
  const sync = cargarSincronizador();
  const db = ejecutorFalso();

  await sync(
    [
      { ...anexoFirmado, anexo_item_ids: null },
      { ...anexoFirmado, anexo_item_ids: [] },
      { ...anexoFirmado, anexo_item_ids: [0, -3, "abc"] }
    ],
    db
  );

  assert.deepEqual(db.queries, []);
});
