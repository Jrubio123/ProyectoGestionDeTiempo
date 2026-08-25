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

test("el correo Silver sigue siendo obligatorio para una persona nueva aunque no requiera acceso", () => {
  const section3Start = backend.indexOf('"/contrataciones/solicitudes/:id/seccion-3"');
  const revisionStart = backend.indexOf("async function procesarRevisionTh", section3Start);
  const correoRouteStart = backend.indexOf('"/contrataciones/solicitudes/:id/correo-silver"', revisionStart);
  const section3 = backend.slice(section3Start, revisionStart);
  const revision = backend.slice(revisionStart, correoRouteStart);
  const assignStart = coordinacionFront.indexOf("puedeAsignarCorreoSilver(item)");
  const assignEnd = coordinacionFront.indexOf("abrirModalCorreoSilver", assignStart);
  const completarStart = thFront.indexOf("async completarRevisionContratacion()");
  const completarEnd = thFront.indexOf("async devolverContratacion()", completarStart);

  assert.match(section3, /resolveExistingSilverIdentity\(client, row\)/);
  assert.match(section3, /: ESTADOS\.pendienteCorreoSilver/);
  assert.doesNotMatch(section3, /correoSilver \|\| !debeCrearUsuario/);
  assert.match(revision, /if \(personaIdContrat\)/);
  assert.match(revision, /SET correo_silver = \$1/);
  assert.doesNotMatch(backend.slice(correoRouteStart), /Esta solicitud no requiere crear un usuario Silver/);
  assert.doesNotMatch(coordinacionFront.slice(assignStart, assignEnd), /crear_usuario_sistema === false/);
  assert.match(thFront.slice(completarStart, completarEnd), /estadoDespuesDeGuardar === "Pendiente Revision TH"/);
  assert.match(thFront.slice(completarStart, completarEnd), /\/revision-th/);
  assert.match(thView, /tieneCorreoSilverExistenteContratacion/);
  assert.match(thView, /El correo Silver lo registrará el solicitante original/);
});

test("la contratación directa busca tanto personas como usuarios", () => {
  const searchStart = backend.indexOf('"/contrataciones/personas"');
  const searchEnd = backend.indexOf('"/contrataciones/solicitudes"', searchStart);
  const searchRoute = backend.slice(searchStart, searchEnd);

  assert.match(searchRoute, /FROM personas p/);
  assert.match(searchRoute, /LEFT JOIN usuarios u ON u\.persona_id = p\.id/);
  assert.match(searchRoute, /usuarios_sin_persona/);
  assert.match(searchRoute, /persona_id: row\.persona_public_id/);
  assert.match(coordinacionFront, /this\.form\.persona_id = persona\.persona_id/);
});

test("la busqueda de personas recupera documento y telefono desde el historial", () => {
  const searchStart = backend.indexOf('"/contrataciones/personas"');
  const searchEnd = backend.indexOf('"/contrataciones/solicitudes"', searchStart);
  const searchRoute = backend.slice(searchStart, searchEnd);

  assert.match(searchRoute, /context\?\.numero_documento/);
  assert.match(searchRoute, /context\?\.telefono/);
  assert.match(searchRoute, /context\?\.tipo_documento_id/);
  assert.match(coordinacionFront, /resolverTipoDocumentoId\(persona\)/);
  assert.match(coordinacionFront, /persona\.numero_contacto/);
});
