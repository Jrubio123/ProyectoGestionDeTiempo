const test = require("node:test");
const assert = require("node:assert/strict");

const {
  upsertPersonaDesdeContratacion
} = require("../src/services/persona-contratacion.service");

test("materializa la persona por documento antes de crear su usuario", async () => {
  let captured = null;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ id: 25, public_id: "persona-public-id" }] };
    }
  };

  const result = await upsertPersonaDesdeContratacion(db, {
    numero_documento: " 123456 ",
    nombre: "Ana",
    pais_residencia: "Colombia",
    tipo_persona: "Natural",
    factura_en_colombia: false,
    modulo_otro: "Módulo especial",
    preregistro_id: 18,
    created_by: 4
  });

  assert.deepEqual(result, { id: 25, public_id: "persona-public-id" });
  assert.equal(captured.params[0], "123456");
  assert.equal(captured.params[8], "Colombia");
  assert.equal(captured.params[10], false);
  assert.equal(captured.params[15], "Módulo especial");
  assert.equal(captured.params[23], 18);
  assert.match(captured.sql, /ON CONFLICT \(numero_documento\) DO UPDATE/);
  assert.match(captured.sql, /estado\s+= 'activo'/);
});

test("rechaza materializar una persona sin documento", async () => {
  let called = false;
  await assert.rejects(
    () => upsertPersonaDesdeContratacion(
      { query: async () => { called = true; } },
      { numero_documento: " " }
    ),
    (error) => error.code === "PERSONA_DOCUMENTO_REQUIRED" && error.statusCode === 422
  );
  assert.equal(called, false);
});
