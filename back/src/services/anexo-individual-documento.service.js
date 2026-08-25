const PDFDocument = require("pdfkit");

const TIPOS_CON_CLIENTE = new Set(["full_time", "medio_tiempo", "proyecto"]);
const ANEXO_TIPO_LABELS = Object.freeze({
  full_time: "180/160 Horas",
  medio_tiempo: "80/90 Horas",
  proyecto: "Proyecto",
  horas: "Horas",
  capacitacion: "Capacitacion"
});

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

function labelAnexoTipo(tipo) {
  return ANEXO_TIPO_LABELS[text(tipo)] || text(tipo) || "-";
}

function formatDate(value) {
  // pg entrega las columnas DATE como objetos Date. Sin este caso, String(fecha) produce
  // "Tue Sep 01 2026 00:00:00 GMT-0500" y el corte a 10 caracteres dejaba "Tue Sep 01".
  // Se usan los getters locales porque pg construye esas fechas a medianoche local.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "-";
    const dia = String(value.getDate()).padStart(2, "0");
    const mes = String(value.getMonth() + 1).padStart(2, "0");
    return `${dia}/${mes}/${value.getFullYear()}`;
  }
  const raw = text(value).slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : (raw || "-");
}

function formatMoney(value, currency = "COP") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  try {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: text(currency).toUpperCase() || "COP",
      maximumFractionDigits: 2
    }).format(amount);
  } catch (_) {
    return `${text(currency).toUpperCase() || "COP"} ${amount}`;
  }
}

function safeFilePart(value, fallback = "Persona") {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;
}

function fitCellText(doc, value, width) {
  const original = text(value) || "-";
  if (doc.widthOfString(original) <= width) return original;
  let result = original;
  while (result.length > 1 && doc.widthOfString(`${result}...`) > width) {
    result = result.slice(0, -1);
  }
  return `${result.trimEnd()}...`;
}

function generateAnexoIndividualManualPdfFromItems({ userRow, items, correoFirmante = "" } = {}) {
  const context = buildAnexoIndividualDocumentContext({ userRow, items, correoFirmante });
  const fecha = new Date().toISOString().slice(0, 10);
  const fileName = `AnexoTecnicoIndividual_${safeFilePart(context.personaContext.nombreCompleto)}_${fecha}.pdf`;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 28,
      autoFirstPage: true,
      info: {
        Title: `Anexo técnico individual - ${context.personaContext.nombreCompleto}`,
        Author: "Silver Consulting"
      }
    });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve({
      pdfBuffer: Buffer.concat(chunks),
      fileName,
      pageCount: 1
    }));

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const left = 28;
    const contentWidth = pageWidth - (left * 2);
    const navy = "#17365D";
    const cyan = "#00A6A6";
    const pale = "#F2F7FA";
    const line = "#D8E1E8";
    const textColor = "#243447";

    doc.rect(0, 0, pageWidth, 72).fill(navy);
    doc.rect(0, 72, pageWidth, 4).fill(cyan);
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#FFFFFF")
      .text("ANEXO TÉCNICO", left, 20, { width: contentWidth, lineBreak: false });
    doc.font("Helvetica").fontSize(8.5).fillColor("#DDEAF2")
      .text("Resumen de asignaciones vigentes", left, 46, { lineBreak: false });

    const persona = context.personaContext;
    const documentLabel = [persona.tipoDocumento, persona.numeroDocumento].filter(Boolean).join(" ");
    doc.font("Helvetica-Bold").fontSize(10).fillColor(textColor)
      .text(persona.nombreCompleto, left, 90, { width: 300, lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor("#526575")
      .text(`Documento: ${documentLabel || "-"}`, left, 108, { width: 300, lineBreak: false });
    doc.text(`Correo: ${persona.correoPersonal || "-"}`, left + 320, 108, { width: 300, lineBreak: false });
    doc.text(`Generado: ${formatDate(fecha)}`, pageWidth - 190, 90, { width: 160, align: "right", lineBreak: false });

    const tableTop = 136;
    const footerTop = pageHeight - 70;
    const headerHeight = 22;
    const availableRowsHeight = footerTop - tableTop - headerHeight - 8;
    const rowHeight = Math.min(26, availableRowsHeight / Math.max(context.items.length, 1));
    const fontSize = Math.max(4.5, Math.min(8, rowHeight * 0.34));
    const columns = [
      { title: "TIPO", key: "tipo", width: 0.16 },
      { title: "CLIENTE", key: "cliente", width: 0.21 },
      { title: "MÓDULO", key: "modulo", width: 0.20 },
      { title: "VALOR", key: "valor", width: 0.18, align: "right" },
      { title: "INICIO", key: "inicio", width: 0.125, align: "center" },
      { title: "FIN", key: "fin", width: 0.125, align: "center" }
    ];

    let x = left;
    columns.forEach((column, index) => {
      column.x = x;
      column.points = index === columns.length - 1
        ? left + contentWidth - x
        : contentWidth * column.width;
      x += column.points;
    });

    doc.rect(left, tableTop, contentWidth, headerHeight).fill(navy);
    columns.forEach((column) => {
      doc.font("Helvetica-Bold").fontSize(7).fillColor("#FFFFFF")
        .text(column.title, column.x + 5, tableTop + 7, {
          width: column.points - 10,
          align: column.align || "left",
          lineBreak: false
        });
    });

    let y = tableTop + headerHeight;
    context.items.forEach((item, index) => {
      if (index % 2 === 0) doc.rect(left, y, contentWidth, rowHeight).fill(pale);
      doc.moveTo(left, y + rowHeight).lineTo(left + contentWidth, y + rowHeight)
        .strokeColor(line).lineWidth(0.5).stroke();

      const tipo = text(item?.tipo_asignacion);
      const suffix = tipo === "horas" || tipo === "capacitacion" ? " / hora" : " / mes";
      const values = {
        tipo: labelAnexoTipo(tipo),
        cliente: text(item?.cliente_nombre) || "-",
        modulo: text(item?.modulo_titulo || item?.modulo_nombre) || "-",
        valor: `${formatMoney(item?.valor_tarifa, item?.moneda)}${suffix}`,
        inicio: formatDate(item?.fecha_inicio),
        fin: formatDate(item?.fecha_fin)
      };

      columns.forEach((column) => {
        doc.font(column.key === "valor" ? "Helvetica-Bold" : "Helvetica")
          .fontSize(fontSize)
          .fillColor(textColor);
        const value = fitCellText(doc, values[column.key], column.points - 10);
        doc.text(value, column.x + 5, y + Math.max(2, (rowHeight - fontSize) / 2 - 1), {
          width: column.points - 10,
          align: column.align || "left",
          lineBreak: false
        });
      });
      y += rowHeight;
    });

    doc.rect(left, tableTop, contentWidth, headerHeight + (rowHeight * context.items.length))
      .strokeColor(line).lineWidth(0.7).stroke();

    doc.moveTo(pageWidth - 275, pageHeight - 58).lineTo(pageWidth - 45, pageHeight - 58)
      .strokeColor("#8395A7").lineWidth(0.7).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor("#526575")
      .text("Firma de la persona", pageWidth - 275, pageHeight - 52, {
        width: 230,
        align: "center",
        lineBreak: false
      });
    doc.font("Helvetica").fontSize(6.5).fillColor("#8395A7")
      .text("Documento generado por Silver Consulting", left, pageHeight - 50, {
        width: 280,
        lineBreak: false
      });

    doc.end();
  });
}

module.exports = {
  ANEXO_TIPO_LABELS,
  buildAnexoIndividualDocumentContext,
  generateAnexoIndividualManualPdfFromItems,
  labelAnexoTipo,
  __private: { formatDate }
};
