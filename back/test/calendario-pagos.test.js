const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calcularCortes,
  calcularFechaPago,
  determinarQuincenaCuenta,
  extraerFechaUltimoArchivo
} = require("../src/services/calendarioPagos.service");

test("mueve el pago al día hábil inmediatamente anterior", () => {
  // El 15 de agosto de 2026 cae sábado y el 31 de mayo cae domingo.
  assert.equal(calcularFechaPago(2026, 8, 1), "2026-08-14");
  assert.equal(calcularFechaPago(2026, 5, 2), "2026-05-29");
});

test("calcula ambos cortes con festivos colombianos", () => {
  assert.deepEqual(calcularCortes(2026, 10), {
    inicio_mes: "2026-10-01",
    corte_q1: "2026-10-07",
    inicio_q2: "2026-10-16",
    corte_q2: "2026-10-22"
  });
});

test("clasifica por la fecha del último archivo", () => {
  const q1 = determinarQuincenaCuenta({
    anio: 2026,
    mes: 10,
    datos_adjuntos: {
      soportes: {
        documentos: [
          { nombre: "cuenta.pdf", created_at: "2026-10-03T18:00:00-05:00" },
          { nombre: "seguridad.pdf", created_at: "2026-10-07T16:00:00-05:00" }
        ]
      }
    }
  });
  assert.equal(q1.quincena, 1);
  assert.equal(q1.fecha_ultimo_archivo, "2026-10-07");

  const q2 = determinarQuincenaCuenta({
    anio: 2026,
    mes: 10,
    datos_adjuntos: { soportes: { actualizado_en: "2026-10-08T08:00:00-05:00" } }
  });
  assert.equal(q2.quincena, 2);
});

test("interpreta los timestamps en la zona horaria de Bogotá", () => {
  const result = determinarQuincenaCuenta({
    anio: 2026,
    mes: 10,
    fecha_ultimo_archivo: "2026-10-08T03:30:00Z"
  });
  assert.equal(result.fecha_ultimo_archivo, "2026-10-07");
  assert.equal(result.quincena, 1);

  assert.equal(
    extraerFechaUltimoArchivo({ archivo: { created_at: "2026-10-05" } }),
    "2026-10-05"
  );
});

test("deja en limbo los documentos posteriores al segundo corte", () => {
  const result = determinarQuincenaCuenta({
    anio: 2026,
    mes: 10,
    fecha_ultimo_archivo: "2026-10-23"
  });
  assert.equal(result.quincena, null);
  assert.equal(result.motivo, "archivo_despues_del_segundo_corte");
});

test("el override Q1 o Q2 tiene prioridad sobre la fecha", () => {
  const result = determinarQuincenaCuenta({
    anio: 2026,
    mes: 10,
    fecha_ultimo_archivo: "2026-09-01",
    ciclo_proyeccion_asignado: "q2"
  });
  assert.equal(result.quincena, 2);
  assert.equal(result.fuente, "override");
});
