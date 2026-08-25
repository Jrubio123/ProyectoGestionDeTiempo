const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backend = fs.readFileSync(
  path.resolve(__dirname, "../src/contrataciones-routes.js"),
  "utf8"
);
const webhook = fs.readFileSync(
  path.resolve(__dirname, "../src/services/microsoft-group-webhook.service.js"),
  "utf8"
);
const coordinacionFront = fs.readFileSync(
  path.resolve(__dirname, "../../front/js/preregistros-coord.js"),
  "utf8"
);
const coordinacionView = fs.readFileSync(
  path.resolve(__dirname, "../../front/views/preregistrosCoord.html"),
  "utf8"
);
const thFront = fs.readFileSync(
  path.resolve(__dirname, "../../front/js/onboarding-th.js"),
  "utf8"
);

test("el solicitante original registra el correo Silver desde su bandeja", () => {
  assert.match(backend, /\/contrataciones\/solicitudes\/:id\/correo-silver/);
  assert.match(backend, /Solo el solicitante original puede registrar el correo Silver/);
  assert.match(backend, /row\.estado !== ESTADOS\.pendienteCorreoSilver/);
  assert.match(backend, /correo_silver_origen', \$7::text/);
  assert.match(coordinacionFront, /puedeAsignarCorreoSilver\(item\)/);
  assert.match(coordinacionView, />Asignar correo Silver<\/button>/);
});

test("TH entrega el caso y notifica cuando solo falta el correo Silver", () => {
  assert.match(backend, /buildMailCorreoSilverPendiente/);
  assert.match(backend, /debeNotificarCorreoSilver/);
  assert.match(backend, /buildPortalUrl\("preregistrosCoord"\)/);
  assert.match(thFront, /return estado === "pendiente revision th";/);
  assert.match(thFront, /return "Esperando correo Silver";/);
});

test("Power Automate conserva la finalizacion automatica y la accion manual queda como respaldo", () => {
  const syncBody = webhook.slice(webhook.indexOf("async function syncConsultoresGroupMember"));
  assert.match(syncBody, /completePendingSolicitud\(/);
  assert.match(syncBody, /registerIdentityOnPendingSolicitud\(/);
  assert.match(backend, /\/contrataciones\/solicitudes\/:id\/correo-silver/);
});
