const TIPOS_PAGO = Object.freeze({
  CONSULTOR: "consultor",
  COMPRA: "compra",
  SERVICIO: "servicio",
  ARRENDAMIENTO_INMUEBLE: "arrendamiento_inmueble",
  ARRENDAMIENTO_MUEBLE: "arrendamiento_mueble",
  HONORARIOS: "honorarios",
  NOMINA: "nomina"
});

const BASE_RETEICA_MEDELLIN = 785_610;
const REGLAS_PREDETERMINADAS = Object.freeze({
  [`${TIPOS_PAGO.CONSULTOR}:cuenta_cobro`]: Object.freeze({ base_minima: 1_750_905, fuente_declarante: 3.5, fuente_no_declarante: 3.5 }),
  [`${TIPOS_PAGO.CONSULTOR}:factura_electronica`]: Object.freeze({ base_minima: 1, fuente_declarante: 3.5, fuente_no_declarante: 3.5 }),
  [TIPOS_PAGO.CONSULTOR]: Object.freeze({ base_minima: 1_750_905, fuente_declarante: 3.5, fuente_no_declarante: 3.5 }),
  [TIPOS_PAGO.COMPRA]: Object.freeze({ base_minima: 524_000, fuente_declarante: 2.5, fuente_no_declarante: 3.5 }),
  [TIPOS_PAGO.SERVICIO]: Object.freeze({ base_minima: 105_000, fuente_declarante: 4, fuente_no_declarante: 6 }),
  [TIPOS_PAGO.ARRENDAMIENTO_INMUEBLE]: Object.freeze({ base_minima: 1, fuente_declarante: 3.5, fuente_no_declarante: 3.5 }),
  [TIPOS_PAGO.ARRENDAMIENTO_MUEBLE]: Object.freeze({ base_minima: 524_000, fuente_declarante: 4, fuente_no_declarante: 4 }),
  [TIPOS_PAGO.HONORARIOS]: Object.freeze({ base_minima: 1, fuente_declarante: 11, fuente_no_declarante: 10 })
});

const BASES_MINIMAS = Object.freeze({
  [TIPOS_PAGO.CONSULTOR]: REGLAS_PREDETERMINADAS[TIPOS_PAGO.CONSULTOR].base_minima,
  [TIPOS_PAGO.COMPRA]: REGLAS_PREDETERMINADAS[TIPOS_PAGO.COMPRA].base_minima,
  [TIPOS_PAGO.SERVICIO]: REGLAS_PREDETERMINADAS[TIPOS_PAGO.SERVICIO].base_minima,
  [TIPOS_PAGO.ARRENDAMIENTO_INMUEBLE]: REGLAS_PREDETERMINADAS[TIPOS_PAGO.ARRENDAMIENTO_INMUEBLE].base_minima,
  [TIPOS_PAGO.ARRENDAMIENTO_MUEBLE]: REGLAS_PREDETERMINADAS[TIPOS_PAGO.ARRENDAMIENTO_MUEBLE].base_minima,
  [TIPOS_PAGO.HONORARIOS]: REGLAS_PREDETERMINADAS[TIPOS_PAGO.HONORARIOS].base_minima
});

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
    ["arriendo", TIPOS_PAGO.ARRENDAMIENTO_INMUEBLE],
    ["arrendamiento", TIPOS_PAGO.ARRENDAMIENTO_INMUEBLE],
    ["arrendamiento_inmueble", TIPOS_PAGO.ARRENDAMIENTO_INMUEBLE],
    ["arrendamiento_inmuebles", TIPOS_PAGO.ARRENDAMIENTO_INMUEBLE],
    ["arrendamiento_mueble", TIPOS_PAGO.ARRENDAMIENTO_MUEBLE],
    ["arrendamiento_muebles", TIPOS_PAGO.ARRENDAMIENTO_MUEBLE],
    ["honorario", TIPOS_PAGO.HONORARIOS],
    ["honorarios", TIPOS_PAGO.HONORARIOS],
    ["nomina", TIPOS_PAGO.NOMINA]
  ]);
  const tipo = aliases.get(normalized);
  if (!tipo) {
    throw new RetencionValidationError(
      "tipo_pago debe ser consultor, compra, servicio, arrendamiento_inmueble, arrendamiento_mueble, honorarios o nomina"
    );
  }
  return tipo;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toNonNegativeMoney(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RetencionValidationError(`${fieldName} debe ser un valor numérico mayor o igual a cero`);
  }
  return roundMoney(number);
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
    es_economia_naranja: asBoolean(persona.es_economia_naranja, false),
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
      persona.es_entidad_sin_animo_lucro ||
      persona.es_economia_naranja
    ),
    aplicaReteIva: !persona.es_gran_contribuyente
  };
}

function resolveRegla(tipoPago, tipoDocumentoPago, regla = {}) {
  const documento = normalizeText(tipoDocumentoPago).replace(/[\s-]+/g, "_") || "cualquiera";
  const predeterminada = REGLAS_PREDETERMINADAS[`${tipoPago}:${documento}`] || REGLAS_PREDETERMINADAS[tipoPago] || {};
  const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  return {
    base_minima: numberOr(regla.base_minima, predeterminada.base_minima || 0),
    fuente_declarante: numberOr(regla.porcentaje_fuente_declarante ?? regla.fuente_declarante, predeterminada.fuente_declarante || 0),
    fuente_no_declarante: numberOr(regla.porcentaje_fuente_no_declarante ?? regla.fuente_no_declarante, predeterminada.fuente_no_declarante || 0),
    porcentaje_iva: numberOr(regla.porcentaje_iva, 19),
    porcentaje_reteiva: numberOr(regla.porcentaje_reteiva, 15),
    base_reteica: numberOr(regla.base_reteica, BASE_RETEICA_MEDELLIN),
    porcentaje_reteica: numberOr(regla.porcentaje_reteica, 0.18)
  };
}

function resolveTarifaReteFuente(tipoPago, declarante, regla = null, tipoDocumentoPago = null) {
  const resolved = resolveRegla(tipoPago, tipoDocumentoPago, regla || {});
  return declarante ? resolved.fuente_declarante : resolved.fuente_no_declarante;
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
    tipo_pago,
    tipo_documento_pago,
    tiene_iva,
    anticipo = 0,
    ciudad_servicio,
    regla = {}
  } = payload;
  const tipoPago = normalizeTipoPago(tipo_pago);
  const subtotalNormalizado = toNonNegativeMoney(subtotal, "subtotal");
  const anticipoNormalizado = toNonNegativeMoney(anticipo, "anticipo");
  const perfil = resolvePersona(persona);
  const reglaAplicada = resolveRegla(tipoPago, tipo_documento_pago, regla);
  const ivaNormalizado = tiene_iva === undefined || tiene_iva === null
    ? toNonNegativeMoney(iva, "iva")
    : (asBoolean(tiene_iva, false)
      ? roundMoney(subtotalNormalizado * (reglaAplicada.porcentaje_iva / 100))
      : 0);
  if (anticipoNormalizado > subtotalNormalizado + ivaNormalizado) {
    throw new RetencionValidationError("anticipo no puede superar el valor del pago");
  }

  if (tipoPago === TIPOS_PAGO.NOMINA || !perfil.factura_en_colombia) {
    const netoDirecto = roundMoney(subtotalNormalizado - anticipoNormalizado);
    return {
      tipo_pago: tipoPago,
      subtotal: subtotalNormalizado,
      anticipo: anticipoNormalizado,
      iva: 0,
      base_minima: null,
      regla_aplicada: reglaAplicada,
      retenciones_aplicadas: [],
      retenciones: [],
      total_retenciones: 0,
      valor_neto: netoDirecto,
      neto: netoDirecto
    };
  }

  const baseMinima = reglaAplicada.base_minima;
  const superaBaseNacional = subtotalNormalizado >= baseMinima;
  const regimen = resolveRegimenFlags(perfil);
  const retenciones = [];

  if (superaBaseNacional && regimen.aplicaReteFuente) {
    retenciones.push(buildRetencion(
      "ReteFuente",
      perfil.declarante_renta ? reglaAplicada.fuente_declarante : reglaAplicada.fuente_no_declarante,
      subtotalNormalizado
    ));
  }
  if (superaBaseNacional && regimen.aplicaReteIva && ivaNormalizado > 0) {
    retenciones.push(buildRetencion("ReteIVA", reglaAplicada.porcentaje_reteiva, ivaNormalizado));
  }
  if (
    normalizeText(ciudad_servicio || perfil.ciudad_residencia).includes("medellin") &&
    subtotalNormalizado >= reglaAplicada.base_reteica
  ) {
    retenciones.push(buildRetencion("ReteICA", reglaAplicada.porcentaje_reteica, subtotalNormalizado));
  }

  const totalRetenciones = roundMoney(
    retenciones.reduce((total, retencion) => total + Number(retencion.valor || 0), 0)
  );
  const valorNeto = roundMoney(
    subtotalNormalizado - anticipoNormalizado + ivaNormalizado - totalRetenciones
  );

  return {
    tipo_pago: tipoPago,
    subtotal: subtotalNormalizado,
    anticipo: anticipoNormalizado,
    iva: ivaNormalizado,
    base_minima: baseMinima,
    regla_aplicada: reglaAplicada,
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
  REGLAS_PREDETERMINADAS,
  RetencionValidationError,
  TIPOS_PAGO,
  calcularRetenciones,
  normalizeTipoPago,
  normalizeText,
  resolveRegimenFlags,
  resolveRegla,
  resolveTarifaReteFuente,
  roundMoney
};
