const { pool } = require("../db");
const { extractPublicIdFromContract } = require("../lib/clicksign");

function getIndexHelpers() {
  return require("../index");
}

/**
 * Reintenta procesar una cuenta de cobro firmada
 */
async function reintentarCuentaCobroFirma(cuentaId) {
  const {
    resolveClickSignArtifacts,
    isPdfBuffer,
    uploadSignedPdfToOneDrive,
    getCuentaCobroEstadoAprobado
  } = getIndexHelpers();

  try {
    const cuentaResult = await pool.query(
      `SELECT cc.id, cc.public_id, cc.created_by, cc.fecha_correspondiente, cc.created_at, cc.datos_adjuntos,
              u.nombre_usuario, u.email
       FROM cuenta_cobro cc LEFT JOIN usuarios u ON u.id = cc.created_by
       WHERE cc.id = $1 LIMIT 1`,
      [cuentaId]
    );
    const cuenta = cuentaResult.rows[0];
    if (!cuenta) return;

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object" ? cuenta.datos_adjuntos : {};
    const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object" ? prevAdjuntos.firma : {};

    if (prevFirma.documento_firmado?.url) return; // ya está resuelto
    if (prevFirma.estado !== "signed") return;    // no está firmado aún

    const requestId = String(prevFirma.request_id || "").trim();
    const contractId = String(prevFirma.contract_id || `CC-${cuenta.public_id || cuenta.id}`).trim();
    const signatureId = String(prevFirma.signature_id || "").trim();

    const artifacts = await resolveClickSignArtifacts({ event: {}, requestId, contractId, publicId: String(cuenta.public_id || ""), signatureId });
    const resolvedPdf = artifacts?.signedPdf || null;
    if (!resolvedPdf || !isPdfBuffer(resolvedPdf.buffer)) {
      console.warn("Reintento cuenta cobro: PDF aún no disponible", { cuentaId, requestId, contractId });
      return;
    }

    const nowIso = new Date().toISOString();
    const uploadResult = await uploadSignedPdfToOneDrive(cuenta, resolvedPdf.buffer, resolvedPdf.fileName);
    const documentoFirmado = { ...uploadResult.archivo, carpeta: uploadResult.carpeta, origen: resolvedPdf.source || "clicksign", actualizado_en: nowIso };

    const firma = { ...prevFirma, documento_firmado: documentoFirmado, documento_firmado_error: null, actualizado_en: nowIso };
    const prevSoportes = prevAdjuntos.soportes && typeof prevAdjuntos.soportes === "object" ? prevAdjuntos.soportes : {};
    const adjuntos = {
      ...prevAdjuntos,
      firma,
      soportes: {
        ...prevSoportes,
        carpeta: documentoFirmado.carpeta || prevSoportes.carpeta || "",
        actualizado_en: nowIso,
        cuenta_cobro_firmada: {
          id: documentoFirmado.id || prevSoportes?.cuenta_cobro_firmada?.id || null,
          nombre: documentoFirmado.nombre || prevSoportes?.cuenta_cobro_firmada?.nombre || "CuentaCobroFirmada.pdf",
          url: documentoFirmado.url || ""
        }
      }
    };

    const estadoAprobado = await getCuentaCobroEstadoAprobado();
    await pool.query(
      `UPDATE cuenta_cobro SET datos_adjuntos = $1::jsonb, estado = $2::tipo_estado_reporte, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [JSON.stringify(adjuntos), estadoAprobado, cuenta.id]
    );
    console.log(`Reintento exitoso: cuenta cobro ${cuenta.id} subida a OneDrive desde webhook diferido.`);
  } catch (err) {
    console.error("Error en reintento diferido de cuenta cobro firmada:", err?.message || err);
  }
}

/**
 * Procesa eventos webhook de firma ClickSign
 */
async function processSignatureEvent(event) {
  const {
    pickStringByPaths,
    extractClickSignSignatureId,
    normalizeClickSignStatus,
    getCuentaCobroEstadoAprobado,
    getCuentaCobroEstadoEnFirma,
    handleClickSignAnexoIndividualWebhook,
    handleClickSignContratoWebhook,
    resolveClickSignArtifacts,
    isPdfBuffer,
    uploadSignedPdfToOneDrive,
    uploadClickSignExtraFilesToOneDrive,
    buildCuentaCobroEmailAttachments,
    notifyCuentaCobroFirmadaToProveedores,
    sameResourceUrl
  } = getIndexHelpers();

  try {
    const requestId = pickStringByPaths(event, [
      "request_id",
      "signature.request_id",
      "signature.request.request_id",
      "signature.requestId",
      "data.request_id",
      "data.signature.request_id",
      "data.signature.request.request_id"
    ]);
    const contractId = pickStringByPaths(event, [
      "contract_id",
      "signature.contract_id",
      "signature.request.contract_id",
      "signature.contractId",
      "data.contract_id",
      "data.signature.contract_id",
      "data.signature.request.contract_id"
    ]);
    const signatureId = extractClickSignSignatureId(event);
    const rawStatus = pickStringByPaths(event, [
      "status",
      "signature_status",
      "signature.status",
      "event.status",
      "data.status"
    ]);
    const status = normalizeClickSignStatus(rawStatus);
    const publicIdFromEvent = extractPublicIdFromContract(contractId) || pickStringByPaths(event, [
      "public_id",
      "cuenta_public_id",
      "data.public_id"
    ]);

    const CUENTA_COBRO_SELECT = `
        SELECT
          cc.id,
          cc.public_id,
          cc.created_by,
          cc.fecha_correspondiente,
          cc.created_at,
          cc.datos_adjuntos,
          u.nombre_usuario,
          u.email
        FROM cuenta_cobro cc
        LEFT JOIN usuarios u ON u.id = cc.created_by`;

    let cuentaResult = null;
    if (publicIdFromEvent) {
      cuentaResult = await pool.query(
        `${CUENTA_COBRO_SELECT} WHERE cc.public_id = $1 LIMIT 1`,
        [publicIdFromEvent]
      );
    }
    if (!cuentaResult?.rows?.length && requestId) {
      cuentaResult = await pool.query(
        `${CUENTA_COBRO_SELECT}
        WHERE cc.datos_adjuntos->'firma'->>'request_id' = $1
        ORDER BY cc.id DESC LIMIT 1`,
        [requestId]
      );
    }
    if (!cuentaResult?.rows?.length && contractId) {
      cuentaResult = await pool.query(
        `${CUENTA_COBRO_SELECT}
        WHERE cc.datos_adjuntos->'firma'->>'contract_id' = $1
        ORDER BY cc.id DESC LIMIT 1`,
        [contractId]
      );
    }

    const cuenta = cuentaResult?.rows?.[0] || null;

    if (!cuenta && (requestId || contractId)) {
      const handledAnexoIndividual = await handleClickSignAnexoIndividualWebhook({
        event,
        requestId,
        contractId,
        status,
        rawStatus
      });
      if (handledAnexoIndividual) {
        return;
      }
      await handleClickSignContratoWebhook({ event, requestId, contractId, status, rawStatus });
      return;
    }

    if (!cuenta) {
      console.warn("Webhook Click&Sign sin cuenta asociada:", { requestId, contractId, rawStatus });
      return;
    }

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
      ? cuenta.datos_adjuntos
      : {};
    const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object"
      ? prevAdjuntos.firma
      : {};
    const prevDocumentoFirmado = prevFirma.documento_firmado && typeof prevFirma.documento_firmado === "object"
      ? prevFirma.documento_firmado
      : null;

    const nowIso = new Date().toISOString();
    const eventosPrev = Array.isArray(prevFirma.eventos) ? prevFirma.eventos.slice(-19) : [];
    const eventoResumen = {
      recibido_en: nowIso,
      status: rawStatus || status || "",
      request_id: requestId || null,
      contract_id: contractId || null
    };

    let documentoFirmado = prevDocumentoFirmado;
    let documentoFirmadoError = "";
    let documentosAdjuntosCorreo = [];

    let uploadedExtras = [];
    if (status === "signed") {
      const artifacts = await resolveClickSignArtifacts({
        event,
        requestId,
        contractId,
        publicId: String(cuenta.public_id || ""),
        signatureId: signatureId || prevFirma.signature_id || ""
      });
      const resolvedPdf = artifacts?.signedPdf || null;

      if (resolvedPdf && isPdfBuffer(resolvedPdf.buffer)) {
        documentosAdjuntosCorreo = buildCuentaCobroEmailAttachments({
          cuenta,
          signedPdf: {
            buffer: resolvedPdf.buffer,
            fileName: resolvedPdf.fileName || ""
          },
          extraFiles: artifacts?.extraFiles || []
        });
        try {
          const uploadResult = await uploadSignedPdfToOneDrive(
            cuenta,
            resolvedPdf.buffer,
            resolvedPdf.fileName
          );
          documentoFirmado = {
            ...uploadResult.archivo,
            carpeta: uploadResult.carpeta,
            origen: resolvedPdf.source || "clicksign",
            actualizado_en: nowIso
          };
          try {
            const extrasResult = await uploadClickSignExtraFilesToOneDrive(
              cuenta,
              artifacts?.extraFiles || [],
              uploadResult.carpeta || ""
            );
            uploadedExtras = extrasResult.uploaded || [];
          } catch (extraErr) {
            console.warn("No se pudieron subir adjuntos extra de Click&Sign:", extraErr?.message || extraErr);
          }
        } catch (uploadErr) {
          documentoFirmadoError = `Error almacenando firmado en OneDrive: ${uploadErr.message || "desconocido"}`;
          console.error("Error guardando firmado en OneDrive:", uploadErr?.message || uploadErr);
        }
      } else {
        documentoFirmadoError = "No se encontró PDF firmado en webhook/API de Click&Sign.";
        console.warn("No se pudo resolver PDF firmado de Click&Sign:", { requestId, contractId, cuentaId: cuenta.id });
      }
    }

    const firma = {
      ...prevFirma,
      estado: status || prevFirma.estado || "pending",
      request_id: requestId || prevFirma.request_id || null,
      contract_id: contractId || prevFirma.contract_id || null,
      signature_id: signatureId || prevFirma.signature_id || null,
      actualizado_en: nowIso,
      ultimo_evento: rawStatus || status || "webhook",
      eventos: [...eventosPrev, eventoResumen]
    };
    if (documentoFirmado && documentoFirmado.url) {
      firma.documento_firmado = documentoFirmado;
    }
    if (documentoFirmadoError) {
      firma.documento_firmado_error = documentoFirmadoError;
    } else if (status === "signed" && prevFirma.documento_firmado_error) {
      firma.documento_firmado_error = null;
    }
    if (status === "signed" && documentoFirmado?.url) {
      const prevNotificacionProveedores =
        prevFirma.notificacion_proveedores && typeof prevFirma.notificacion_proveedores === "object"
          ? prevFirma.notificacion_proveedores
          : {};
      const notificacion = await notifyCuentaCobroFirmadaToProveedores({
        cuenta,
        documentoFirmado,
        attachments: documentosAdjuntosCorreo,
        prevNotification: prevNotificacionProveedores,
        nowIso
      });
      if (notificacion) {
        firma.notificacion_proveedores = notificacion;
      }
    }

    const adjuntos = {
      ...prevAdjuntos,
      firma
    };
    if (documentoFirmado && documentoFirmado.url) {
      const prevSoportes = prevAdjuntos.soportes && typeof prevAdjuntos.soportes === "object"
        ? prevAdjuntos.soportes
        : {};
      const nuevoSoporteCuentaFirmada = {
        id: documentoFirmado.id || prevSoportes?.cuenta_cobro_firmada?.id || prevSoportes?.cuenta_cobro?.id || null,
        nombre: documentoFirmado.nombre || prevSoportes?.cuenta_cobro_firmada?.nombre || prevSoportes?.cuenta_cobro?.nombre || "CuentaCobroFirmada.pdf",
        url: documentoFirmado.url || prevSoportes?.cuenta_cobro_firmada?.url || prevSoportes?.cuenta_cobro?.url || ""
      };
      adjuntos.soportes = {
        ...prevSoportes,
        carpeta: documentoFirmado.carpeta || prevSoportes.carpeta || "",
        actualizado_en: nowIso,
        cuenta_cobro_firmada: nuevoSoporteCuentaFirmada
      };
      const extraSeguridad = uploadedExtras.find((item) => item.kind === "seguridad_social_firma" && item.url);
      const extraEvidencia = uploadedExtras.find((item) => item.kind === "evidencia_firma" && item.url);
      const extraAnexo = uploadedExtras.find((item) => item.kind === "anexo_firma" && item.url);
      const cuentaFirmadaUrl = nuevoSoporteCuentaFirmada.url || "";
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
    }

    let estadoDestino = null;
    if (status === "signed") {
      const estadoAprobado = await getCuentaCobroEstadoAprobado();
      estadoDestino = (documentoFirmado && documentoFirmado.url)
        ? estadoAprobado
        : await getCuentaCobroEstadoEnFirma();
    } else if (status === "rejected") {
      estadoDestino = "Rechazado";
    } else if (status === "pending") {
      estadoDestino = await getCuentaCobroEstadoEnFirma();
    }

    if (estadoDestino) {
      await pool.query(
        `
        UPDATE cuenta_cobro
        SET datos_adjuntos = $1::jsonb,
            estado = $2::tipo_estado_reporte,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        `,
        [JSON.stringify(adjuntos), estadoDestino, cuenta.id]
      );
    } else {
      await pool.query(
        `
        UPDATE cuenta_cobro
        SET datos_adjuntos = $1::jsonb,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        `,
        [JSON.stringify(adjuntos), cuenta.id]
      );
    }

    if (status === "signed" && !documentoFirmado?.url) {
      setTimeout(() => reintentarCuentaCobroFirma(cuenta.id), 30000);
    }
  } catch (innerErr) {
    console.error("Error procesando webhook Click&Sign:", innerErr);
  }
}

module.exports = {
  processSignatureEvent,
  reintentarCuentaCobroFirma
};
