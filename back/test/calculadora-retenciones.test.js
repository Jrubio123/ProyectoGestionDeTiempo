const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calcularRetenciones,
  normalizeTipoPago
} = require("../src/services/calculadoraRetenciones.service");

test("calcula las tres retenciones para un consultor ordinario de Medellín", () => {
  const result = calcularRetenciones({
    subtotal: 2_000_000,
    iva: 380_000,
    persona: {
      factura_en_colombia: true,
      declarante_renta: false,
      ciudad_residencia: "Medellín"
    },
    tipo_pago: "consultor"
  });

  assert.deepEqual(
    result.retenciones_aplicadas.map(({ tipo, porcentaje, valor }) => ({ tipo, porcentaje, valor })),
    [
      { tipo: "ReteFuente", porcentaje: 3.5, valor: 70_000 },
      { tipo: "ReteIVA", porcentaje: 15, valor: 57_000 },
      { tipo: "ReteICA", porcentaje: 0.18, valor: 3_600 }
    ]
  );
  assert.equal(result.total_retenciones, 130_600);
  assert.equal(result.valor_neto, 2_249_400);
});

test("no aplica impuestos colombianos ni IVA a Capitalink", () => {
  const result = calcularRetenciones({
    subtotal: 5_000,
    iva: 950,
    persona: { factura_en_colombia: false, ciudad_residencia: "Medellín" },
    tipo_pago: "honorarios"
  });

  assert.equal(result.iva, 0);
  assert.deepEqual(result.retenciones_aplicadas, []);
  assert.equal(result.valor_neto, 5_000);
});

test("la nómina conserva exactamente el neto manual", () => {
  const result = calcularRetenciones({
    subtotal: 3_456_789.12,
    iva: 100_000,
    persona: { factura_en_colombia: true, ciudad_residencia: "Medellín" },
    tipo_pago: "nómina"
  });

  assert.equal(result.iva, 0);
  assert.deepEqual(result.retenciones_aplicadas, []);
  assert.equal(result.valor_neto, 3_456_789.12);
});

test("aplica de forma independiente las banderas de régimen", () => {
  const granContribuyente = calcularRetenciones({
    subtotal: 600_000,
    iva: 114_000,
    persona: {
      factura_en_colombia: true,
      es_gran_contribuyente: true,
      declarante_renta: true
    },
    tipo_pago: "compra"
  });
  assert.deepEqual(granContribuyente.retenciones_aplicadas.map((item) => item.tipo), ["ReteFuente"]);
  assert.equal(granContribuyente.retenciones_aplicadas[0].porcentaje, 2.5);

  const simple = calcularRetenciones({
    subtotal: 600_000,
    iva: 114_000,
    persona: { factura_en_colombia: true, es_regimen_simple: true },
    tipo_pago: "compra"
  });
  assert.deepEqual(simple.retenciones_aplicadas.map((item) => item.tipo), ["ReteIVA"]);

  const granYAutorretenedor = calcularRetenciones({
    subtotal: 600_000,
    iva: 114_000,
    persona: {
      factura_en_colombia: true,
      es_gran_contribuyente: true,
      es_autorretenedor: true
    },
    tipo_pago: "compra"
  });
  assert.deepEqual(granYAutorretenedor.retenciones_aplicadas, []);

  const esal = calcularRetenciones({
    subtotal: 600_000,
    iva: 114_000,
    persona: { factura_en_colombia: true, es_entidad_sin_animo_lucro: true },
    tipo_pago: "compra"
  });
  assert.deepEqual(esal.retenciones_aplicadas.map((item) => item.tipo), ["ReteIVA"]);
});

test("facturador electrónico no cambia la base definida para consultor", () => {
  const result = calcularRetenciones({
    subtotal: 1_000,
    persona: { factura_en_colombia: true, facturador_electronico: true },
    tipo_pago: "consultor"
  });
  assert.equal(result.base_minima, 1_750_905);
  assert.deepEqual(result.retenciones_aplicadas, []);
});

test("ReteICA usa su propia base aunque no se alcance la base nacional", () => {
  const result = calcularRetenciones({
    subtotal: 800_000,
    persona: { factura_en_colombia: true, ciudad_residencia: "medellin, Antioquia" },
    tipo_pago: "consultor"
  });
  assert.deepEqual(result.retenciones_aplicadas.map((item) => item.tipo), ["ReteICA"]);
  assert.equal(result.valor_neto, 798_560);
});

test("diferencia servicios declarantes y no declarantes", () => {
  const declarante = calcularRetenciones({
    subtotal: 200_000,
    persona: { factura_en_colombia: true, declarante: true },
    tipo_pago: "servicio"
  });
  const noDeclarante = calcularRetenciones({
    subtotal: 200_000,
    persona: { factura_en_colombia: true, declarante: false },
    tipo_pago: "arriendo"
  });
  assert.equal(declarante.retenciones_aplicadas[0].porcentaje, 4);
  assert.equal(noDeclarante.retenciones_aplicadas[0].porcentaje, 6);
  assert.equal(normalizeTipoPago("Nómina"), "nomina");
});

test("mantiene compatibilidad con la firma posicional del servicio", () => {
  const result = calcularRetenciones(
    1_000_000,
    190_000,
    { factura_en_colombia: true, declarante_renta: true },
    "compra"
  );
  assert.equal(result.retenciones, result.retenciones_aplicadas);
  assert.equal(result.neto, result.valor_neto);
  assert.equal(result.retenciones[0].porcentaje, 2.5);
});

test("diferencia honorarios declarantes y no declarantes desde base de un peso", () => {
  const declarante = calcularRetenciones({
    subtotal: 100,
    persona: { factura_en_colombia: true, declarante_renta: true },
    tipo_pago: "honorarios"
  });
  const noDeclarante = calcularRetenciones({
    subtotal: 100,
    persona: { factura_en_colombia: true, declarante_renta: false },
    tipo_pago: "honorarios"
  });

  assert.equal(declarante.base_minima, 1);
  assert.equal(declarante.retenciones[0].porcentaje, 11);
  assert.equal(noDeclarante.retenciones[0].porcentaje, 10);
});

test("consultor conserva base de 1.750.905 y tarifa de 3.5%", () => {
  const bajoBase = calcularRetenciones({
    subtotal: 1_750_904,
    persona: { factura_en_colombia: true },
    tipo_pago: "consultor"
  });
  const enBase = calcularRetenciones({
    subtotal: 1_750_905,
    persona: { factura_en_colombia: true },
    tipo_pago: "consultor"
  });

  assert.equal(bajoBase.base_minima, 1_750_905);
  assert.deepEqual(bajoBase.retenciones, []);
  assert.equal(enBase.retenciones[0].porcentaje, 3.5);
});
