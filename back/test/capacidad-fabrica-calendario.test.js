const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const path = require("node:path");
const {
  normalizeCalendarEvent,
  normalizeGraphDateTime
} = require("../src/services/microsoft-calendar.service");

const rangeStart = new Date("2026-08-31T05:00:00.000Z");
const rangeEnd = new Date("2026-09-05T05:00:00.000Z");

function event(overrides = {}) {
  return {
    id: "evento-1",
    subject: "Seguimiento de fábrica",
    start: { dateTime: "2026-08-31T14:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-08-31T15:30:00.0000000", timeZone: "UTC" },
    organizer: { emailAddress: { address: "coord@silverconsulting.com.co", name: "Coordinador" } },
    responseStatus: { response: "accepted" },
    showAs: "busy",
    sensitivity: "normal",
    isCancelled: false,
    isAllDay: false,
    ...overrides
  };
}

test("normaliza fechas UTC de Graph con siete decimales", () => {
  assert.equal(
    normalizeGraphDateTime({ dateTime: "2026-08-31T14:00:00.0000000", timeZone: "UTC" }).toISOString(),
    "2026-08-31T14:00:00.000Z"
  );
});

test("convierte una cita válida en reunión con horas", () => {
  const result = normalizeCalendarEvent(event(), rangeStart, rangeEnd);

  assert.equal(result.included, true);
  assert.equal(result.event.hours, 1.5);
  assert.equal(result.event.organizerEmail, "coord@silverconsulting.com.co");
  assert.equal(result.event.title, "Seguimiento de fábrica");
});

test("protege el título de reuniones privadas", () => {
  const result = normalizeCalendarEvent(
    event({ sensitivity: "private", subject: "Tema confidencial" }),
    rangeStart,
    rangeEnd
  );

  assert.equal(result.included, true);
  assert.equal(result.event.title, "Reunión privada");
});

test("omite reuniones que no consumen capacidad", () => {
  const variants = [
    event({ isCancelled: true }),
    event({ isAllDay: true }),
    event({ showAs: "free" }),
    event({ responseStatus: { response: "declined" } })
  ];

  assert.deepEqual(
    variants.map((item) => normalizeCalendarEvent(item, rangeStart, rangeEnd).included),
    [false, false, false, false]
  );
});

test("la migración conserva reuniones locales sin duplicarlas", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../../db/migrations/2026-08-31-calendario-capacidad.sql"),
    "utf8"
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS actividades_calendario_capacidad/);
  assert.match(migration, /UNIQUE \(persona_id, graph_event_id\)/);
  assert.match(migration, /categoria_codigo VARCHAR\(40\) NOT NULL DEFAULT 'REUNIONES'/);
});
