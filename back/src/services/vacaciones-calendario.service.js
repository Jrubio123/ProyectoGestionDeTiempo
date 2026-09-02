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

function normalizeDateToIso(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return toIsoDate(value);
  const raw = String(value || "").trim();
  if (ISO_DATE_RE.test(raw.slice(0, 10))) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return toIsoDate(parsed);
}

function formatDateEs(value) {
  const iso = normalizeDateToIso(value);
  if (!iso) return "";
  return new Intl.DateTimeFormat("es-CO", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC"
  }).format(new Date(`${iso}T00:00:00Z`));
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

function calcularSolicitudVacaciones(fechaInicio, fechaFin, diasCompensados = 0) {
  const periodo = calcularPeriodoVacaciones(fechaInicio, fechaFin);
  const totalSolicitado = periodo.dias_habiles;
  if (totalSolicitado < 1) {
    throw new Error("El periodo debe contener al menos un día hábil");
  }

  const rawCompensados = diasCompensados === "" || diasCompensados === null || diasCompensados === undefined
    ? 0
    : Number(diasCompensados);
  if (!Number.isInteger(rawCompensados) || rawCompensados < 0) {
    throw new Error("Los días reconocidos en dinero deben ser un número entero mayor o igual a cero");
  }

  const maxDiasCompensados = Math.floor(totalSolicitado / 2);
  if (rawCompensados > maxDiasCompensados) {
    throw new Error(`Solo se pueden reconocer en dinero hasta ${maxDiasCompensados} día(s)`);
  }

  const diasDisfrutados = totalSolicitado - rawCompensados;
  let disfrutadosPendientes = diasDisfrutados;
  let fechaFinDisfrute = null;
  const calendario = periodo.calendario.map((dia) => {
    if (!dia.habil) return { ...dia, modalidad: null };
    if (disfrutadosPendientes > 0) {
      disfrutadosPendientes -= 1;
      fechaFinDisfrute = dia.fecha;
      return { ...dia, modalidad: "disfrutado" };
    }
    return { ...dia, modalidad: "compensado" };
  });

  let fechaRegreso = addDays(parseIsoDate(fechaFinDisfrute), 1);
  while (!getDayInfo(fechaRegreso).habil) fechaRegreso = addDays(fechaRegreso, 1);

  return {
    fecha_inicio: periodo.fecha_inicio,
    fecha_fin_solicitada: periodo.fecha_fin,
    fecha_fin: fechaFinDisfrute,
    fecha_regreso: toIsoDate(fechaRegreso),
    dias_habiles: totalSolicitado,
    dias_disfrutados: diasDisfrutados,
    dias_compensados: rawCompensados,
    max_dias_compensados: maxDiasCompensados,
    calendario
  };
}

module.exports = {
  calcularPeriodoVacaciones,
  calcularSolicitudVacaciones,
  formatDateEs,
  getDayInfo,
  normalizeDateToIso,
  parseIsoDate,
  toIsoDate
};
