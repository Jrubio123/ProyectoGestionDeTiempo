const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function cargarGettersEstado(pool) {
  const indexPath = path.resolve(__dirname, "../src/index.js");
  const source = fs.readFileSync(indexPath, "utf8");
  const start = source.indexOf("function buildEstadoEnumUnresolvedError");
  const end = source.indexOf("function normalizeClickSignStatus", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const context = vm.createContext({ __pool: pool });
  vm.runInContext(
    `
      let estadoCuentaCobroEnFirmaCache = null;
      let estadoCuentaCobroAprobadoCache = null;
      const pool = __pool;
      function normalizeEnumLabel(value) {
        return String(value || "")
          .normalize("NFD")
          .replace(/[\\u0300-\\u036f]/g, "")
          .replace(/\\s+/g, "")
          .toLowerCase()
          .trim();
      }
      ${source.slice(start, end)}
      globalThis.__getters = {
        getCuentaCobroEstadoEnFirma,
        getCuentaCobroEstadoAprobado
      };
    `,
    context
  );
  return context.__getters;
}

test("estado En Firma falla cerrado y no cachea una resolucion invalida", async () => {
  let calls = 0;
  const pool = {
    query: async () => {
      calls += 1;
      return calls === 1
        ? { rows: [
          { enumlabel: "Pendiente" },
          { enumlabel: "Aprobado" },
          { enumlabel: "Revisión" }
        ] }
        : { rows: [{ enumlabel: "Pendiente" }, { enumlabel: "En_Firma" }] };
    }
  };
  const { getCuentaCobroEstadoEnFirma } = cargarGettersEstado(pool);

  await assert.rejects(
    getCuentaCobroEstadoEnFirma(),
    (err) => err?.code === "ESTADO_ENUM_UNRESOLVED"
  );
  assert.equal(await getCuentaCobroEstadoEnFirma(), "En_Firma");
  assert.equal(await getCuentaCobroEstadoEnFirma(), "En_Firma");
  assert.equal(calls, 2);
});

test("estado Aprobado no acepta En Firma y no cachea una resolucion invalida", async () => {
  let calls = 0;
  const pool = {
    query: async () => {
      calls += 1;
      return calls === 1
        ? { rows: [
          { enumlabel: "Pendiente" },
          { enumlabel: "En_Firma" },
          { enumlabel: "Pagado" }
        ] }
        : { rows: [{ enumlabel: "Pendiente" }, { enumlabel: "Aprobado" }] };
    }
  };
  const { getCuentaCobroEstadoAprobado } = cargarGettersEstado(pool);

  await assert.rejects(
    getCuentaCobroEstadoAprobado(),
    (err) => err?.code === "ESTADO_ENUM_UNRESOLVED"
  );
  assert.equal(await getCuentaCobroEstadoAprobado(), "Aprobado");
  assert.equal(await getCuentaCobroEstadoAprobado(), "Aprobado");
  assert.equal(calls, 2);
});

for (const [nombre, getter] of [
  ["En Firma", "getCuentaCobroEstadoEnFirma"],
  ["Aprobado", "getCuentaCobroEstadoAprobado"]
]) {
  test(`estado ${nombre} relanza errores de consulta sin cachearlos`, async () => {
    const queryError = new Error("DB temporalmente no disponible");
    let calls = 0;
    const pool = {
      query: async () => {
        calls += 1;
        if (calls === 1) throw queryError;
        return {
          rows: [{
            enumlabel: nombre === "En Firma" ? "En_Firma" : "Aprobado"
          }]
        };
      }
    };
    const getters = cargarGettersEstado(pool);

    await assert.rejects(getters[getter](), (err) => err === queryError);
    assert.equal(await getters[getter](), nombre === "En Firma" ? "En_Firma" : "Aprobado");
    assert.equal(calls, 2);
  });
}
