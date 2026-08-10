const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  normalizeTipoCuentaKey,
  resolveTipoCuentaBancaria
} = require("../src/services/tipo-cuenta-bancaria.service");

test("normaliza Ahorros contra un catálogo llamado Cuenta de Ahorros", async () => {
  const db = {
    async query(sql) {
      if (sql.includes("public_id::text = $1")) return { rows: [] };
      return {
        rows: [
          { id: 1, public_id: "cuenta-ahorros", titulo: "Cuenta de Ahorros" },
          { id: 2, public_id: "cuenta-corriente", titulo: "Cuenta Corriente" }
        ]
      };
    }
  };

  assert.equal(normalizeTipoCuentaKey("Ahorros"), "ahorros");
  assert.equal(normalizeTipoCuentaKey("Cuenta de Ahorros"), "ahorros");
  const resolved = await resolveTipoCuentaBancaria(db, {
    tipoCuentaNombre: "Ahorros",
    required: true
  });
  assert.equal(resolved.id, 1);
});

test("rechaza completar con un tipo de cuenta que no existe", async () => {
  const db = { async query() { return { rows: [] }; } };
  await assert.rejects(
    () => resolveTipoCuentaBancaria(db, { tipoCuentaNombre: "Cripto", required: true }),
    (error) => error?.code === "TIPO_CUENTA_INVALIDO" && error?.status === 400
  );
});

test("onboarding precarga el ID de catálogo desde un valor histórico", (t) => {
  const frontPath = path.resolve(__dirname, "../../front/js/onboarding-th.js");
  const previousWindow = global.window;
  t.after(() => {
    global.window = previousWindow;
    delete require.cache[frontPath];
  });

  global.window = { API_BASE: "http://test" };
  delete require.cache[frontPath];
  require(frontPath);
  const app = global.window.onboardingThApp();
  app.tiposCuenta = [{ id: "uuid-ahorros", titulo: "Cuenta de Ahorros" }];
  app.abrirDetalle({
    banco: { id: "banco-1" },
    direccion: "Calle 1",
    tipo_persona: "Natural",
    tipo_cuenta: "Ahorros",
    numero_cuenta: "123"
  });

  assert.equal(app.formS3.tipo_cuenta_id, "uuid-ahorros");
  const payload = app.buildS3Payload();
  assert.equal(payload.tipo_cuenta_id, "uuid-ahorros");
  assert.equal(payload.tipo_cuenta, "Cuenta de Ahorros");
});

test("gestión de personas diferencia Vinculado, Todosilver y persona sin usuario", (t) => {
  const frontPath = path.resolve(__dirname, "../../front/js/gestion-personas.js");
  const previousWindow = global.window;
  t.after(() => {
    global.window = previousWindow;
    delete require.cache[frontPath];
  });

  global.window = { API_BASE: "http://test" };
  delete require.cache[frontPath];
  require(frontPath);
  const app = global.window.gestionPersonasApp();

  app.ficha = {
    registro_tipo: "persona",
    persona_public_id: "persona-1",
    tipo_vinculacion: "Todosilver",
    cargo_actual: "ABAP",
    responsable_actual: "Supervisora",
    moneda_relacion: "USD",
    tarifa_mes: 1000
  };
  assert.equal(app.fichaSinUsuario, true);
  assert.equal(app.fichaEsVinculada, false);
  assert.equal(app.cargoActual, "ABAP");
  assert.equal(app.responsableActual, "Supervisora");
  assert.equal(app.monedaRelacion, "USD");
  assert.match(app.endpointFicha(), /\/admin\/personas\/p\/persona-1$/);

  app.ficha = { registro_tipo: "usuario", usuario_id: "usuario-1", tipo_vinculacion: "Vinculado" };
  assert.equal(app.fichaSinUsuario, false);
  assert.equal(app.fichaEsVinculada, true);
  assert.match(app.endpointFicha(), /\/admin\/personas\/usuario-1$/);
});

test("la ficha consulta datos laborales y la vista los oculta para Todosilver", () => {
  const index = fs.readFileSync(path.resolve(__dirname, "../src/index.js"), "utf8");
  const html = fs.readFileSync(
    path.resolve(__dirname, "../../front/views/gestion-personas.html"),
    "utf8"
  );
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-10-personas-cuenta-y-moneda.sql"),
    "utf8"
  );

  assert.match(index, /p\.tipo_trabajador/);
  assert.match(index, /p\.salario_mensual/);
  assert.match(index, /p\.jefe_inmediato/);
  assert.match(index, /FULL JOIN personas p ON p\.id = u\.persona_id/);
  assert.match(html, /x-show="fichaEsVinculada"/);
  assert.match(html, /Responsable \/ supervisor/);
  assert.match(migration, /UPDATE personas persona/);
  assert.match(migration, /tipo_cuenta_id IS NULL/);
});
