const TIPOS_PAGO = Object.freeze({
  CONSULTOR: "consultor",
  COMPRA: "compra",
  SERVICIO: "servicio",
  ARRIENDO: "arriendo",
  HONORARIOS: "honorarios",
  NOMINA: "nomina"
});

const BASES_MINIMAS = Object.freeze({
  [TIPOS_PAGO.CONSULTOR]: 1_750_905,
  [TIPOS_PAGO.COMPRA]: 524_000,
  [TIPOS_PAGO.SERVICIO]: 105_000,
  // El documento no define una tarifa independiente para arriendos; se tratan
  // como servicios hasta que Contabilidad configure una regla específica.
  [TIPOS_PAGO.ARRIENDO]: 105_000,
  [TIPOS_PAGO.HONORARIOS]: 1
});

const BASE_RETEICA_MEDELLIN = 785_610;

class RetencionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetencionValidationError";
    this.statusCode = 400;
  }
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeTipoPago(value) {
  const normalized = normalizeText(value).replace(/[\s-]+/g, "_");
  const aliases = new Map([
    ["consultor", TIPOS_PAGO.CONSULTOR],
    ["consultor_nacional", TIPOS_PAGO.CONSULTOR],
    ["cuenta_cobro", TIPOS_PAGO.CONSULTOR],
    ["compra", TIPOS_PAGO.COMPRA],
    ["servicio", TIPOS_PAGO.SERVICIO],
    ["arriendo", TIPOS_PAGO.ARRIENDO],
    ["honorario", TIPOS_PAGO.HONORARIOS],
    ["honorarios", TIPOS_PAGO.HONORARIOS],
    ["nomina", TIPOS_PAGO.NOMINA]
  ]);
  const tipo = aliases.get(normalized);
  if (!tipo) {
    throw new RetencionValidationError(
      "tipo_pago debe ser consultor, compra, servicio, arriendo, honorarios o nomina"
    );
  }
  return tipo;
}

function toNonNegativeMoney(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RetencionValidationError(`${fieldName} debe ser un valor numérico mayor o igual a cero`);
  }
  return roundMoney(number);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function asBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = normalizeText(value);
  if (["true", "1", "si", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return defaultValue;
}

function resolvePersona(persona = {}) {
  if (!persona || typeof persona !== "object" || Array.isArray(persona)) {
    throw new RetencionValidationError("persona debe ser un objeto");
  }
  return {
    ...persona,
    factura_en_colombia: asBoolean(persona.factura_en_colombia, true),
    facturador_electronico: asBoolean(persona.facturador_electronico, false),
    es_gran_contribuyente: asBoolean(persona.es_gran_contribuyente, false),
    es_autorretenedor: asBoolean(persona.es_autorretenedor, false),
    es_regimen_simple: asBoolean(persona.es_regimen_simple, false),
    es_entidad_sin_animo_lucro: asBoolean(persona.es_entidad_sin_animo_lucro, false),
    declarante_renta: asBoolean(
      persona.declarante_renta ?? persona.declarante ?? persona.es_declarante,
      false
    )
  };
}

function resolveRegimenFlags(persona = {}) {
  return {
    aplicaReteFuente: !(
      persona.es_autorretenedor ||
      persona.es_regimen_simple ||
      persona.es_entidad_sin_animo_lucro
    ),
    aplicaReteIva: !persona.es_gran_contribuyente
  };
}

function resolveTarifaReteFuente(tipoPago, declarante) {
  if (tipoPago === TIPOS_PAGO.HONORARIOS) return declarante ? 11 : 10;
  if (tipoPago === TIPOS_PAGO.COMPRA) return declarante ? 2.5 : 3.5;
  if (tipoPago === TIPOS_PAGO.SERVICIO || tipoPago === TIPOS_PAGO.ARRIENDO) {
    return declarante ? 4 : 6;
  }
  return 3.5;
}

function buildRetencion(tipo, porcentaje, base, editable = true) {
  return {
    tipo,
    porcentaje,
    base: roundMoney(base),
    valor: roundMoney(Number(base) * (Number(porcentaje) / 100)),
    editable
  };
}

function calcularRetenciones(input = {}, ivaArg = 0, personaArg = {}, tipoPagoArg) {
  const payload = input && typeof input === "object" && !Array.isArray(input)
    ? input
    : { subtotal: input, iva: ivaArg, persona: personaArg, tipo_pago: tipoPagoArg };
  const {
    subtotal,
    iva = 0,
    persona = {},
    tipo_pago
  } = payload;
  const tipoPago = normalizeTipoPago(tipo_pago);
  const subtotalNormalizado = toNonNegativeMoney(subtotal, "subtotal");
  const ivaNormalizado = toNonNegativeMoney(iva, "iva");
  const perfil = resolvePersona(persona);

  if (tipoPago === TIPOS_PAGO.NOMINA) {
    return {
      tipo_pago: tipoPago,
      subtotal: subtotalNormalizado,
      iva: 0,
      base_minima: null,
      retenciones_aplicadas: [],
      retenciones: [],
      total_retenciones: 0,
      valor_neto: subtotalNormalizado,
      neto: subtotalNormalizado
    };
  }

  if (!perfil.factura_en_colombia) {
    return {
      tipo_pago: tipoPago,
      subtotal: subtotalNormalizado,
      iva: 0,
      base_minima: null,
      retenciones_aplicadas: [],
      retenciones: [],
      total_retenciones: 0,
      valor_neto: subtotalNormalizado,
      neto: subtotalNormalizado
    };
  }

  const baseMinima = BASES_MINIMAS[tipoPago];
  const superaBaseNacional = subtotalNormalizado >= baseMinima;
  const regimen = resolveRegimenFlags(perfil);
  const retenciones = [];

  if (superaBaseNacional && regimen.aplicaReteFuente) {
    retenciones.push(buildRetencion(
      "ReteFuente",
      resolveTarifaReteFuente(tipoPago, perfil.declarante_renta),
      subtotalNormalizado
    ));
  }

  if (superaBaseNacional && regimen.aplicaReteIva && ivaNormalizado > 0) {
    retenciones.push(buildRetencion("ReteIVA", 15, ivaNormalizado));
  }

  if (
    normalizeText(perfil.ciudad_residencia).includes("medellin") &&
    subtotalNormalizado >= BASE_RETEICA_MEDELLIN
  ) {
    retenciones.push(buildRetencion("ReteICA", 0.18, subtotalNormalizado));
  }

  const totalRetenciones = roundMoney(
    retenciones.reduce((total, retencion) => total + Number(retencion.valor || 0), 0)
  );
  const valorNeto = roundMoney(subtotalNormalizado + ivaNormalizado - totalRetenciones);

  return {
    tipo_pago: tipoPago,
    subtotal: subtotalNormalizado,
    iva: ivaNormalizado,
    base_minima: baseMinima,
    retenciones_aplicadas: retenciones,
    retenciones,
    total_retenciones: totalRetenciones,
    valor_neto: valorNeto,
    neto: valorNeto
  };
}

module.exports = {
  BASES_MINIMAS,
  BASE_RETEICA_MEDELLIN,
  RetencionValidationError,
  TIPOS_PAGO,
  calcularRetenciones,
  normalizeTipoPago,
  normalizeText,
  resolveRegimenFlags,
  resolveTarifaReteFuente,
  roundMoney
};
