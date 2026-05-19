const { pool } = require("../db");
const { extractPublicIdFromContract } = require("../lib/clicksign");

function getIndexHelpers() {
  return require("../index");
}

function esIdentificadorContratoClickSign(valor) {
  const texto = String(valor || "").trim();
  return texto.startsWith("CF-") || texto.startsWith("contrato_");
}

function esWebhookDeContrato({ requestId = "", contractId = "" } = {}) {
  return esIdentificadorContratoClickSign(requestId) || esIdentificadorContratoClickSign(contractId);
}

function esIdentificadorCuentaCobroClickSign(valor) {
  return String(valor || "").trim().startsWith("CC-");
}

function esWebhookDeCuentaCobro({ requestId = "", contractId = "" } = {}) {
  return esIdentificadorCuentaCobroClickSign(requestId) || esIdentificadorCuentaCobroClickSign(contractId);
}

function esIdentificadorAnexoIndividualClickSign(valor) {
  const texto = String(valor || "").trim();
  return texto.startsWith("ANX-") || texto.startsWith("anexo_individual_");
}

function esWebhookDeAnexoIndividual({ requestId = "", contractId = "" } = {}) {
  return esIdentificadorAnexoIndividualClickSign(requestId) || esIdentificadorAnexoIndividualClickSign(contractId);
}

/**
 * Reintenta procesar una cuenta de cobro firmada
 */
async function reintentarCuentaCobroFirma(cuentaId) {
  const {
    fetchClickSignSignatureSnapshot,
    extractClickSignSignatureId,
    normalizeClickSignStatus,
    resolveClickSignArtifacts,
    isPdfBuffer,
    uploadSignedPdfToOneDrive,
    getCuentaCobroEstadoAprobado,
    buildCuentaCobroEmailAttachments,
    notifyCuentaCobroFirmadaToProveedores
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

    const requestId = String(prevFirma.request_id || "").trim();
    const contractId = String(prevFirma.contract_id || `CC-${cuenta.public_id || cuenta.id}`).trim();
    let signatureId = String(prevFirma.signature_id || "").trim();
    let event = {};
    let firmaEstado = normalizeClickSignStatus(prevFirma.estado || "");

    if (firmaEstado !== "signed") {
      const snapshot = await fetchClickSignSignatureSnapshot({ requestId, contractId, signatureId });
      event = snapshot.event && typeof snapshot.event === "object" ? snapshot.event : {};
      firmaEstado = normalizeClickSignStatus(snapshot.rawStatus || snapshot.status || prevFirma.estado || "");
      signatureId = signatureId || String(extractClickSignSignatureId(event) || "").trim();
      if (firmaEstado !== "signed") return;
    }

    const artifacts = await resolveClickSignArtifacts({
      event,
      requestId,
      contractId,
      publicId: String(cuenta.public_id || ""),
      signatureId,
      allowCatalogFallback: true
    });
    const resolvedPdf = artifacts?.signedPdf || null;
    if (!resolvedPdf || !isPdfBuffer(resolvedPdf.buffer)) {
      console.warn("Reintento cuenta cobro: PDF aún no disponible", { cuentaId, requestId, contractId });
      return;
    }

    const nowIso = new Date().toISOString();
    const uploadResult = await uploadSignedPdfToOneDrive(cuenta, resolvedPdf.buffer, resolvedPdf.fileName);
    const documentoFirmado = {
      ...uploadResult.archivo,
      onedrive_url: uploadResult.archivo?.url || "",
      carpeta: uploadResult.carpeta,
      origen: resolvedPdf.source || "clicksign",
      actualizado_en: nowIso
    };

    const firma = { ...prevFirma, estado: "signed", documento_firmado: documentoFirmado, documento_firmado_error: null, actualizado_en: nowIso };
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
    try {
      const attachments = buildCuentaCobroEmailAttachments({
        cuenta,
        signedPdf: {
          buffer: resolvedPdf.buffer,
          fileName: resolvedPdf.fileName || ""
        },
        extraFiles: artifacts?.extraFiles || []
      });
      await notifyCuentaCobroFirmadaToProveedores({
        cuenta,
        documentoFirmado,
        attachments,
        prevNotification: prevFirma.notificacion_proveedores || {},
        nowIso
      });
    } catch (notifyErr) {
      console.warn("No se pudo notificar cuenta de cobro firmada en reintento:", notifyErr?.message || notifyErr);
    }
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
      "event.name",
      "event.type",
      "data.status",
      "data.signature_status",
      "data.signature.status",
      "data.event.status",
      "data.event.name",
      "data.event.type",
      "data.request",
      "request",
      "type",
      "name",
      "action",
      "data.type",
      "data.name",
      "data.action"
    ]);
    const status = normalizeClickSignStatus(rawStatus);
    const esContrato = esWebhookDeContrato({ requestId, contractId });
    const esCuentaCobro = esWebhookDeCuentaCobro({ requestId, contractId });
    const esAnexoIndividual = esWebhookDeAnexoIndividual({ requestId, contractId });

    if (esContrato) {
      await handleClickSignContratoWebhook({ event, requestId, contractId, signatureId, status, rawStatus });
      return;
    }

    if (esAnexoIndividual) {
      const handledAnexoIndividual = await handleClickSignAnexoIndividualWebhook({
        event,
        requestId,
        contractId,
        signatureId,
        status,
        rawStatus
      });
      if (!handledAnexoIndividual) {
        console.warn("Webhook Click&Sign de anexo individual sin proceso asociado:", {
          requestId,
          contractId,
          signatureId,
          rawStatus
        });
      }
      return;
    }

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

    const client = await pool.connect();
    let transactionOpen = false;
    let cuenta = null;
    let sinCuenta = false;
    let notificacionPendiente = null;
    const rollbackIfOpen = async () => {
      if (!transactionOpen) return;
      await client.query("ROLLBACK");
      transactionOpen = false;
    };

    try {
      await client.query("BEGIN");
      transactionOpen = true;

      let cuentaResult = null;
      if (publicIdFromEvent) {
        cuentaResult = await client.query(
          `${CUENTA_COBRO_SELECT} WHERE cc.public_id = $1 LIMIT 1 FOR UPDATE`,
          [publicIdFromEvent]
        );
      }
      if (!cuentaResult?.rows?.length && requestId) {
        cuentaResult = await client.query(
          `${CUENTA_COBRO_SELECT}
          WHERE cc.datos_adjuntos->'firma'->>'request_id' = $1
          ORDER BY cc.id DESC LIMIT 1 FOR UPDATE`,
          [requestId]
        );
      }
      if (!cuentaResult?.rows?.length && contractId) {
        cuentaResult = await client.query(
          `${CUENTA_COBRO_SELECT}
          WHERE cc.datos_adjuntos->'firma'->>'contract_id' = $1
          ORDER BY cc.id DESC LIMIT 1 FOR UPDATE`,
          [contractId]
        );
      }

      cuenta = cuentaResult?.rows?.[0] || null;
      if (!cuenta) {
        await rollbackIfOpen();
        sinCuenta = true;
      } else if (status !== "signed" && status !== "rejected") {
        console.warn("Webhook cuenta cobro: firma no completada, reintentando en 30s", {
          cuentaId: cuenta.id,
          requestId,
          contractId,
          rawStatus
        });
        await rollbackIfOpen();
        setTimeout(() => reintentarCuentaCobroFirma(cuenta.id), 30000);
        return;
      } else {
        const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
          ? cuenta.datos_adjuntos
          : {};
        const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object"
          ? prevAdjuntos.firma
          : {};
        const prevDocumentoFirmado = prevFirma.documento_firmado && typeof prevFirma.documento_firmado === "object"
          ? {
            ...prevFirma.documento_firmado,
            onedrive_url: prevFirma.documento_firmado.onedrive_url || prevFirma.documento_firmado.url || ""
          }
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
        let documentosAdjuntosCorreo = [];
        let uploadedExtras = [];

        if (status === "signed" && !documentoFirmado?.url) {
          let artifacts = null;
          try {
            artifacts = await resolveClickSignArtifacts({
              event,
              requestId,
              contractId,
              publicId: String(cuenta.public_id || ""),
              signatureId: signatureId || prevFirma.signature_id || "",
              allowCatalogFallback: true
            });
          } catch (pdfErr) {
            const statusCode = Number(pdfErr?.status || pdfErr?.response?.status || 0);
            if (statusCode === 404) {
              console.warn("Webhook cuenta cobro: PDF firmado no disponible (404), reintentando en 30s", {
                cuentaId: cuenta.id,
                requestId,
                contractId
              });
              await rollbackIfOpen();
              setTimeout(() => reintentarCuentaCobroFirma(cuenta.id), 30000);
              return;
            }
            throw pdfErr;
          }

          const resolvedPdf = artifacts?.signedPdf || null;
          if (!resolvedPdf || !isPdfBuffer(resolvedPdf.buffer)) {
            console.warn("Webhook cuenta cobro: PDF firmado no disponible, reintentando en 30s", {
              cuentaId: cuenta.id,
              requestId,
              contractId
            });
            await rollbackIfOpen();
            setTimeout(() => reintentarCuentaCobroFirma(cuenta.id), 30000);
            return;
          }

          documentosAdjuntosCorreo = buildCuentaCobroEmailAttachments({
            cuenta,
            signedPdf: {
              buffer: resolvedPdf.buffer,
              fileName: resolvedPdf.fileName || ""
            },
            extraFiles: artifacts?.extraFiles || []
          });

          let uploadResult = null;
          try {
            uploadResult = await uploadSignedPdfToOneDrive(
              cuenta,
              resolvedPdf.buffer,
              resolvedPdf.fileName
            );
          } catch (uploadErr) {
            console.error("Error guardando firmado de cuenta de cobro en OneDrive:", uploadErr?.message || uploadErr);
            await rollbackIfOpen();
            setTimeout(() => reintentarCuentaCobroFirma(cuenta.id), 30000);
            return;
          }

          documentoFirmado = {
            ...uploadResult.archivo,
            onedrive_url: uploadResult.archivo?.url || "",
            carpeta: uploadResult.carpeta,
            origen: resolvedPdf.source || "clicksign",
            actualizado_en: nowIso
          };
          if (!documentoFirmado?.url) {
            await rollbackIfOpen();
            setTimeout(() => reintentarCuentaCobroFirma(cuenta.id), 30000);
            return;
          }

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
        if (documentoFirmado?.url) {
          firma.documento_firmado = documentoFirmado;
        }
        if (status === "signed") {
          firma.documento_firmado_error = documentoFirmado?.url ? null : prevFirma.documento_firmado_error || null;
        }

        const adjuntos = {
          ...prevAdjuntos,
          firma
        };
        if (documentoFirmado?.url) {
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
          estadoDestino = estadoAprobado;
        } else if (status === "rejected") {
          estadoDestino = "Rechazado";
        }

        if (estadoDestino) {
          await client.query(
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
          await client.query(
            `
            UPDATE cuenta_cobro
            SET datos_adjuntos = $1::jsonb,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            `,
            [JSON.stringify(adjuntos), cuenta.id]
          );
        }

        if (status === "signed" && documentoFirmado?.url) {
          const prevNotificacionProveedores =
            prevFirma.notificacion_proveedores && typeof prevFirma.notificacion_proveedores === "object"
              ? prevFirma.notificacion_proveedores
              : {};
          notificacionPendiente = {
            cuenta,
            documentoFirmado,
            attachments: documentosAdjuntosCorreo,
            prevNotification: prevNotificacionProveedores,
            nowIso
          };
        }

        await client.query("COMMIT");
        transactionOpen = false;
      }
    } catch (txErr) {
      try {
        await rollbackIfOpen();
      } catch (_) { }
      throw txErr;
    } finally {
      client.release();
    }

    if (sinCuenta && (requestId || contractId || signatureId)) {
      const handledAnexoIndividual = await handleClickSignAnexoIndividualWebhook({
        event,
        requestId,
        contractId,
        signatureId,
        status,
        rawStatus
      });
      if (handledAnexoIndividual) {
        return;
      }
      if (esCuentaCobro) {
        console.warn("Webhook Click&Sign de cuenta de cobro sin cuenta asociada:", {
          requestId,
          contractId,
          signatureId,
          rawStatus
        });
        return;
      }

      const handledContrato = await handleClickSignContratoWebhook({
        event,
        requestId,
        contractId,
        signatureId,
        status,
        rawStatus
      });
      if (handledContrato) {
        return;
      }
    }

    if (!cuenta) {
      console.warn("Webhook Click&Sign sin cuenta asociada:", { requestId, contractId, signatureId, rawStatus });
      return;
    }

    if (notificacionPendiente) {
      try {
        await notifyCuentaCobroFirmadaToProveedores(notificacionPendiente);
      } catch (notifyErr) {
        console.warn("No se pudo notificar cuenta de cobro firmada desde webhook:", notifyErr?.message || notifyErr);
      }
    }
  } catch (innerErr) {
    console.error("Error procesando webhook Click&Sign:", innerErr);
  }
}

module.exports = {
  processSignatureEvent,
  reintentarCuentaCobroFirma
};
