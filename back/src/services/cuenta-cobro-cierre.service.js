const { pool: defaultPool } = require("../db");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getDocumentoFirmadoUrl(adjuntos = {}) {
  return String(asPlainObject(asPlainObject(adjuntos).firma).documento_firmado?.url || "").trim();
}

function buildCuentaFirmaDiagnosticoFromResolution(resolution = {}, nowIso = new Date().toISOString()) {
  const diagnostico = asPlainObject(resolution.diagnostico);
  return {
    ultimo_check_en: diagnostico.ultimo_check_en || nowIso,
    request_id: resolution.requestId || diagnostico.request_id || null,
    contract_id: resolution.contractId || diagnostico.contract_id || null,
    signature_id: resolution.signatureId || diagnostico.signature_id || null,
    rawStatus: resolution.rawStatus || diagnostico.rawStatus || null,
    normalizedStatus: resolution.normalizedStatus || diagnostico.normalizedStatus || null,
    catalogSource: resolution.catalogSource || diagnostico.catalogSource || null,
    reason: resolution.reason || diagnostico.reason || "pending",
    origen: resolution.source || diagnostico.origen || null
  };
}

function cuentasFirmaAutocierreHabilitado(value = process.env.CUENTAS_FIRMA_AUTOCIERRE) {
  return ["true", "1", "yes", "y", "si", "on"].includes(String(value || "").trim().toLowerCase());
}

function getDefaultDeps() {
  const index = require("../index");
  return {
    pool: defaultPool,
    isPdfBuffer: index.isPdfBuffer,
    buildCuentaCobroEmailAttachments: index.buildCuentaCobroEmailAttachments,
    uploadSignedPdfToOneDrive: index.uploadSignedPdfToOneDrive,
    uploadClickSignExtraFilesToOneDrive: index.uploadClickSignExtraFilesToOneDrive,
    sameResourceUrl: index.sameResourceUrl,
    notifyCuentaCobroFirmadaToProveedores: index.notifyCuentaCobroFirmadaToProveedores,
    downloadGraphItemContent: index.downloadGraphItemContent,
    getGraphContext: index.getGraphContext,
    getCuentaCobroEstadoAprobado: index.getCuentaCobroEstadoAprobado,
    getCuentaCobroEstadoEnFirma: index.getCuentaCobroEstadoEnFirma,
    logger: console
  };
}

function resolveDeps(overrides = {}) {
  const requiredKeys = [
    "pool",
    "isPdfBuffer",
    "buildCuentaCobroEmailAttachments",
    "uploadSignedPdfToOneDrive",
    "uploadClickSignExtraFilesToOneDrive",
    "sameResourceUrl",
    "notifyCuentaCobroFirmadaToProveedores",
    "getGraphContext",
    "getCuentaCobroEstadoAprobado",
    "getCuentaCobroEstadoEnFirma"
  ];
  const needsDefaults = requiredKeys.some((key) => !overrides[key]);
  const defaults = needsDefaults ? getDefaultDeps() : { logger: console };
  return {
    ...defaults,
    ...overrides
  };
}

async function cerrarCuentaCobroConFirmaResuelta({
  req,
  cuenta,
  resolution,
  origen = "reconciliacion",
  deps = {}
} = {}) {
  const autocierreHabilitado = cuentasFirmaAutocierreHabilitado();
  if (!autocierreHabilitado) {
    return {
      updated: false,
      signed: Boolean(resolution?.signed),
      reason: "autocierre_deshabilitado",
      autocierreHabilitado: false
    };
  }

  const {
    pool,
    isPdfBuffer,
    buildCuentaCobroEmailAttachments,
    uploadSignedPdfToOneDrive,
    uploadClickSignExtraFilesToOneDrive,
    sameResourceUrl,
    notifyCuentaCobroFirmadaToProveedores,
    downloadGraphItemContent,
    getGraphContext,
    getCuentaCobroEstadoAprobado,
    getCuentaCobroEstadoEnFirma,
    logger
  } = resolveDeps(deps);

  if (!resolution?.signed || !resolution?.signedPdf || !isPdfBuffer(resolution.signedPdf.buffer)) {
    return { updated: false, signed: false, reason: resolution?.reason || "sin_pdf" };
  }

  const estadoEnFirma = await getCuentaCobroEstadoEnFirma();
  const estadoAprobado = await getCuentaCobroEstadoAprobado();
  const nowIso = new Date().toISOString();
  const signedPdf = resolution.signedPdf;
  let seguridadEnAttachments = (resolution.extraFiles || [])
    .some((file) => file?.kind === "seguridad_social_firma" && isPdfBuffer(file.buffer));
  const uploadResult = await uploadSignedPdfToOneDrive(
    cuenta,
    signedPdf.buffer,
    signedPdf.fileName
  );
  const documentoFirmado = {
    ...uploadResult.archivo,
    carpeta: uploadResult.carpeta,
    origen: signedPdf.source || "clicksign",
    actualizado_en: nowIso
  };

  let uploadedExtras = [];
  try {
    const extrasResult = await uploadClickSignExtraFilesToOneDrive(
      cuenta,
      resolution.extraFiles || [],
      uploadResult.carpeta || ""
    );
    uploadedExtras = extrasResult.uploaded || [];
  } catch (extraErr) {
    logger?.warn?.(`No se pudieron subir adjuntos extra de Click&Sign (${origen}):`, extraErr?.message || extraErr);
  }

  const attachments = buildCuentaCobroEmailAttachments({
    cuenta,
    signedPdf: {
      buffer: signedPdf.buffer,
      fileName: signedPdf.fileName || ""
    },
    extraFiles: resolution.extraFiles || []
  });

  const client = await pool.connect();
  let prevNotificacionProveedores = {};
  let prevSeguridadSocialSoporte = null;
  let persisted = null;
  try {
    await client.query("BEGIN");
    const lockedResult = await client.query(
      `
      SELECT id, public_id, estado, datos_adjuntos
      FROM cuenta_cobro
      WHERE id = $1
      FOR UPDATE
      `,
      [cuenta.id]
    );
    const lockedCuenta = lockedResult.rows[0] || null;
    if (!lockedCuenta) {
      await client.query("ROLLBACK");
      const err = new Error("Cuenta no encontrada");
      err.code = "PUBLIC_ID_NOT_FOUND";
      throw err;
    }

    const currentAdjuntos = asPlainObject(lockedCuenta.datos_adjuntos);
    const currentFirma = asPlainObject(currentAdjuntos.firma);
    prevNotificacionProveedores = asPlainObject(currentFirma.notificacion_proveedores);
    const currentDocumentoUrl = getDocumentoFirmadoUrl(currentAdjuntos);
    if (lockedCuenta.estado !== estadoEnFirma || currentDocumentoUrl) {
      await client.query("COMMIT");
      return {
        updated: false,
        raceLost: true,
        reason: "race_lost",
        estadoCuenta: lockedCuenta.estado || null,
        documentoFirmadoUrl: currentDocumentoUrl || null,
        documentoFirmado,
        uploadedExtras
      };
    }

    const diagnostico = {
      ...buildCuentaFirmaDiagnosticoFromResolution(resolution, nowIso),
      normalizedStatus: "signed",
      reason: "firmado_subido"
    };
    const firma = {
      ...currentFirma,
      estado: "signed",
      request_id: resolution.requestId || null,
      contract_id: resolution.contractId || null,
      signature_id: resolution.signatureId || diagnostico.signature_id || null,
      actualizado_en: nowIso,
      ultimo_evento: resolution.rawStatus || "signed",
      diagnostico,
      documento_firmado: documentoFirmado,
      documento_firmado_error: null
    };
    const adjuntos = {
      ...currentAdjuntos,
      firma
    };

    const prevSoportes = asPlainObject(currentAdjuntos.soportes);
    const currentSeguridadSocial = asPlainObject(prevSoportes.seguridad_social);
    if (currentSeguridadSocial.id) {
      prevSeguridadSocialSoporte = {
        id: currentSeguridadSocial.id,
        nombre: currentSeguridadSocial.nombre || "SeguridadSocial.pdf",
        url: currentSeguridadSocial.url || ""
      };
    }
    const cuentaFirmadaUrl = documentoFirmado.url || "";
    adjuntos.soportes = {
      ...prevSoportes,
      carpeta: documentoFirmado.carpeta || prevSoportes.carpeta || "",
      actualizado_en: nowIso,
      cuenta_cobro_firmada: {
        id: documentoFirmado.id || prevSoportes?.cuenta_cobro_firmada?.id || prevSoportes?.cuenta_cobro?.id || null,
        nombre: documentoFirmado.nombre || prevSoportes?.cuenta_cobro_firmada?.nombre || prevSoportes?.cuenta_cobro?.nombre || "CuentaCobroFirmada.pdf",
        url: cuentaFirmadaUrl
      }
    };

    const extraSeguridad = uploadedExtras.find((item) => item.kind === "seguridad_social_firma" && item.url);
    const extraEvidencia = uploadedExtras.find((item) => item.kind === "evidencia_firma" && item.url);
    const extraAnexo = uploadedExtras.find((item) => item.kind === "anexo_firma" && item.url);
    if (extraSeguridad && !sameResourceUrl(extraSeguridad.url, cuentaFirmadaUrl)) {
      adjuntos.soportes.seguridad_social_firma = {
        id: extraSeguridad.id || null,
        nombre: extraSeguridad.nombre || "SeguridadSocial.pdf",
        url: extraSeguridad.url || ""
      };
      if (!adjuntos.soportes.seguridad_social?.url) {
        adjuntos.soportes.seguridad_social = { ...adjuntos.soportes.seguridad_social_firma };
      }
    }
    if (extraEvidencia && !sameResourceUrl(extraEvidencia.url, cuentaFirmadaUrl)) {
      adjuntos.soportes.evidencia_firma = {
        id: extraEvidencia.id || null,
        nombre: extraEvidencia.nombre || "EvidenciaFirma.pdf",
        url: extraEvidencia.url || ""
      };
    }
    if (extraAnexo && !sameResourceUrl(extraAnexo.url, cuentaFirmadaUrl)) {
      adjuntos.soportes.anexo_firma = {
        id: extraAnexo.id || null,
        nombre: extraAnexo.nombre || "AnexoFirma.pdf",
        url: extraAnexo.url || ""
      };
    }

    const updateResult = await client.query(
      `
      UPDATE cuenta_cobro
      SET datos_adjuntos = $1::jsonb,
          estado = $2::tipo_estado_reporte,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
        AND estado = $4::tipo_estado_reporte
        AND COALESCE(datos_adjuntos->'firma'->'documento_firmado'->>'url', '') = ''
      `,
      [JSON.stringify(adjuntos), estadoAprobado, cuenta.id, estadoEnFirma]
    );
    await client.query("COMMIT");

    if (updateResult.rowCount === 0) {
      return {
        updated: false,
        raceLost: true,
        reason: "race_lost",
        estadoCuenta: null,
        documentoFirmadoUrl: null,
        documentoFirmado,
        uploadedExtras
      };
    }

    persisted = {
      updated: true,
      estadoCuenta: estadoAprobado,
      documentoFirmado,
      firma,
      uploadedExtras,
      diagnostico
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) { }
    throw err;
  } finally {
    client.release();
  }

  if (!seguridadEnAttachments && prevSeguridadSocialSoporte?.id && attachments.length < 4 && typeof downloadGraphItemContent === "function") {
    try {
      const download = await downloadGraphItemContent(prevSeguridadSocialSoporte.id);
      const seguridadBuffer = Buffer.isBuffer(download?.buffer) ? download.buffer : null;
      if (isPdfBuffer(seguridadBuffer) && seguridadBuffer.length <= 8 * 1024 * 1024) {
        attachments.push({
          filename: prevSeguridadSocialSoporte.nombre || "SeguridadSocial.pdf",
          contentType: "application/pdf",
          content: seguridadBuffer
        });
        seguridadEnAttachments = true;
      }
    } catch (err) {
      logger?.warn?.(`No se pudo adjuntar seguridad social previa para ${cuenta.public_id || cuenta.id}:`, err?.message || err);
    }
  }

  if (!seguridadEnAttachments) {
    let catalogo = "[]";
    try {
      catalogo = JSON.stringify(resolution.catalogEntries || []).slice(0, 1200);
    } catch (_) {
      catalogo = "[]";
    }
    logger?.warn?.(`[firma-cuenta] Cierre sin seguridad social adjunta para ${cuenta.public_id || cuenta.id}. catalogEntries=${catalogo}`);
  }

  const notificacion = await notifyCuentaCobroFirmadaToProveedores({
    cuenta,
    documentoFirmado,
    attachments,
    prevNotification: prevNotificacionProveedores,
    nowIso,
    graphContext: getGraphContext(req),
    extraMeta: { seguridad_social_incluida: seguridadEnAttachments }
  });

  return {
    ...persisted,
    notificacion
  };
}

module.exports = {
  asPlainObject,
  getDocumentoFirmadoUrl,
  buildCuentaFirmaDiagnosticoFromResolution,
  cuentasFirmaAutocierreHabilitado,
  cerrarCuentaCobroConFirmaResuelta
};
