const test = require("node:test");
const assert = require("node:assert/strict");

const {
  reiniciarDocumentosCuenta
} = require("../src/services/cuentas-cobro.service");

function createJsonResponse() {
  const response = { statusCode: 200, body: null };
  return {
    response,
    res: {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(body) {
        response.body = body;
        return body;
      }
    }
  };
}

function createPool(cuenta) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("SELECT id, public_id, datos_adjuntos")) {
        return { rows: cuenta ? [cuenta] : [] };
      }
      if (text.includes("UPDATE cuenta_cobro")) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    }
  };
  return {
    calls,
    pool: { connect: async () => client },
    wasReleased: () => released
  };
}

const requestBase = {
  params: { id: "9efaf41f-1111-4111-8111-111111111111" },
  body: { confirmacion: "REINICIAR_DOCUMENTOS" },
  user: {
    id: 7,
    email: "coordinadora@example.com",
    rol: "Coordinador"
  }
};

test("reinicia firma y soportes, conserva otros datos y deja auditoría", async () => {
  const cuenta = {
    id: 9,
    public_id: requestBase.params.id,
    datos_adjuntos: {
      metadata: { origen: "cuenta" },
      firma: { documento_firmado: { url: "https://onedrive/firma.pdf" } },
      soportes: { documentos_manuales: [{ url: "https://onedrive/soporte.pdf" }] }
    }
  };
  const mock = createPool(cuenta);
  const { response, res } = createJsonResponse();

  await reiniciarDocumentosCuenta(requestBase, res, {
    pool: mock.pool,
    helpers: { isGuid: () => true }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  const update = mock.calls.find(({ sql }) => sql.includes("UPDATE cuenta_cobro"));
  assert.ok(update);
  assert.match(update.sql, /estado = 'Pendiente'/);

  const nuevosAdjuntos = JSON.parse(update.params[0]);
  assert.deepEqual(nuevosAdjuntos.metadata, { origen: "cuenta" });
  assert.equal("firma" in nuevosAdjuntos, false);
  assert.equal("soportes" in nuevosAdjuntos, false);
  assert.equal(nuevosAdjuntos.reinicios_documentos.length, 1);
  assert.equal(nuevosAdjuntos.reinicios_documentos[0].reiniciado_por.usuario_id, 7);
  assert.equal(mock.wasReleased(), true);
});

test("exige la confirmación antes de abrir una transacción", async () => {
  let connectCalls = 0;
  const { response, res } = createJsonResponse();

  await reiniciarDocumentosCuenta(
    { ...requestBase, body: {} },
    res,
    {
      pool: {
        connect: async () => {
          connectCalls += 1;
          throw new Error("No debe conectarse");
        }
      },
      helpers: { isGuid: () => true }
    }
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "Confirmación inválida");
  assert.equal(connectCalls, 0);
});

test("no cambia cuentas que ya no tienen firma ni soportes", async () => {
  const mock = createPool({
    id: 9,
    public_id: requestBase.params.id,
    datos_adjuntos: { reinicios_documentos: [] }
  });
  const { response, res } = createJsonResponse();

  await reiniciarDocumentosCuenta(requestBase, res, {
    pool: mock.pool,
    helpers: { isGuid: () => true }
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, "La cuenta no tiene documentos para reiniciar");
  assert.equal(mock.calls.some(({ sql }) => sql.includes("UPDATE cuenta_cobro")), false);
  assert.equal(mock.wasReleased(), true);
});
