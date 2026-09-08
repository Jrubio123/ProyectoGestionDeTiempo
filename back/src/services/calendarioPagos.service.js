const {
  getDayInfo,
  parseIsoDate,
  toIsoDate
} = require("./vacaciones-calendario.service");

const BOGOTA_TIME_ZONE = "America/Bogota";

class CalendarioPagosValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CalendarioPagosValidationError";
    this.statusCode = 400;
  }
}

function validarPeriodo(anio, mes, quincena = null) {
  const year = Number(anio);
  const month = Number(mes);
  const half = quincena === null ? null : Number(quincena);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new CalendarioPagosValidationError("anio debe ser un entero entre 2000 y 2200");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new CalendarioPagosValidationError("mes debe ser un entero entre 1 y 12");
  }
  if (half !== null && ![1, 2].includes(half)) {
    throw new CalendarioPagosValidationError("quincena debe ser 1 o 2");
  }
  return { anio: year, mes: month, quincena: half };
}

function addUtcDays(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function calcularFechaPago(anio, mes, quincena) {
  const periodo = validarPeriodo(anio, mes, quincena);
  const ultimoDia = new Date(Date.UTC(periodo.anio, periodo.mes, 0)).getUTCDate();
  const diaNominal = periodo.quincena === 1 ? 15 : Math.min(30, ultimoDia);
  let fecha = new Date(Date.UTC(periodo.anio, periodo.mes - 1, diaNominal));

  while (!getDayInfo(fecha).habil) fecha = addUtcDays(fecha, -1);
  return toIsoDate(fecha);
}

function obtenerEnesimoDiaHabil(fechaInicio, cantidad) {
  if (!Number.isInteger(cantidad) || cantidad < 1) {
    throw new CalendarioPagosValidationError("cantidad debe ser un entero mayor que cero");
  }
  let fecha = fechaInicio instanceof Date
    ? new Date(fechaInicio.getTime())
    : parseIsoDate(fechaInicio, "fecha_inicio");
  let encontrados = 0;
  while (encontrados < cantidad) {
    if (getDayInfo(fecha).habil) encontrados += 1;
    if (encontrados < cantidad) fecha = addUtcDays(fecha, 1);
  }
  return toIsoDate(fecha);
}

function calcularCortes(anio, mes) {
  const periodo = validarPeriodo(anio, mes);
  const inicioMes = new Date(Date.UTC(periodo.anio, periodo.mes - 1, 1));
  const inicioSegundoCorte = new Date(Date.UTC(periodo.anio, periodo.mes - 1, 16));
  return {
    inicio_mes: toIsoDate(inicioMes),
    corte_q1: obtenerEnesimoDiaHabil(inicioMes, 5),
    inicio_q2: toIsoDate(inicioSegundoCorte),
    corte_q2: obtenerEnesimoDiaHabil(inicioSegundoCorte, 5)
  };
}

function calcularProgramacionFactura(fechaCarga) {
  const fecha = dateToBogotaIso(fechaCarga);
  if (!fecha) throw new CalendarioPagosValidationError("fecha_carga no es una fecha válida");
  const [anio, mes] = fecha.split("-").map(Number);
  const cortes = calcularCortes(anio, mes);
  let periodo;

  // Para facturas, el día exacto del corte ya se considera cerrado.
  if (fecha < cortes.corte_q1) {
    periodo = { anio, mes, quincena: 1 };
  } else if (fecha < cortes.corte_q2) {
    periodo = { anio, mes, quincena: 2 };
  } else {
    periodo = mes === 12
      ? { anio: anio + 1, mes: 1, quincena: 1 }
      : { anio, mes: mes + 1, quincena: 1 };
  }

  return {
    ...periodo,
    ciclo: `Q${periodo.quincena}`,
    fecha_carga: fecha,
    fecha_pago_programada: calcularFechaPago(periodo.anio, periodo.mes, periodo.quincena),
    cortes
  };
}

function dateToBogotaIso(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: BOGOTA_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(value);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  }

  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    try {
      return toIsoDate(parseIsoDate(raw));
    } catch (_) {
      return null;
    }
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : dateToBogotaIso(parsed);
}

function extraerFechaUltimoArchivo(datosAdjuntos) {
  if (!datosAdjuntos || typeof datosAdjuntos !== "object") return null;
  const timestamps = [];
  const visited = new Set();
  const timestampKey = /^(created(_at)?|createdat|creado(_en)?|subido(_en)?|uploaded(_at)?|actualizado_en|updated_at|fecha_carga)$/i;

  function walk(value, depth = 0, path = []) {
    if (!value || typeof value !== "object" || depth > 12 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, depth + 1, path));
      return;
    }
    const objectKeys = Object.keys(value).map((key) => key.toLowerCase());
    const looksLikeFile = objectKeys.some((key) =>
      ["url", "nombre", "filename", "file_name", "contenttype", "mime"].includes(key)
    );
    const inFileTree = path.some((part) =>
      [
        "archivo", "archivos", "documento", "documentos", "documento_firmado",
        "documentos_manuales", "soporte", "soportes", "cuenta_cobro_firmada"
      ].includes(String(part).toLowerCase())
    );
    Object.entries(value).forEach(([key, child]) => {
      if (timestampKey.test(key) && (looksLikeFile || inFileTree)) {
        const raw = String(child || "").trim();
        const parsed = child instanceof Date
          ? child
          : new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00Z` : raw);
        if (!Number.isNaN(parsed.getTime())) timestamps.push(parsed);
      }
      if (child && typeof child === "object") walk(child, depth + 1, [...path, key]);
    });
  }

  walk(datosAdjuntos);
  if (timestamps.length === 0) return null;
  const latest = timestamps.reduce((max, current) => current > max ? current : max);
  return dateToBogotaIso(latest);
}

function normalizeCiclo(value) {
  const ciclo = String(value || "").trim().toUpperCase();
  if (!ciclo) return null;
  if (!['Q1', 'Q2'].includes(ciclo)) {
    throw new CalendarioPagosValidationError("ciclo_proyeccion_asignado debe ser Q1, Q2 o null");
  }
  return ciclo;
}

function determinarQuincenaCuenta({
  anio,
  mes,
  datos_adjuntos,
  fecha_ultimo_archivo,
  ciclo_proyeccion_asignado
} = {}) {
  const periodo = validarPeriodo(anio, mes);
  const override = normalizeCiclo(ciclo_proyeccion_asignado);
  const cortes = calcularCortes(periodo.anio, periodo.mes);
  if (override) {
    return {
      quincena: override === "Q1" ? 1 : 2,
      ciclo: override,
      fuente: "override",
      fecha_ultimo_archivo: dateToBogotaIso(fecha_ultimo_archivo) || extraerFechaUltimoArchivo(datos_adjuntos),
      cortes
    };
  }

  const fechaArchivo = dateToBogotaIso(fecha_ultimo_archivo) || extraerFechaUltimoArchivo(datos_adjuntos);
  let quincena = null;
  let motivo = null;
  if (!fechaArchivo) {
    motivo = "sin_fecha_de_archivo";
  } else if (fechaArchivo < cortes.inicio_mes) {
    motivo = "archivo_fuera_del_mes";
  } else if (fechaArchivo <= cortes.corte_q1) {
    quincena = 1;
  } else if (fechaArchivo <= cortes.corte_q2) {
    quincena = 2;
  } else {
    motivo = "archivo_despues_del_segundo_corte";
  }

  return {
    quincena,
    ciclo: quincena ? `Q${quincena}` : null,
    fuente: "fecha_archivo",
    fecha_ultimo_archivo: fechaArchivo,
    motivo,
    cortes
  };
}

module.exports = {
  BOGOTA_TIME_ZONE,
  CalendarioPagosValidationError,
  calcularCortes,
  calcularFechaPago,
  calcularProgramacionFactura,
  dateToBogotaIso,
  determinarQuincenaCuenta,
  extraerFechaUltimoArchivo,
  normalizeCiclo,
  obtenerEnesimoDiaHabil,
  validarPeriodo
};
