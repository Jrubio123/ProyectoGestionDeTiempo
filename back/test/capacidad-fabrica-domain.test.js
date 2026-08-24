const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateActiveHours,
  getWeekRange,
  isCorporateSilverEmail,
  normalizeAzureEffort,
  normalizeStateCode,
  validateDistribution
} = require("../src/services/capacidad-fabrica.domain");

test("normaliza los estados configurados de Azure DevOps", () => {
  assert.equal(normalizeStateCode("En estimación"), "EN_ESTIMACION");
  assert.equal(normalizeStateCode("En desarollo"), "EN_DESARROLLO");
  assert.equal(normalizeStateCode("Garantía"), "GARANTIA");
  assert.equal(normalizeStateCode("Estado desconocido"), null);
});

test("identifica el dominio corporativo de Silver", () => {
  assert.equal(isCorporateSilverEmail("persona@silverconsulting.com.co"), true);
  assert.equal(isCorporateSilverEmail("invitado@otrodominio.com"), false);
});

test("calcula la semana laboral de lunes a viernes en Colombia", () => {
  const now = new Date("2026-08-20T15:00:00.000Z");
  const week = getWeekRange("2026-08-20", now);

  assert.equal(week.startDate, "2026-08-17");
  assert.equal(week.endDate, "2026-08-21");
  assert.equal(week.cutoffIso, now.toISOString());
  assert.equal(week.isCurrent, true);
});

test("usa el cierre del viernes para una semana histórica", () => {
  const week = getWeekRange(
    "2026-08-10",
    new Date("2026-08-20T15:00:00.000Z")
  );

  assert.equal(week.startDate, "2026-08-10");
  assert.equal(week.endDate, "2026-08-14");
  assert.equal(week.cutoffIso, "2026-08-15T04:59:59.999Z");
  assert.equal(week.isCurrent, false);
});

test("valida una distribución completa que suma 100", () => {
  const values = validateDistribution(
    [
      { codigo: "DESARROLLO", porcentaje: 80 },
      { codigo: "AJUSTES", porcentaje: 20 }
    ],
    ["DESARROLLO", "AJUSTES"]
  );

  assert.equal(values.get("DESARROLLO"), 80);
  assert.throws(
    () => validateDistribution(
      [{ codigo: "DESARROLLO", porcentaje: 90 }],
      ["DESARROLLO", "AJUSTES"]
    ),
    /todas las categorías/
  );
});

test("calcula las horas activas de la fase actual", () => {
  assert.equal(calculateActiveHours(100, 55), 55);
  assert.equal(calculateActiveHours(42, 5), 2.1);
  assert.equal(calculateActiveHours(null, 55), 0);
});

test("acepta elementos Azure con Effort pendiente", () => {
  assert.deepEqual(normalizeAzureEffort(null), {
    effort: null,
    pending: true,
    valid: true
  });
  assert.deepEqual(normalizeAzureEffort(30), {
    effort: 30,
    pending: false,
    valid: true
  });
  assert.equal(normalizeAzureEffort(-1).valid, false);
});
