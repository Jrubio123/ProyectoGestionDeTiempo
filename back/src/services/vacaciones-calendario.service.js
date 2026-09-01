const { getHolidaysByYear } = require("@juandbc/festivos-colombia");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value, fieldName = "fecha") {
  const raw = String(value || "").trim();
  if (!ISO_DATE_RE.test(raw)) throw new Error(`${fieldName} debe tener formato AAAA-MM-DD`);
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} no es válida`);
  }
  return date;
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function holidayToIso(value) {
  const [day, month, year] = String(value || "").split("/");
  return `${year}-${month}-${day}`;
}

const holidayCache = new Map();

function getHolidayMap(year) {
  if (!holidayCache.has(year)) {
    const holidays = new Map(
      getHolidaysByYear(year).map((holiday) => [holidayToIso(holiday.date), holiday.name])
    );
    holidayCache.set(year, holidays);
  }
  return holidayCache.get(year);
}

function getDayInfo(date) {
  const iso = toIsoDate(date);
  const weekDay = date.getUTCDay();
  const holidayName = getHolidayMap(date.getUTCFullYear()).get(iso) || null;
  const weekend = weekDay === 0 || weekDay === 6;
  return {
    fecha: iso,
    habil: !weekend && !holidayName,
    tipo: holidayName ? "festivo" : weekend ? (weekDay === 6 ? "sábado" : "domingo") : "hábil",
    festivo: holidayName
  };
}

function calcularPeriodoVacaciones(fechaInicio, fechaFin) {
  const start = parseIsoDate(fechaInicio, "fecha_inicio");
  const end = parseIsoDate(fechaFin, "fecha_fin");
  if (end < start) throw new Error("fecha_fin no puede ser anterior a fecha_inicio");

  const totalCalendarDays = Math.floor((end - start) / 86_400_000) + 1;
  if (totalCalendarDays > 366) throw new Error("El periodo no puede superar 366 días calendario");

  const calendario = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    calendario.push(getDayInfo(current));
  }

  let returnDate = addDays(end, 1);
  while (!getDayInfo(returnDate).habil) returnDate = addDays(returnDate, 1);

  return {
    fecha_inicio: toIsoDate(start),
    fecha_fin: toIsoDate(end),
    dias_habiles: calendario.filter((day) => day.habil).length,
    fecha_regreso: toIsoDate(returnDate),
    calendario
  };
}

module.exports = {
  calcularPeriodoVacaciones,
  getDayInfo,
  parseIsoDate,
  toIsoDate
};
