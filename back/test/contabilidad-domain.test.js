const test = require("node:test");
const assert = require("node:assert/strict");
const { _private } = require("../src/services/contabilidad.service");

test("convierte Capitalink a COP con la TRM y no aplica retenciones locales", () => {
  const detalle = _private.prepararDetalle({
    origenTipo: "cuenta_cobro",
    origenId: 10,
    persona: { id: 5, factura_en_colombia: false },
    tipoPago: "consultor",
    subtotal: 1_000,
    iva: 190,
    moneda: "USD",
    trmOficial: 4_000
  });

  assert.equal(detalle.moneda_origen, "USD");
  assert.equal(detalle.valor_origen, 1_000);
  assert.equal(detalle.trm_aplicada, 4_000);
  assert.equal(detalle.subtotal, 4_000_000);
  assert.equal(detalle.iva, 0);
  assert.deepEqual(detalle.retenciones_aplicadas, []);
  assert.equal(detalle.valor_neto, 4_000_000);
});

test("exige TRM para una cuenta Capitalink", () => {
  assert.throws(
    () => _private.prepararDetalle({
      origenTipo: "cuenta_cobro",
      origenId: 10,
      persona: { id: 5, factura_en_colombia: false },
      tipoPago: "consultor",
      subtotal: 1_000,
      moneda: "USD"
    }),
    (error) => error.code === "TRM_REQUERIDA"
  );
});

test("valida overrides y totaliza los valores manuales", () => {
  const result = _private.validarRetencionesManuales([
    { tipo: "ReteFuente", porcentaje: 2.5, base: 1_000_000, valor: 25_000 },
    { tipo: "ReteIVA", porcentaje: 15, base: 190_000, valor: 28_500 }
  ], 1_190_000);

  assert.equal(result.total, 53_500);
  assert.equal(result.retenciones[0].manual, true);
  assert.throws(
    () => _private.validarRetencionesManuales([
      { tipo: "ReteICA", porcentaje: 1, valor: 1_200_000 }
    ], 1_190_000),
    /no pueden superar/
  );
});

test("normaliza las acciones del flujo y no expone IDs internos", () => {
  assert.equal(_private.normalizeEstadoDestino("revisado"), "Revisión");
  assert.equal(_private.normalizeEstadoDestino("pagar"), "Pagado");
  const mapped = _private.mapProyeccion({
    id: 99,
    public_id: "bb11b60c-713b-4e9c-8894-484864488fdf",
    mes: 10,
    anio: 2026,
    quincena: 1,
    estado: "Borrador",
    fecha_pago_programada: "2026-10-15"
  });
  assert.equal(mapped.id, "bb11b60c-713b-4e9c-8894-484864488fdf");
  assert.equal(mapped.id === 99, false);
  assert.equal("public_id" in mapped, false);
});
