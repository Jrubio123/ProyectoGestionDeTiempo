const TIPOS_CON_CLIENTE = new Set(["full_time", "medio_tiempo", "proyecto"]);

function text(value) {
  return String(value || "").trim();
}

function buildAnexoIndividualDocumentContext({ userRow, items = [], correoFirmante = "" } = {}) {
  const rows = Array.isArray(items) ? items : [];
  const tipoDocumento = text(userRow?.tipo_documento_codigo || userRow?.tipo_documento_titulo);
  const numeroDocumento = text(userRow?.cedula);
  const nombreCompleto = text(userRow?.nombre_usuario);
  const correoPersonal = text(correoFirmante || userRow?.email);
  const direccion = text(userRow?.direccion);
  const ciudad = text(userRow?.ciudad);
  const missing = [];

  if (!nombreCompleto) missing.push("Nombre completo");
  if (!tipoDocumento) missing.push("Tipo de documento");
  if (!numeroDocumento) missing.push("Número de documento");
  if (!correoPersonal) missing.push("Correo del firmante");
  if (!direccion) missing.push("Dirección");
  if (!ciudad) missing.push("Ciudad");
  if (!rows.length) missing.push("Ítems activos del anexo");

  rows.forEach((item, index) => {
    const rowLabel = `Ítem ${index + 1}`;
    const tipo = text(item?.tipo_asignacion);
    const valorTarifa = Number(item?.valor_tarifa);

    if (!tipo) missing.push(`${rowLabel}: tipo de asignación`);
    if (TIPOS_CON_CLIENTE.has(tipo) && !text(item?.cliente_nombre)) {
      missing.push(`${rowLabel}: cliente`);
    }
    if (!Number.isFinite(valorTarifa) || valorTarifa < 0) {
      missing.push(`${rowLabel}: tarifa`);
    }
    if (!text(item?.fecha_inicio)) missing.push(`${rowLabel}: fecha de inicio`);
    if (!text(item?.fecha_fin)) missing.push(`${rowLabel}: fecha de finalización`);
  });

  if (missing.length) {
    const err = new Error(`Faltan datos para generar el anexo técnico: ${missing.join(", ")}`);
    err.status = 422;
    err.code = "ANEXO_DOCUMENTO_INCOMPLETO";
    err.missing = missing;
    throw err;
  }

  return {
    personaContext: {
      nombreCompleto,
      tipoDocumento,
      numeroDocumento,
      telefono: text(userRow?.telefono),
      correoPersonal,
      direccion,
      ciudad,
      facturaEnColombia: userRow?.factura_en_colombia ?? null
    },
    proceso: {
      nombre_persona: nombreCompleto,
      correo_personal: correoPersonal
    },
    items: rows
  };
}

module.exports = {
  buildAnexoIndividualDocumentContext
};
