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

test("previsualiza pagos antes de crear el lote y explica los excluidos", () => {
  const base = {
    persona_id: 5,
    persona_public_id: "a2a3bb18-6eb0-4fc4-b5cb-33fd24459787",
    tercero: "Consultor de prueba",
    numero_documento: "10001",
    factura_en_colombia: true,
    moneda_origen: "COP"
  };
  const input = {
    anio: 2026,
    mes: 9,
    quincena: 1,
    trm_oficial: null,
    fecha_pago_programada: "2026-09-15"
  };
  const cuentas = [
    {
      ...base,
      id: 1,
      public_id: "d0e0dabc-34d9-41ae-b49b-56e028809d2f",
      total_cuenta_cobro: 2000000,
      datos_adjuntos: { soportes: [{ url: "https://example.test/q1.pdf", created_at: "2026-09-03T15:00:00Z" }] }
    },
    {
      ...base,
      id: 2,
      public_id: "41fa3627-8c96-4633-bd55-45aa42733093",
      total_cuenta_cobro: 1000000,
      datos_adjuntos: {}
    }
  ];

  const preview = _private.construirVistaPrevia({ input, cuentas });

  assert.equal(preview.resumen.total_pagos, 1);
  assert.equal(preview.resumen.cuentas_cobro, 1);
  assert.equal(preview.resumen.cuentas_en_limbo, 1);
  assert.equal(preview.resumen.puede_generar, true);
  assert.equal(preview.pagos[0].tercero, "Consultor de prueba");
  assert.equal(preview.excluidos.cuentas_en_limbo[0].motivo, "sin_fecha_de_archivo");
});
