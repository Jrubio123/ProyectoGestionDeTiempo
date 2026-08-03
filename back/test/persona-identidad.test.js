const test = require("node:test");
const assert = require("node:assert/strict");

const { findCorreoPersonaConflict } = require("../src/services/persona-identidad.service");

test("busca conflictos de correo en todas las fuentes de identidad", async () => {
  let captured = null;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ fuente: "personas" }] };
    }
  };

  const result = await findCorreoPersonaConflict(db, {
    correo: " Persona@Correo.com ",
    numeroDocumento: "123",
    excludePreregistroId: 7,
    excludeSolicitudId: 9
  });

  assert.equal(result.fuente, "personas");
  assert.deepEqual(captured.params, ["persona@correo.com", "123", 7, 9]);
  assert.match(captured.sql, /FROM personas p/);
  assert.match(captured.sql, /FROM preregistro_personas pp/);
  assert.match(captured.sql, /FROM solicitudes_contratacion sc/);
  assert.match(captured.sql, /FROM usuarios u/);
  assert.match(captured.sql, /\$2::text IS NULL/);
});

test("omite la consulta si no hay correo", async () => {
  let called = false;
  const result = await findCorreoPersonaConflict(
    { query: async () => { called = true; } },
    { correo: "" }
  );

  assert.equal(result, null);
  assert.equal(called, false);
});
