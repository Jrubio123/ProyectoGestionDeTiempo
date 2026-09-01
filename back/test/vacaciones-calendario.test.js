const test = require("node:test");
const assert = require("node:assert/strict");
const { calcularPeriodoVacaciones } = require("../src/services/vacaciones-calendario.service");

test("excluye sábados, domingos y festivos colombianos", () => {
  const result = calcularPeriodoVacaciones("2026-07-17", "2026-07-21");
  assert.equal(result.dias_habiles, 2);
  assert.equal(result.fecha_regreso, "2026-07-22");
  assert.equal(result.calendario.find((day) => day.fecha === "2026-07-20").festivo, "Día de la Independencia");
});

test("mueve el regreso después de Semana Santa", () => {
  const result = calcularPeriodoVacaciones("2026-04-01", "2026-04-03");
  assert.equal(result.dias_habiles, 1);
  assert.equal(result.fecha_regreso, "2026-04-06");
});

test("valida el orden y el límite del periodo", () => {
  assert.throws(
    () => calcularPeriodoVacaciones("2026-06-10", "2026-06-01"),
    /no puede ser anterior/
  );
  assert.throws(
    () => calcularPeriodoVacaciones("2026-01-01", "2027-01-03"),
    /366 días/
  );
});
