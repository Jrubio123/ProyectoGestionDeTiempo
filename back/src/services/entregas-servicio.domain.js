const TIPOS_SERVICIO = Object.freeze({
  PROYECTO: "PROYECTO",
  MESA_SERVICIO: "MESA_SERVICIO",
  OUTSOURCING: "OUTSOURCING"
});

const PERFILES_CLIENTE = new Set(["CLAVE", "NO_CLAVE", "POR_DEFINIR"]);

class EntregaValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "EntregaValidationError";
    this.statusCode = 422;
    this.field = field;
  }
}

function text(value) {
  return String(value ?? "").trim();
}

function requiredText(value, message, field) {
  const normalized = text(value);
  if (!normalized) throw new EntregaValidationError(message, field);
  return normalized;
}

function normalizeNit(value) {
  return text(value).toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function normalizeTipoServicio(value) {
  const normalized = text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s/-]+/g, "_")
    .toUpperCase();

  if (["PROYECTO", "PROJECT"].includes(normalized)) return TIPOS_SERVICIO.PROYECTO;
  if (["MESA", "MESA_SERVICIO", "FABRICA", "REQ_DEMANDA"].includes(normalized)) {
    return TIPOS_SERVICIO.MESA_SERVICIO;
  }
  if (["OUTSOURCING", "OUTSORCING"].includes(normalized)) return TIPOS_SERVICIO.OUTSOURCING;
  throw new EntregaValidationError("El tipo de servicio no es válido.", "tipo_servicio");
}

function parseMoney(value, message, field) {
  if (value === null || value === undefined || text(value) === "") {
    throw new EntregaValidationError(message, field);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new EntregaValidationError(message, field);
  }
  return parsed;
}

function parseBoolean(value, message, field) {
  if (value === true || value === false) return value;
  const normalized = text(value).toLowerCase();
  if (["true", "1", "si", "sí"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw new EntregaValidationError(message, field);
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))];
}

function normalizeExternalConsultants(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const [index, item] of value.entries()) {
    const nombre = requiredText(
      item?.nombre,
      "El nombre del consultor no registrado es obligatorio.",
      `consultores_externos.${index}.nombre`
    );
    const telefono = requiredText(
      item?.telefono,
      "El teléfono del consultor no registrado es obligatorio.",
      `consultores_externos.${index}.telefono`
    );
    const key = `${nombre.toLowerCase()}|${telefono}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ nombre, telefono });
  }
  return result;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(text(value));
    return ["http:", "https:"].includes(parsed.protocol);
  } catch (_) {
    return false;
  }
}

function validateContact(contact, tipoServicio) {
  const normalized = {
    nombre: requiredText(contact?.nombre, "El nombre del contacto es obligatorio.", "contacto.nombre"),
    cargo: text(contact?.cargo) || null,
    telefono: requiredText(contact?.telefono, "El teléfono del contacto es obligatorio.", "contacto.telefono"),
    email: text(contact?.email).toLowerCase() || null,
    es_contacto_principal: Boolean(contact?.es_contacto_principal)
  };
  if (tipoServicio !== TIPOS_SERVICIO.OUTSOURCING && !normalized.cargo) {
    throw new EntregaValidationError("El cargo del interventor es obligatorio.", "contacto.cargo");
  }
  return normalized;
}

function validateNewClient(client, tipoServicio) {
  const nit = normalizeNit(client?.nit);
  if (!nit) throw new EntregaValidationError("El NIT del cliente es obligatorio.", "cliente_nuevo.nit");
  return {
    titulo: requiredText(client?.titulo, "El nombre del cliente es obligatorio.", "cliente_nuevo.titulo"),
    nit,
    direccion: requiredText(client?.direccion, "La ubicación del cliente es obligatoria.", "cliente_nuevo.direccion"),
    contacto: validateContact(client?.contacto, tipoServicio)
  };
}

function validateLinks(payload, tipoServicio) {
  const rawLinks = Array.isArray(payload?.enlaces) ? [...payload.enlaces] : [];

  const seen = new Set();
  const links = [];
  for (const [index, item] of rawLinks.entries()) {
    const titulo = text(item?.titulo);
    const rawUrl = text(item?.url);
    if (!titulo && !rawUrl) continue;
    const url = requiredText(rawUrl, "El enlace comercial es obligatorio.", `enlaces.${index}.url`);
    if (!isHttpUrl(url)) {
      throw new EntregaValidationError("El enlace comercial no es válido.", `enlaces.${index}.url`);
    }
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({
      titulo: titulo || `Enlace comercial ${links.length + 1}`,
      url
    });
  }

  if (
    [TIPOS_SERVICIO.PROYECTO, TIPOS_SERVICIO.MESA_SERVICIO].includes(tipoServicio)
    && links.length === 0
  ) {
    throw new EntregaValidationError("Registra al menos un enlace comercial.", "enlaces");
  }
  return links;
}

function validateDetail(payload, tipoServicio) {
  const detail = payload?.detalle || {};
  const moneda = text(detail.moneda || "COP").toUpperCase();
  if (!new Set(["COP", "USD", "EUR"]).has(moneda)) {
    throw new EntregaValidationError("La moneda no es válida.", "detalle.moneda");
  }

  if (tipoServicio === TIPOS_SERVICIO.PROYECTO) {
    const monedaTarifaConsultoria = text(detail.moneda_tarifa_consultoria || "COP").toUpperCase();
    if (!new Set(["COP", "USD", "EUR"]).has(monedaTarifaConsultoria)) {
      throw new EntregaValidationError(
        "La moneda de la tarifa de consultoría no es válida.",
        "detalle.moneda_tarifa_consultoria"
      );
    }
    return {
      nombre_proyecto: requiredText(detail.nombre_proyecto, "El nombre del proyecto es obligatorio.", "detalle.nombre_proyecto"),
      objeto_proyecto: requiredText(detail.objeto_proyecto, "El objeto del proyecto es obligatorio.", "detalle.objeto_proyecto"),
      valor_total: parseMoney(detail.valor_total, "El valor total del proyecto no es válido.", "detalle.valor_total"),
      moneda,
      forma_pago: requiredText(detail.forma_pago, "La forma de pago es obligatoria.", "detalle.forma_pago"),
      equipo_estimacion: requiredText(detail.equipo_estimacion, "Indica el equipo con quien se estimó.", "detalle.equipo_estimacion"),
      tarifa_consultoria: parseMoney(
        detail.tarifa_consultoria,
        "La tarifa de consultoría no es válida.",
        "detalle.tarifa_consultoria"
      ),
      moneda_tarifa_consultoria: monedaTarifaConsultoria
    };
  }

  if (tipoServicio === TIPOS_SERVICIO.MESA_SERVICIO) {
    return {
      detalle_tarifas: requiredText(detail.detalle_tarifas, "Las tarifas ofrecidas son obligatorias.", "detalle.detalle_tarifas"),
      forma_pago: requiredText(detail.forma_pago, "La forma de pago es obligatoria.", "detalle.forma_pago")
    };
  }

  return {
    tiempo_descripcion: requiredText(detail.tiempo_descripcion, "El tiempo del servicio es obligatorio.", "detalle.tiempo_descripcion"),
    tarifa: parseMoney(detail.tarifa, "La tarifa no es válida.", "detalle.tarifa"),
    valor_cliente: parseMoney(detail.valor_cliente, "El valor para el cliente no es válido.", "detalle.valor_cliente"),
    moneda,
    tiene_contrato: parseBoolean(detail.tiene_contrato, "Indica si tiene contrato.", "detalle.tiene_contrato")
  };
}

function validateEntregaPayload(payload = {}) {
  const tipoServicio = normalizeTipoServicio(payload.tipo_servicio);
  const clienteId = text(payload.cliente_id) || null;
  const clienteNuevo = clienteId ? null : validateNewClient(payload.cliente_nuevo, tipoServicio);
  const coordinadorId = requiredText(payload.coordinador_id, "Selecciona el coordinador asignado.", "coordinador_id");
  const perfilCliente = text(payload.perfil_cliente).toUpperCase();
  if (!PERFILES_CLIENTE.has(perfilCliente)) {
    throw new EntregaValidationError("Selecciona el perfil del cliente.", "perfil_cliente");
  }

  const consultoresIds = normalizeIdList(payload.consultores_ids);
  const consultoresExternos = normalizeExternalConsultants(payload.consultores_externos);
  if (
    tipoServicio === TIPOS_SERVICIO.OUTSOURCING
    && consultoresIds.length === 0
    && consultoresExternos.length === 0
  ) {
    throw new EntregaValidationError("Outsourcing requiere al menos un consultor.", "consultores_ids");
  }

  const modulosIds = normalizeIdList(payload.modulos_ids);
  const modulosOtros = [...new Set((Array.isArray(payload.modulos_otros) ? payload.modulos_otros : [])
    .map(text)
    .filter(Boolean))];
  if (modulosIds.length === 0 && modulosOtros.length === 0) {
    throw new EntregaValidationError("Selecciona o escribe al menos un módulo.", "modulos_ids");
  }

  const detail = validateDetail(payload, tipoServicio);
  const contactoId = text(payload.contacto_id) || null;
  const contactoNuevo = contactoId || clienteNuevo ? null : validateContact(payload.contacto_nuevo, tipoServicio);
  const links = validateLinks(payload, tipoServicio);

  return {
    tipo_servicio: tipoServicio,
    cliente_id: clienteId,
    cliente_nuevo: clienteNuevo,
    coordinador_id: coordinadorId,
    nombre_servicio: tipoServicio === TIPOS_SERVICIO.PROYECTO
      ? detail.nombre_proyecto
      : text(payload.nombre_servicio) || (tipoServicio === TIPOS_SERVICIO.MESA_SERVICIO ? "Mesa de servicios" : "Outsourcing"),
    perfil_cliente: perfilCliente,
    analisis_adaptabilidad: requiredText(
      payload.analisis_adaptabilidad,
      "El análisis de adaptabilidad es obligatorio.",
      "analisis_adaptabilidad"
    ),
    acuerdos_comerciales: text(payload.acuerdos_comerciales) || null,
    consultores_ids: consultoresIds,
    consultores_externos: consultoresExternos,
    modulos_ids: modulosIds,
    modulos_otros: modulosOtros,
    contacto_id: contactoId,
    contacto_nuevo: contactoNuevo,
    detalle: detail,
    enlaces: links
  };
}

module.exports = {
  EntregaValidationError,
  TIPOS_SERVICIO,
  normalizeNit,
  normalizeTipoServicio,
  validateEntregaPayload
};
