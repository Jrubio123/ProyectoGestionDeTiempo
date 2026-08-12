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

  const llamadas = { buscar: 0 };
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    extractClickSignDocumentStatus: () => ({ status: "", rawStatus: "" }),
    extractClickSignSignatureId: () => "",
    async findContratoProcessByClickSignIdentifiers() {
      llamadas.buscar += 1;
      return proceso;
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
