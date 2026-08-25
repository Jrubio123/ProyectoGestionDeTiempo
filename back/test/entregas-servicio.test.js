const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EntregaValidationError,
  normalizeNit,
  validateEntregaPayload
} = require("../src/services/entregas-servicio.domain");
const { _private } = require("../src/services/entregas-servicio.service");

function projectPayload() {
  return {
    tipo_servicio: "Proyecto",
    cliente_id: "cliente-public-id",
    coordinador_id: "coordinador-public-id",
    perfil_cliente: "CLAVE",
    analisis_adaptabilidad: "El cliente tiene equipo interno disponible.",
    contacto_nuevo: {
      nombre: "Ana Cliente",
      cargo: "Interventora",
      telefono: "3000000000"
    },
    consultores_ids: [],
    modulos_ids: ["modulo-public-id"],
    enlaces: [
      { titulo: "Propuesta comercial", url: "https://empresa.sharepoint.com/propuesta.pdf" }
    ],
    detalle: {
      nombre_proyecto: "Implementación ERP",
      objeto_proyecto: "Implementar los módulos contratados.",
      valor_total: 1000000,
      moneda: "COP",
      forma_pago: "50% inicial y 50% contra entrega",
      equipo_estimacion: "Comercial y consultoría",
      tarifas_consultoria: "Consultor senior: 200.000/hora"
    }
  };
}

test("normaliza el NIT antes de persistirlo", () => {
  assert.equal(normalizeNit(" 900.123.456-7 "), "9001234567");
});

test("acepta una entrega de proyecto con enlaces comerciales", () => {
  const payload = validateEntregaPayload(projectPayload());
  assert.equal(payload.tipo_servicio, "PROYECTO");
  assert.equal(payload.nombre_servicio, "Implementación ERP");
  assert.deepEqual(payload.enlaces, [
    { titulo: "Propuesta comercial", url: "https://empresa.sharepoint.com/propuesta.pdf" }
  ]);
});

test("exige consultor para outsourcing", () => {
  const payload = projectPayload();
  payload.tipo_servicio = "Outsorcing";
  payload.enlaces = [];
  payload.detalle = {
    tiempo_descripcion: "6 meses",
    tarifa: 5000000,
    valor_cliente: 7000000,
    moneda: "COP",
    tiene_contrato: true
  };

  assert.throws(
    () => validateEntregaPayload(payload),
    (error) => error instanceof EntregaValidationError && /requiere al menos un consultor/i.test(error.message)
  );
});

test("acepta consultores informativos sin crear usuarios", () => {
  const payload = projectPayload();
  payload.tipo_servicio = "Outsourcing";
  payload.enlaces = [];
  payload.consultores_externos = [
    { nombre: "Consultor por vincular", telefono: "3001234567" },
    { nombre: "Segundo consultor", telefono: "3019876543" }
  ];
  payload.detalle = {
    tiempo_descripcion: "6 meses",
    tarifa: 5000000,
    valor_cliente: 7000000,
    moneda: "COP",
    tiene_contrato: false
  };

  const normalized = validateEntregaPayload(payload);
  assert.equal(normalized.consultores_ids.length, 0);
  assert.deepEqual(normalized.consultores_externos, payload.consultores_externos);
});

test("exige nombre y teléfono para consultores informativos", () => {
  const payload = projectPayload();
  payload.consultores_externos = [{ nombre: "Consultor sin teléfono", telefono: "" }];
  assert.throws(() => validateEntregaPayload(payload), /teléfono del consultor no registrado/i);
});

test("exige un enlace comercial para proyecto y mesa", () => {
  const payload = projectPayload();
  payload.enlaces = [];
  assert.throws(() => validateEntregaPayload(payload), /al menos un enlace comercial/i);
});

test("acepta varios enlaces y rechaza protocolos no seguros", () => {
  const payload = projectPayload();
  payload.enlaces.push({ titulo: "Carpeta comercial", url: "https://empresa.sharepoint.com/carpeta" });
  assert.equal(validateEntregaPayload(payload).enlaces.length, 2);

  payload.enlaces[1].url = "ftp://empresa.com/carpeta";
  assert.throws(() => validateEntregaPayload(payload), /enlace comercial no es válido/i);
});

test("la migración crea el núcleo relacional de entregas", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-25-entregas-servicio.sql"),
    "utf8"
  );
  for (const table of [
    "contactos_cliente",
    "entregas_servicio",
    "entregas_servicio_consultores",
    "entregas_servicio_modulos",
    "entregas_servicio_documentos",
    "entregas_servicio_notificaciones"
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});

test("la migración permite consultores informativos separados de usuarios", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-25-z-entregas-consultores-externos.sql"),
    "utf8"
  );
  assert.match(migration, /nombre_externo VARCHAR\(255\)/);
  assert.match(migration, /telefono_externo VARCHAR\(50\)/);
  assert.match(migration, /ALTER COLUMN consultor_id DROP NOT NULL/);
});

test("la migración crea almacenamiento exclusivo para varios enlaces", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-25-zz-entregas-enlaces.sql"),
    "utf8"
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS entregas_servicio_enlaces/);
  assert.match(migration, /UNIQUE \(entrega_servicio_id, url\)/);
});

test("limita la consulta según el rol operativo", () => {
  assert.deepEqual(
    _private.visibilitySql({ user: { rol: "Administrador", id: 1 } }),
    { clause: "", params: [] }
  );
  assert.deepEqual(
    _private.visibilitySql({ user: { rol: "Coordinador", id: 20 } }),
    { clause: "AND e.coordinador_asignado_id = $1", params: [20] }
  );
  assert.deepEqual(
    _private.visibilitySql({ user: { rol: "Comercial", id: 30 } }),
    { clause: "AND e.creado_por = $1", params: [30] }
  );
});

test("la ruta de creación queda reservada para Comercial", () => {
  const routeSource = fs.readFileSync(
    path.resolve(__dirname, "../src/routes/entregas-servicio.routes.js"),
    "utf8"
  );
  assert.match(routeSource, /const CREATE = requireAccess\(\{ roles: \["Comercial"\] \}\)/);
  assert.doesNotMatch(routeSource, /const CREATE[^\n]+Administrador/);
});

test("el servicio no depende de cargas a OneDrive", () => {
  const serviceSource = fs.readFileSync(
    path.resolve(__dirname, "../src/services/entregas-servicio.service.js"),
    "utf8"
  );
  assert.doesNotMatch(serviceSource, /uploadEntregaPdf|entregas-servicio\.graph/);
});
