const test = require("node:test");
const assert = require("node:assert/strict");

const timeoutServicePath = require.resolve("../src/services/firma-cuenta-timeout.service");
const {
  isFirmaCuentaTimedOut,
  parseFirmaCuentaTimeoutHours,
  getFirmaCuentaTimeoutHours
} = require(timeoutServicePath);

const NOW = new Date("2026-07-22T12:00:00.000Z");
const INICIADA_HACE_25_HORAS = "2026-07-21T11:00:00.000Z";

test("firma vieja pendiente expira aunque ultimo_evento sea pending o ready", () => {
  for (const ultimoEvento of ["pending", "ready"]) {
    assert.equal(
      isFirmaCuentaTimedOut(
        {
          estado: "pending",
          iniciado_en: INICIADA_HACE_25_HORAS,
          ultimo_evento: ultimoEvento
        },
        NOW,
        24
      ),
      true
    );
  }
});

test("firma no expira con documento firmado o estado no pendiente", () => {
  assert.equal(
    isFirmaCuentaTimedOut(
      {
        estado: "pending",
        iniciado_en: INICIADA_HACE_25_HORAS,
        documento_firmado: { url: "https://archivos.test/firmado.pdf" }
      },
      NOW,
      24
    ),
    false
  );
  assert.equal(
    isFirmaCuentaTimedOut(
      { estado: "signed", iniciado_en: INICIADA_HACE_25_HORAS },
      NOW,
      24
    ),
    false
  );
  assert.equal(
    isFirmaCuentaTimedOut(
      { estado: "starting", iniciado_en: INICIADA_HACE_25_HORAS },
      NOW,
      24
    ),
    false
  );
});

test("CUENTAS_FIRMA_TIMEOUT_HORAS configura el export y usa 24 para valores invalidos", () => {
  const previous = process.env.CUENTAS_FIRMA_TIMEOUT_HORAS;
  try {
    process.env.CUENTAS_FIRMA_TIMEOUT_HORAS = "72";
    assert.equal(getFirmaCuentaTimeoutHours(), 72);
    process.env.CUENTAS_FIRMA_TIMEOUT_HORAS = "no-numerico";
    assert.equal(getFirmaCuentaTimeoutHours(), 24);
    process.env.CUENTAS_FIRMA_TIMEOUT_HORAS = "0";
    assert.equal(getFirmaCuentaTimeoutHours(), 24);
    assert.equal(parseFirmaCuentaTimeoutHours(-5), 24);
  } finally {
    if (previous === undefined) {
      delete process.env.CUENTAS_FIRMA_TIMEOUT_HORAS;
    } else {
      process.env.CUENTAS_FIRMA_TIMEOUT_HORAS = previous;
    }
  }
});
