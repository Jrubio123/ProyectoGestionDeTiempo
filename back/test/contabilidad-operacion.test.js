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
