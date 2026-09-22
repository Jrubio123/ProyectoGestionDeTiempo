const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inferAssignmentType,
  inferEventType,
  inferSignatureStatus,
  parseDateValue,
  parseNumericAmount,
  parseRate,
  plausibleDocument
} = require("../scripts/analyze-anexo-migration");

test("normaliza fechas del Excel y corrige años abreviados evidentes", () => {
  assert.equal(parseDateValue("31/12/2025").value, "2025-12-31");
  assert.equal(parseDateValue("12/abr/2025").value, "2025-04-12");
  assert.deepEqual(parseDateValue("31/12/205"), {
    value: "2025-12-31",
    corrected: true,
    source: "31/12/205"
  });
  assert.equal(parseDateValue("31/02/2025").value, null);
});

test("interpreta valores monetarios con formatos COP y decimales", () => {
  assert.equal(parseNumericAmount("$ 12.000.000,00"), 12000000);
  assert.equal(parseNumericAmount("85.000 COP"), 85000);
  assert.equal(parseNumericAmount("USD 2.500"), 2500);
  assert.equal(parseNumericAmount("40,50"), 40.5);
});

test("detecta moneda y periodicidad de tarifa", () => {
  assert.deepEqual(parseRate("40$", ""), {
    basis: "hourly",
    amount: 40,
    currency: "USD",
    source: "40$"
  });
  assert.equal(parseRate("", "$ 10.000.000").basis, "monthly");
  assert.equal(parseRate("55 US", "").currency, "USD");
});

test("clasifica modalidad, evento y estado de firma", () => {
  assert.equal(inferAssignmentType(parseRate("80.000", ""), "Consultor MM"), "horas");
  assert.equal(inferAssignmentType(parseRate("", "8.000.000"), "medio tiempo"), "medio_tiempo");
  assert.equal(inferEventType("Extención de fecha / cambio tarifa"), "extension");
  assert.equal(inferEventType("RETIRO"), "withdrawal");
  assert.equal(inferSignatureStatus("Pend por firma Otrosí"), "enviado");
  assert.equal(inferSignatureStatus("Otrosí firmado"), "firmado");
});

test("solo acepta identificaciones plausibles en columnas mixtas", () => {
  assert.equal(plausibleDocument("envío cont. firmado"), null);
  assert.equal(plausibleDocument("RETIRO"), null);
  assert.equal(plausibleDocument("1.037.615.840"), "1037615840");
  assert.equal(plausibleDocument("CE-A12345"), "CEA12345");
});
