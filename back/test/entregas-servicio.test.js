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
      equipo_estimacion: "Comercial y consultoría"
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
  assert.equal(payload.detalle.forma_pago, "50% inicial y 50% contra entrega");
  assert.equal("analisis_adaptabilidad" in payload, false);
});

test("valida una tarifa por cada consultor seleccionado", () => {
  const payload = projectPayload();
  payload.consultores_ids = ["consultor-public-id"];
  payload.consultores_tarifas = {
    "consultor-public-id": {
      tarifa_consultoria: 200000,
      moneda_tarifa_consultoria: "USD",
      modulos_ids: ["modulo-public-id"],
      modulos_otros: []
    }
  };
  assert.deepEqual(validateEntregaPayload(payload).consultores_tarifas, payload.consultores_tarifas);

  payload.consultores_tarifas["consultor-public-id"].moneda_tarifa_consultoria = "GBP";
  assert.throws(() => validateEntregaPayload(payload), /moneda de la tarifa de consultoría no es válida/i);

  payload.consultores_tarifas["consultor-public-id"] = {
    tarifa_consultoria: "",
    moneda_tarifa_consultoria: "COP",
    modulos_ids: ["modulo-public-id"],
    modulos_otros: []
  };
  assert.throws(() => validateEntregaPayload(payload), /tarifa de cada consultor seleccionado es obligatoria/i);
});

test("exige consultor para outsourcing", () => {
  const payload = projectPayload();
  payload.tipo_servicio = "Outsorcing";
  payload.enlaces = [];
  payload.detalle = {
    tiempo_descripcion: "6 meses",
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
    { nombre: "Consultor por vincular", telefono: "3001234567", tarifa_consultoria: 5000000, moneda_tarifa_consultoria: "COP", modulos_ids: ["modulo-public-id"], modulos_otros: [] },
    { nombre: "Segundo consultor", telefono: "3019876543", tarifa_consultoria: 4500, moneda_tarifa_consultoria: "USD", modulos_ids: ["modulo-public-id"], modulos_otros: [] }
  ];
  payload.detalle = {
    tiempo_descripcion: "6 meses",
    valor_cliente: 7000000,
    moneda: "COP",
    tiene_contrato: false
  };

  const normalized = validateEntregaPayload(payload);
  assert.equal(normalized.consultores_ids.length, 0);
  assert.deepEqual(normalized.consultores_externos, payload.consultores_externos);
});

test("asigna uno o varios módulos seleccionados a cada consultor", () => {
  const payload = projectPayload();
  payload.modulos_ids = ["modulo-fi", "modulo-abap"];
  payload.modulos_otros = ["B1"];
  payload.consultores_ids = ["consultor-public-id"];
  payload.consultores_tarifas = {
    "consultor-public-id": {
      tarifa_consultoria: 200000,
      moneda_tarifa_consultoria: "COP",
      modulos_ids: ["modulo-fi", "modulo-abap"],
      modulos_otros: ["b1"]
    }
  };

  const normalized = validateEntregaPayload(payload);
  assert.deepEqual(normalized.consultores_tarifas["consultor-public-id"].modulos_ids, ["modulo-fi", "modulo-abap"]);
  assert.deepEqual(normalized.consultores_tarifas["consultor-public-id"].modulos_otros, ["B1"]);

  payload.consultores_tarifas["consultor-public-id"].modulos_ids = ["modulo-no-seleccionado"];
  assert.throws(() => validateEntregaPayload(payload), /no pertenecen a la entrega/i);
});

test("exige identificación y tarifa para consultores informativos", () => {
  const payload = projectPayload();
  payload.consultores_externos = [{ nombre: "Consultor sin teléfono", telefono: "", tarifa_consultoria: 100, moneda_tarifa_consultoria: "COP" }];
  assert.throws(() => validateEntregaPayload(payload), /teléfono del consultor no registrado/i);

  payload.consultores_externos = [{ nombre: "Consultor sin tarifa", telefono: "300", tarifa_consultoria: "", moneda_tarifa_consultoria: "COP" }];
  assert.throws(() => validateEntregaPayload(payload), /tarifa del consultor no registrado es obligatoria/i);
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

test("la migración agrega valor y moneda a la tarifa de consultoría", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-26-entregas-tarifa-consultoria.sql"),
    "utf8"
  );
  assert.match(migration, /tarifa_consultoria NUMERIC\(18,2\)/);
  assert.match(migration, /moneda_tarifa_consultoria VARCHAR\(3\)/);
});

test("la migración correctiva restaura la forma de pago textual", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-26-zz-restaurar-forma-pago-texto.sql"),
    "utf8"
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS forma_pago TEXT/);
  assert.match(migration, /ALTER COLUMN forma_pago SET NOT NULL/);
  assert.match(migration, /DROP COLUMN IF EXISTS valor_forma_pago/);
  assert.match(migration, /DROP COLUMN IF EXISTS moneda_forma_pago/);
});

test("la migración mueve perfil y tarifa a sus entidades correctas", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-28-entregas-perfil-tarifas-consultor.sql"),
    "utf8"
  );
  assert.match(migration, /ALTER TABLE clientes[\s\S]+perfil_cliente VARCHAR\(20\)/);
  assert.match(migration, /ALTER TABLE entregas_servicio_consultores[\s\S]+tarifa_consultoria NUMERIC\(18,2\)/);
  assert.match(migration, /ALTER COLUMN analisis_adaptabilidad DROP NOT NULL/);
  assert.match(migration, /ALTER COLUMN tarifa DROP NOT NULL/);
  assert.match(migration, /^BEGIN;[\s\S]+COMMIT;\s*$/);
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

test("coordinador solo acepta y administrador puede aceptar o devolver", () => {
  assert.deepEqual(_private.allowedReceptionStatuses("Coordinador"), ["ACEPTADA"]);
  assert.deepEqual(_private.allowedReceptionStatuses("Administrador"), ["ACEPTADA", "CANCELADA"]);
  assert.deepEqual(_private.allowedReceptionStatuses("Comercial"), []);
});

test("la ruta de creación queda reservada para Comercial", () => {
  const routeSource = fs.readFileSync(
    path.resolve(__dirname, "../src/routes/entregas-servicio.routes.js"),
    "utf8"
  );
  assert.match(routeSource, /const CREATE = requireAccess\(\{ roles: \["Comercial"\] \}\)/);
  assert.doesNotMatch(routeSource, /const CREATE[^\n]+Administrador/);
  assert.match(routeSource, /router\.patch\("\/:id\/asignacion", ADMIN, service\.reassignDelivery\)/);
  assert.match(routeSource, /router\.put\("\/:id\/rectificar", CREATE, service\.rectifyDelivery\)/);
});

test("la migración relaciona consultores con varios módulos de la entrega", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-09-01-entregas-consultores-modulos.sql"),
    "utf8"
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS entregas_servicio_consultores_modulos/);
  assert.match(migration, /PRIMARY KEY \(entrega_consultor_id, entrega_modulo_id\)/);
  assert.match(migration, /REFERENCES entregas_servicio_consultores\(id\) ON DELETE CASCADE/);
  assert.match(migration, /REFERENCES entregas_servicio_modulos\(id\) ON DELETE CASCADE/);
});

test("la rectificación se limita a entregas devueltas del Comercial", () => {
  const serviceSource = fs.readFileSync(
    path.resolve(__dirname, "../src/services/entregas-servicio.service.js"),
    "utf8"
  );
  assert.match(serviceSource, /AND creado_por = \$2 AND estado = 'CANCELADA'/);
  assert.match(serviceSource, /estado = 'REGISTRADA'/);
  assert.match(serviceSource, /rectificada: true,[\s\S]{0,180}coordinador: coordinator/);
});

test("el detalle muestra los campos específicos de mesa y outsourcing", () => {
  const viewSource = fs.readFileSync(
    path.resolve(__dirname, "../../front/views/entregas-servicio.html"),
    "utf8"
  );
  assert.match(viewSource, /detalle\.detalle_tarifas/);
  assert.match(viewSource, /detalleSeleccionado\?\.detalle\?\.forma_pago/);
  assert.match(viewSource, /detalleSeleccionado\?\.detalle\?\.valor_cliente/);
  assert.match(viewSource, /detalleSeleccionado\?\.detalle\?\.tiene_contrato/);
  assert.match(viewSource, /\['ERROR', 'PENDIENTE'\]\.includes\(item\.notificacion\?\.estado\)/);
});

test("el servicio no depende de cargas a OneDrive", () => {
  const serviceSource = fs.readFileSync(
    path.resolve(__dirname, "../src/services/entregas-servicio.service.js"),
    "utf8"
  );
  assert.doesNotMatch(serviceSource, /uploadEntregaPdf|entregas-servicio\.graph/);
});
