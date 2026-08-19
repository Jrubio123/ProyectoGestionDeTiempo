const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MicrosoftIdentitySyncError,
  normalizeCorporateEmail,
  syncMicrosoftIdentity
} = require("../src/services/microsoft-identity-sync.service");

function scriptedDb(steps) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const step = steps[calls.length];
      assert.ok(step, `Consulta inesperada: ${String(sql).slice(0, 80)}`);
      assert.match(String(sql), step.match);
      calls.push({ sql: String(sql), params });
      return typeof step.result === "function"
        ? step.result({ sql: String(sql), params })
        : (step.result || { rows: [] });
    }
  };
}

const baseIdentity = {
  oid: "11111111-1111-4111-8111-111111111111",
  email: " Persona@Silver.com ",
  displayName: "Persona Silver",
  givenName: "Persona",
  surname: "Silver",
  phone: "3000000000",
  defaultRoleId: 3
};

test("normaliza el correo corporativo", () => {
  assert.equal(normalizeCorporateEmail(" Persona@Silver.com "), "persona@silver.com");
});

test("sincroniza un usuario que ya está relacionado con su persona", async () => {
  const db = scriptedDb([
    { match: /pg_advisory_xact_lock/ },
    {
      match: /FROM usuarios u/,
      result: {
        rows: [{
          id: 10,
          public_id: "usuario-10",
          email: "anterior@silver.com",
          azure_oid: baseIdentity.oid,
          activo: true,
          persona_id: 20,
          rol_usuario_id: 3,
          rol: "Consultor"
        }]
      }
    },
    {
      match: /FROM personas\s+WHERE id = \$1/,
      result: { rows: [{ id: 20, public_id: "persona-20", correo_silver: null }] }
    },
    { match: /FROM usuarios\s+WHERE persona_id = \$1/, result: { rows: [] } },
    {
      match: /UPDATE personas/,
      result: { rows: [{ id: 20, public_id: "persona-20", correo_silver: "persona@silver.com" }] }
    },
    {
      match: /UPDATE usuarios/,
      result: {
        rows: [{
          id: 10,
          public_id: "usuario-10",
          nombre_usuario: "Persona Silver",
          email: "persona@silver.com",
          rol_usuario_id: 3,
          rol: "Consultor",
          activo: true,
          persona_id: 20,
          azure_oid: baseIdentity.oid
        }]
      }
    }
  ]);

  const result = await syncMicrosoftIdentity(db, baseIdentity);

  assert.equal(result.persona_id, 20);
  assert.equal(result.email, "persona@silver.com");
  assert.deepEqual(db.calls.at(-1).params.slice(0, 3), [
    baseIdentity.oid,
    "persona@silver.com",
    "Persona Silver"
  ]);
});

test("vincula una persona existente por correo Silver y crea su usuario", async () => {
  const db = scriptedDb([
    { match: /pg_advisory_xact_lock/ },
    { match: /FROM usuarios u/, result: { rows: [] } },
    {
      match: /LOWER\(BTRIM\(correo_silver\)\)/,
      result: {
        rows: [{ id: 30, public_id: "persona-30", correo_silver: "persona@silver.com" }]
      }
    },
    { match: /FROM usuarios\s+WHERE persona_id = \$1/, result: { rows: [] } },
    {
      match: /UPDATE personas/,
      result: {
        rows: [{ id: 30, public_id: "persona-30", correo_silver: "persona@silver.com" }]
      }
    },
    {
      match: /INSERT INTO usuarios/,
      result: {
        rows: [{
          id: 40,
          public_id: "usuario-40",
          nombre_usuario: "Persona Silver",
          email: "persona@silver.com",
          rol_usuario_id: 3,
          rol: "Consultor",
          activo: true,
          persona_id: 30,
          azure_oid: baseIdentity.oid
        }]
      }
    }
  ]);

  const result = await syncMicrosoftIdentity(db, baseIdentity);

  assert.equal(result.persona_id, 30);
  assert.equal(db.calls.at(-1).params.at(-1), 30);
});

test("crea persona y usuario cuando la identidad no existe", async () => {
  const db = scriptedDb([
    { match: /pg_advisory_xact_lock/ },
    { match: /FROM usuarios u/, result: { rows: [] } },
    { match: /LOWER\(BTRIM\(correo_silver\)\)/, result: { rows: [] } },
    {
      match: /INSERT INTO personas/,
      result: {
        rows: [{ id: 50, public_id: "persona-50", correo_silver: "persona@silver.com" }]
      }
    },
    {
      match: /INSERT INTO usuarios/,
      result: {
        rows: [{
          id: 60,
          public_id: "usuario-60",
          nombre_usuario: "Persona Silver",
          email: "persona@silver.com",
          rol_usuario_id: 3,
          rol: "Consultor",
          activo: true,
          persona_id: 50,
          azure_oid: baseIdentity.oid
        }]
      }
    }
  ]);

  const result = await syncMicrosoftIdentity(db, baseIdentity);

  assert.equal(result.persona_id, 50);
  assert.deepEqual(db.calls[3].params, ["Persona", "Silver", "persona@silver.com"]);
});

test("crea y vincula la persona cuando el usuario ya existe sin persona_id", async () => {
  const db = scriptedDb([
    { match: /pg_advisory_xact_lock/ },
    {
      match: /FROM usuarios u/,
      result: {
        rows: [{
          id: 65,
          public_id: "usuario-65",
          email: "persona@silver.com",
          azure_oid: baseIdentity.oid,
          activo: true,
          persona_id: null,
          rol_usuario_id: 3,
          rol: "Consultor"
        }]
      }
    },
    { match: /LOWER\(BTRIM\(correo_silver\)\)/, result: { rows: [] } },
    {
      match: /INSERT INTO personas/,
      result: {
        rows: [{ id: 66, public_id: "persona-66", correo_silver: "persona@silver.com" }]
      }
    },
    {
      match: /UPDATE usuarios/,
      result: {
        rows: [{
          id: 65,
          public_id: "usuario-65",
          nombre_usuario: "Persona Silver",
          email: "persona@silver.com",
          rol_usuario_id: 3,
          rol: "Consultor",
          activo: true,
          persona_id: 66,
          azure_oid: baseIdentity.oid
        }]
      }
    }
  ]);

  const result = await syncMicrosoftIdentity(db, baseIdentity);

  assert.equal(result.id, 65);
  assert.equal(result.persona_id, 66);
  assert.equal(db.calls.at(-1).params[4], 66);
});

test("rechaza una cuenta desactivada sin modificar la persona", async () => {
  const db = scriptedDb([
    { match: /pg_advisory_xact_lock/ },
    {
      match: /FROM usuarios u/,
      result: {
        rows: [{
          id: 70,
          email: "persona@silver.com",
          azure_oid: baseIdentity.oid,
          activo: false,
          persona_id: 80
        }]
      }
    }
  ]);

  await assert.rejects(
    () => syncMicrosoftIdentity(db, baseIdentity),
    (error) => {
      assert.ok(error instanceof MicrosoftIdentitySyncError);
      assert.equal(error.statusCode, 403);
      return true;
    }
  );
  assert.equal(db.calls.length, 2);
});

test("rechaza un correo asociado a otro azure_oid", async () => {
  const db = scriptedDb([
    { match: /pg_advisory_xact_lock/ },
    {
      match: /FROM usuarios u/,
      result: {
        rows: [{
          id: 90,
          email: "persona@silver.com",
          azure_oid: "22222222-2222-4222-8222-222222222222",
          activo: true,
          persona_id: null
        }]
      }
    }
  ]);

  await assert.rejects(
    () => syncMicrosoftIdentity(db, baseIdentity),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /otra identidad/);
      return true;
    }
  );
});
