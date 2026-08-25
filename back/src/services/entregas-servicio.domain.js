const TIPOS_SERVICIO = Object.freeze({
  PROYECTO: "PROYECTO",
  MESA_SERVICIO: "MESA_SERVICIO",
  OUTSOURCING: "OUTSOURCING"
});

const PERFILES_CLIENTE = new Set(["CLAVE", "NO_CLAVE", "POR_DEFINIR"]);
const MAX_PDF_BYTES = 8 * 1024 * 1024;

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

function parsePdfDataUrl(value, fileName) {
  const raw = text(value);
  const match = raw.match(/^data:application\/pdf;base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) {
    throw new EntregaValidationError(`${fileName || "El archivo"} debe ser un PDF válido.`, "documentos");
  }
  const buffer = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.slice(0, 4).toString("utf8") !== "%PDF") {
    throw new EntregaValidationError(`${fileName || "El archivo"} no contiene un PDF válido.`, "documentos");
  }
  if (buffer.length > MAX_PDF_BYTES) {
    throw new EntregaValidationError(`${fileName || "El archivo"} supera el máximo de 8 MB.`, "documentos");
  }
  return buffer;
}

function validateDocuments(payload, tipoServicio) {
  const files = (Array.isArray(payload?.documentos) ? payload.documentos : []).map((item, index) => {
    const nombre = requiredText(item?.nombre, "El archivo debe tener nombre.", `documentos.${index}.nombre`);
    if (!/\.pdf$/i.test(nombre)) {
      throw new EntregaValidationError(`${nombre} debe tener extensión PDF.`, "documentos");
    }
    return { nombre, buffer: parsePdfDataUrl(item?.base64, nombre) };
  });

  const propuestaUrl = text(payload?.propuesta_url);
  if (propuestaUrl && !isHttpUrl(propuestaUrl)) {
    throw new EntregaValidationError("El enlace de la propuesta no es válido.", "propuesta_url");
  }
  if (
    [TIPOS_SERVICIO.PROYECTO, TIPOS_SERVICIO.MESA_SERVICIO].includes(tipoServicio)
    && files.length === 0
    && !propuestaUrl
  ) {
    throw new EntregaValidationError("Adjunta la propuesta comercial o registra su enlace.", "documentos");
  }
  return { files, propuestaUrl: propuestaUrl || null };
}

function validateDetail(payload, tipoServicio) {
  const detail = payload?.detalle || {};
  const moneda = text(detail.moneda || "COP").toUpperCase();
  if (!/^[A-Z]{3}$/.test(moneda)) {
    throw new EntregaValidationError("La moneda no es válida.", "detalle.moneda");
  }

  if (tipoServicio === TIPOS_SERVICIO.PROYECTO) {
    return {
      nombre_proyecto: requiredText(detail.nombre_proyecto, "El nombre del proyecto es obligatorio.", "detalle.nombre_proyecto"),
      objeto_proyecto: requiredText(detail.objeto_proyecto, "El objeto del proyecto es obligatorio.", "detalle.objeto_proyecto"),
      valor_total: parseMoney(detail.valor_total, "El valor total del proyecto no es válido.", "detalle.valor_total"),
      moneda,
      forma_pago: requiredText(detail.forma_pago, "La forma de pago es obligatoria.", "detalle.forma_pago"),
      equipo_estimacion: requiredText(detail.equipo_estimacion, "Indica el equipo con quien se estimó.", "detalle.equipo_estimacion"),
      tarifas_consultoria: requiredText(detail.tarifas_consultoria, "Las tarifas de consultoría son obligatorias.", "detalle.tarifas_consultoria")
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
  const documents = validateDocuments(payload, tipoServicio);

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
    documentos: documents.files,
    propuesta_url: documents.propuestaUrl
  };
}

module.exports = {
  EntregaValidationError,
  MAX_PDF_BYTES,
  TIPOS_SERVICIO,
  normalizeNit,
  normalizeTipoServicio,
  parsePdfDataUrl,
  validateEntregaPayload
};
