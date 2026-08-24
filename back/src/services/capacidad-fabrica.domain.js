const STATE_ALIASES = new Map([
  ["en estimacion", "EN_ESTIMACION"],
  ["en aprobacion", "EN_APROBACION"],
  ["aprobado", "APROBADO"],
  ["en desarrollo", "EN_DESARROLLO"],
  ["en desarollo", "EN_DESARROLLO"],
  ["en pruebas", "EN_PRUEBAS"],
  ["en ajustes", "EN_AJUSTES"],
  ["pruebas exitosas", "PRUEBAS_EXITOSAS"],
  ["cerrado", "CERRADO"],
  ["garantia", "GARANTIA"],
  ["en espera cliente", "EN_ESPERA_CLIENTE"],
  ["pendiente paso a prd", "PENDIENTE_PASO_PRD"],
  ["removed", "REMOVED"],
  ["removido", "REMOVED"],
  ["cancelado", "CANCELADO"]
]);

function normalizeLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function normalizeStateCode(value) {
  const normalized = normalizeLabel(value);
  if (!normalized) return null;
  if (STATE_ALIASES.has(normalized)) return STATE_ALIASES.get(normalized);

  const possibleCode = normalized.replace(/[^a-z0-9]+/g, "_").toUpperCase();
  return [...STATE_ALIASES.values()].includes(possibleCode) ? possibleCode : null;
}

function isCorporateSilverEmail(value) {
  return /^[^\s@]+@silverconsulting\.com\.co$/i.test(String(value || "").trim());
}

function dateStringInBogota(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addUtcDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function getWeekRange(referenceDate, now = new Date()) {
  const value = String(referenceDate || dateStringInBogota(now)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("La fecha de la semana no es válida.");
  }

  const reference = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(reference.getTime()) || toDateString(reference) !== value) {
    throw new Error("La fecha de la semana no es válida.");
  }

  const day = reference.getUTCDay() || 7;
  const monday = addUtcDays(reference, 1 - day);
  const friday = addUtcDays(monday, 4);
  const today = dateStringInBogota(now);
  const mondayString = toDateString(monday);
  const fridayString = toDateString(friday);

  if (mondayString > today) {
    throw new Error("No se puede consultar una semana futura.");
  }

  const fridayCutoff = new Date(`${fridayString}T23:59:59.999-05:00`);
  const cutoff = fridayString >= today && now < fridayCutoff ? now : fridayCutoff;

  return {
    startDate: mondayString,
    endDate: fridayString,
    cutoff,
    cutoffIso: cutoff.toISOString(),
    isCurrent: today >= mondayString && today <= fridayString
  };
}

function validateDistribution(distribution, categoryCodes) {
  const allowed = new Set(categoryCodes || []);
  const values = new Map();

  for (const item of distribution || []) {
    const code = String(item?.codigo || "").trim().toUpperCase();
    const percentage = Number(item?.porcentaje);
    if (!allowed.has(code) || values.has(code)) {
      throw new Error("La distribución contiene categorías inválidas o repetidas.");
    }
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw new Error("Cada porcentaje debe estar entre 0 y 100.");
    }
    values.set(code, percentage);
  }

  if (values.size !== allowed.size) {
    throw new Error("La distribución debe incluir todas las categorías.");
  }

  const total = [...values.values()].reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 100) > 0.001) {
    throw new Error("La distribución del esfuerzo debe sumar 100%.");
  }

  return values;
}

function calculateActiveHours(effortTotal, percentage) {
  const effort = Number(effortTotal || 0);
  const percent = Number(percentage || 0);
  if (!Number.isFinite(effort) || !Number.isFinite(percent)) return 0;
  return Math.round(effort * (percent / 100) * 100) / 100;
}

function normalizeAzureEffort(value) {
  if (value === null || value === undefined || value === "") {
    return { effort: null, pending: true, valid: true };
  }
  const effort = Number(value);
  if (!Number.isFinite(effort) || effort < 0) {
    return { effort: null, pending: false, valid: false };
  }
  return { effort, pending: false, valid: true };
}

module.exports = {
  calculateActiveHours,
  dateStringInBogota,
  getWeekRange,
  isCorporateSilverEmail,
  normalizeAzureEffort,
  normalizeLabel,
  normalizeStateCode,
  validateDistribution
};
