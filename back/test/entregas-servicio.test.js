const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EntregaValidationError,
  normalizeNit,
  validateEntregaPayload
} = require("../src/services/entregas-servicio.domain");
const {
  encodeGraphPath,
  sanitizePathSegment
} = require("../src/services/entregas-servicio.graph");
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
    propuesta_url: "https://empresa.sharepoint.com/propuesta.pdf",
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

test("acepta una entrega de proyecto con enlace de propuesta", () => {
  const payload = validateEntregaPayload(projectPayload());
  assert.equal(payload.tipo_servicio, "PROYECTO");
  assert.equal(payload.nombre_servicio, "Implementación ERP");
  assert.equal(payload.propuesta_url, "https://empresa.sharepoint.com/propuesta.pdf");
});

test("exige consultor para outsourcing", () => {
  const payload = projectPayload();
  payload.tipo_servicio = "Outsorcing";
  payload.propuesta_url = "";
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

test("exige propuesta comercial para proyecto y mesa", () => {
  const payload = projectPayload();
  payload.propuesta_url = "";
  assert.throws(() => validateEntregaPayload(payload), /Adjunta la propuesta comercial/i);
});

test("sanitiza nombres y codifica rutas para OneDrive", () => {
  assert.equal(sanitizePathSegment('Cliente: Norte/Sur?'), "Cliente- Norte-Sur-");
  assert.equal(encodeGraphPath("EntregaDeServicios/Cliente Uno"), "EntregaDeServicios/Cliente%20Uno");
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
