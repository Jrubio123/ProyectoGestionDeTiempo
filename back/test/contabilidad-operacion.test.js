const test = require("node:test");
const assert = require("node:assert/strict");
const { _private } = require("../src/services/contabilidad-operacion.service");

test("normaliza varios meses para el historial", () => {
  assert.deepEqual(_private.parseMonths("9,1,9,13,0"), [9, 1]);
});

test("valida una factura completa y normaliza sus valores", () => {
  const factura = _private.validarFactura({
    numero_factura: " FV-001 ",
    fecha_emision: "2026-09-01",
    concepto: "Licenciamiento",
    subtotal: "1000000",
    iva: "190000",
    tiene_iva: true,
    anticipo: "100000",
    tipo_gasto: "servicio",
    moneda: "cop",
    soporte_url: "https://example.test/factura.pdf"
  });

  assert.equal(factura.numeroFactura, "FV-001");
  assert.equal(factura.moneda, "COP");
  assert.equal(factura.soporte.url, "https://example.test/factura.pdf");
});

test("mapea la empresa y el pago automático de una factura", () => {
  const factura = _private.mapFactura({
    id: "f29b6b0e-52e8-4b30-a5ac-e77d4ad89795",
    persona_id: "0fcd02c2-719b-49dd-81e3-fc126c7b9e38",
    empresa: "SILVER",
    fecha_emision: "2026-09-01",
    created_at: "2026-09-07T09:00:00-05:00",
    subtotal: 100000,
    iva: 0,
    anticipo: 0
  });

  assert.equal(factura.empresa, "SILVER");
  assert.equal(factura.fecha_pago_calculada, "2026-09-30");
});

test("rechaza conceptos y porcentajes contables inválidos", () => {
  assert.throws(
    () => _private.validarFactura({
      numero_factura: "1",
      fecha_emision: "2026-09-01",
      concepto: "Prueba",
      subtotal: 1,
      tipo_gasto: "otro"
    }),
    /concepto contable/
  );
  assert.throws(
    () => _private.validarRegla({
      concepto: "servicio",
      tipo_documento_pago: "cualquiera",
      base_minima: 1,
      porcentaje_fuente_declarante: 101,
      porcentaje_fuente_no_declarante: 0,
      porcentaje_iva: 19,
      porcentaje_reteiva: 15,
      base_reteica: 1,
      porcentaje_reteica: 0,
      vigencia_desde: "2026-09-01"
    }),
    /entre 0 y 100/
  );
});

test("valida y normaliza los datos de un proveedor", () => {
  const proveedor = _private.validarProveedor({
    tipo_persona: "Jurídica",
    tipo_documento_id: "53622f9d-39c9-471a-bff1-cc2ca5acefc9",
    numero_documento: " 900.271.114-1 ",
    nombre: " Equipos SAS ",
    email: "PAGOS@EJEMPLO.COM",
    factura_en_colombia: true,
    facturador_electronico: true
  });

  assert.equal(proveedor.numeroDocumento, "9002711141");
  assert.equal(proveedor.nombre, "Equipos SAS");
  assert.equal(proveedor.email, "pagos@ejemplo.com");
  assert.equal(proveedor.facturadorElectronico, true);
});

test("exige completar todos los datos bancarios cuando se registra uno", () => {
  assert.throws(
    () => _private.validarProveedor({
      tipo_persona: "Natural",
      tipo_documento_id: "b1e39e41-86fe-4dca-a383-7614bd145684",
      numero_documento: "43279660",
      nombre: "Andrea Londoño",
      banco_id: "b1e39e41-86fe-4dca-a383-7614bd145684"
    }),
    /Completa banco, tipo y número de cuenta/
  );
});
