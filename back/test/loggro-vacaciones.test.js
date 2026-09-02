const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractAvailableDays,
  getAvailableVacationDays,
  normalizeBearerToken,
  todayInBogota
} = require("../src/services/loggro-vacaciones.service");

test("extrae los días disponibles de la fila del documento solicitado", () => {
  const payload = {
    contenido: {
      datos: [
        { "Identificación Empleado": "111", nombre: "Otra persona", "Días Disponibles de Vacaciones": 3 },
        { "Identificación Empleado": "222", nombre: "Persona actual", "Días Disponibles de Vacaciones": "12,5" }
      ]
    }
  };

  assert.deepEqual(extractAvailableDays(payload, "222"), {
    dias_disponibles: 12.5,
    campo_origen: "Días Disponibles de Vacaciones"
  });
});

test("normaliza un token aunque se configure con el prefijo Bearer", () => {
  assert.equal(normalizeBearerToken(" Bearer token-secreto "), "token-secreto");
});

test("calcula la fecha de corte en la zona horaria de Colombia", () => {
  assert.equal(todayInBogota(new Date("2026-09-03T03:30:00Z")), "2026-09-02");
});

test("consulta Loggro sin exponer el token y normaliza la respuesta", async () => {
  let receivedUrl;
  let receivedAuthorization;
  const fetchImpl = async (url, options) => {
    receivedUrl = String(url);
    receivedAuthorization = options.headers.Authorization;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        contenido: { data: [{ identificacion: "123456", saldoVacaciones: 8 }] }
      })
    };
  };

  const result = await getAvailableVacationDays({
    documentNumber: "123456",
    date: "2026-09-02",
    fetchImpl,
    config: { token: "secreto", apiBase: "https://api.loggro.test", timeoutMs: 1000 }
  });

  assert.equal(result.dias_disponibles, 8);
  assert.equal(result.fecha_corte, "2026-09-02");
  assert.match(receivedUrl, /filter=123456/);
  assert.equal(receivedAuthorization, "Bearer secreto");
  assert.doesNotMatch(JSON.stringify(result), /secreto/);
});
