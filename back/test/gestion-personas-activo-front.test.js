const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.resolve(__dirname, "../../front/js/gestion-personas.js");

function createApp(role = "admin") {
  global.window = {
    auth: {
      getRoleKey: () => role,
      getToken: () => "token"
    }
  };
  delete require.cache[scriptPath];
  require(scriptPath);
  return global.window.gestionPersonasApp();
}

test("convierte el estado activo del select a booleano antes de enviarlo", async () => {
  const app = createApp();
  app.puedeCambiarActivo = true;
  app.ficha = { id: "persona-id" };
  app.draft.identidad = {
    nombre_usuario: "Persona",
    email: "persona@empresa.com",
    rol_id: "rol-id",
    activo: "false",
    azure_oid: ""
  };
  app.endpointFicha = () => "http://localhost/admin/personas/persona-id";
  let sentPayload = null;
  global.axios = {
    put: async (_url, payload) => { sentPayload = payload; },
    get: async () => ({ data: { id: "persona-id", activo: false } })
  };

  await app.guardar("identidad");

  assert.equal(sentPayload.activo, false);
  assert.equal(typeof sentPayload.activo, "boolean");
});

test("Talento Humano no envía activo al editar la identidad", async () => {
  const app = createApp("talento_humano");
  app.puedeCambiarActivo = false;
  app.ficha = { id: "persona-id" };
  app.draft.identidad = {
    nombre_usuario: "Persona",
    email: "persona@empresa.com",
    rol_id: "rol-id",
    activo: "true"
  };
  app.endpointFicha = () => "http://localhost/admin/personas/persona-id";
  let sentPayload = null;
  global.axios = {
    put: async (_url, payload) => { sentPayload = payload; },
    get: async () => ({ data: { id: "persona-id" } })
  };

  await app.guardar("identidad");

  assert.equal(Object.prototype.hasOwnProperty.call(sentPayload, "activo"), false);
});

