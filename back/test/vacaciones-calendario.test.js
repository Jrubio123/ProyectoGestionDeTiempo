const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calcularPeriodoVacaciones,
  calcularSolicitudVacaciones,
  formatDateEs,
  normalizeDateToIso
} = require("../src/services/vacaciones-calendario.service");

test("divide cuatro días entre disfrute y reconocimiento en dinero", () => {
  const result = calcularSolicitudVacaciones("2026-09-07", "2026-09-10", 2);
  assert.equal(result.dias_habiles, 4);
  assert.equal(result.dias_disfrutados, 2);
  assert.equal(result.dias_compensados, 2);
  assert.equal(result.fecha_fin, "2026-09-08");
  assert.equal(result.fecha_regreso, "2026-09-09");
});

test("redondea hacia abajo el máximo compensable para periodos impares", () => {
  const result = calcularSolicitudVacaciones("2026-09-07", "2026-09-09", 1);
  assert.equal(result.dias_habiles, 3);
  assert.equal(result.max_dias_compensados, 1);
  assert.equal(result.dias_disfrutados, 2);
  assert.throws(
    () => calcularSolicitudVacaciones("2026-09-07", "2026-09-09", 2),
    /hasta 1 día/
  );
});

test("rechaza fracciones de días reconocidos en dinero", () => {
  assert.throws(
    () => calcularSolicitudVacaciones("2026-09-07", "2026-09-10", 1.5),
    /número entero/
  );
});

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

test("formatea fechas DATE devueltas por PostgreSQL", () => {
  const postgresDate = new Date(Date.UTC(2026, 8, 10));
  assert.equal(normalizeDateToIso(postgresDate), "2026-09-10");
  assert.match(formatDateEs(postgresDate), /10 de septiembre de 2026/);
});
