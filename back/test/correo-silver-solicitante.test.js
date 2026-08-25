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
const thView = fs.readFileSync(
  path.resolve(__dirname, "../../front/views/onboardingTH.html"),
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

test("el correo Silver es obligatorio aunque la persona no requiera usuario del aplicativo", () => {
  const section3Start = backend.indexOf('"/contrataciones/solicitudes/:id/seccion-3"');
  const revisionStart = backend.indexOf("async function procesarRevisionTh", section3Start);
  const correoRouteStart = backend.indexOf('"/contrataciones/solicitudes/:id/correo-silver"', revisionStart);
  const section3 = backend.slice(section3Start, revisionStart);
  const revision = backend.slice(revisionStart, correoRouteStart);
  const assignStart = coordinacionFront.indexOf("puedeAsignarCorreoSilver(item)");
  const assignEnd = coordinacionFront.indexOf("abrirModalCorreoSilver", assignStart);
  const completarStart = thFront.indexOf("async completarRevisionContratacion()");
  const completarEnd = thFront.indexOf("async devolverContratacion()", completarStart);

  assert.match(section3, /const nextEstado = ESTADOS\.pendienteCorreoSilver/);
  assert.doesNotMatch(section3, /correoSilver \|\| !debeCrearUsuario/);
  assert.match(revision, /if \(personaIdContrat\)/);
  assert.match(revision, /SET correo_silver = \$1/);
  assert.doesNotMatch(backend.slice(correoRouteStart), /Esta solicitud no requiere crear un usuario Silver/);
  assert.doesNotMatch(coordinacionFront.slice(assignStart, assignEnd), /crear_usuario_sistema === false/);
  assert.doesNotMatch(thFront.slice(completarStart, completarEnd), /\/revision-th/);
  assert.match(thView, /El correo Silver lo registrará el solicitante original/);
});
