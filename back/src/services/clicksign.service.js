const { pool } = require("../db");
const { extractPublicIdFromContract } = require("../lib/clicksign");
const {
  resolverFirmaCuentaVerificada
} = require("./clicksign-firma-verificada.service");
const {
  cerrarCuentaCobroConFirmaResuelta,
  cuentasFirmaAutocierreHabilitado,
  buildCuentaFirmaDiagnosticoFromResolution
} = require("./cuenta-cobro-cierre.service");
const {
  persistirDiagnosticoFirmaCuenta
} = require("./cuentas-cobro.service");

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

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getFirmaWebhookMismatch(prevFirma = {}, { requestId = "", contractId = "", signatureId = "" } = {}) {
  const firma = asPlainObject(prevFirma);
  const eventIds = {
    request_id: String(requestId || "").trim(),
    contract_id: String(contractId || "").trim(),
    signature_id: String(signatureId || "").trim()
  };
  const activeIds = {
    request_id: String(firma.request_id || "").trim(),
    contract_id: String(firma.contract_id || "").trim(),
    signature_id: String(firma.signature_id || "").trim()
  };
  const mismatch = Object.keys(eventIds).some((key) =>
    eventIds[key] && activeIds[key] && eventIds[key] !== activeIds[key]
  );
  return { mismatch, eventIds, activeIds };
}

async function buscarCuentaCobroFirmaParaWebhook(client, { publicIdFromEvent = "", requestId = "", contractId = "" } = {}) {
  const CUENTA_COBRO_SELECT = `
        SELECT
          cc.id,
          cc.public_id,
          cc.created_by,
          cc.fecha_correspondiente,
          cc.created_at,
          cc.estado,
          cc.datos_adjuntos,
          u.nombre_usuario,
          u.email
        FROM cuenta_cobro cc
        LEFT JOIN usuarios u ON u.id = cc.created_by`;

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
  return cuentaResult?.rows?.[0] || null;
}

async function registrarHintWebhookCuentaCobro({
  event,
  publicIdFromEvent = "",
  requestId = "",
  contractId = "",
  signatureId = "",
  rawStatus = "",
  status = "",
  deps = {}
} = {}) {
  const { getCuentaCobroEstadoEnFirma } = deps.getCuentaCobroEstadoEnFirma
    ? deps
    : getIndexHelpers();
  const estadoEnFirma = await getCuentaCobroEstadoEnFirma();
  const dbPool = deps.pool || pool;
  const logger = deps.logger || console;
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const cuenta = await buscarCuentaCobroFirmaParaWebhook(client, { publicIdFromEvent, requestId, contractId });
    if (!cuenta) {
      await client.query("ROLLBACK");
      return { cuenta: null, estadoEnFirma };
    }

    const prevAdjuntos = asPlainObject(cuenta.datos_adjuntos);
    const prevFirma = asPlainObject(prevAdjuntos.firma);
    const identity = getFirmaWebhookMismatch(prevFirma, { requestId, contractId, signatureId });
    if (identity.mismatch) {
      logger.warn("Webhook Click&Sign de cuenta de cobro no coincide con la firma activa:", {
        evento: identity.eventIds,
        firma_activa: identity.activeIds
      });
      await client.query("ROLLBACK");
      return { cuenta: null, estadoEnFirma, mismatch: true };
    }
    const eventosPrev = Array.isArray(prevFirma.eventos) ? prevFirma.eventos.slice(-19) : [];
    const nowIso = new Date().toISOString();
    const estadoPrevioSeguro = String(prevFirma.estado || "").trim().toLowerCase() === "signed"
      ? "pending"
      : prevFirma.estado || "pending";
    const firma = {
      ...prevFirma,
      estado: estadoPrevioSeguro,
      request_id: prevFirma.request_id || requestId || null,
      contract_id: prevFirma.contract_id || contractId || null,
      signature_id: prevFirma.signature_id || signatureId || null,
      actualizado_en: nowIso,
      ultimo_evento: rawStatus || status || "webhook",
      diagnostico: {
        ultimo_check_en: nowIso,
        request_id: prevFirma.request_id || requestId || null,
        contract_id: prevFirma.contract_id || contractId || null,
        signature_id: prevFirma.signature_id || signatureId || null,
        rawStatus: rawStatus || null,
        normalizedStatus: status || null,
        catalogSource: null,
        reason: "webhook_hint",
        origen: "webhook"
      },
      eventos: [
        ...eventosPrev,
        {
          recibido_en: nowIso,
          status: rawStatus || status || "",
          request_id: requestId || null,
          contract_id: contractId || null,
          origen: "webhook"
        }
      ]
    };

    const adjuntos = {
      ...prevAdjuntos,
      firma
    };
    const updateResult = await client.query(
      `
      UPDATE cuenta_cobro
      SET datos_adjuntos = $1::jsonb,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
        AND estado = $3::tipo_estado_reporte
        AND COALESCE(datos_adjuntos->'firma'->'documento_firmado'->>'url', '') = ''
      `,
      [JSON.stringify(adjuntos), cuenta.id, estadoEnFirma]
    );
    if (updateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { cuenta: null, estadoEnFirma };
    }
    await client.query("COMMIT");

    return {
      cuenta: {
        ...cuenta,
        datos_adjuntos: adjuntos
      },
      estadoEnFirma
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) { }
    throw err;
  } finally {
    client.release();
  }
}

async function procesarWebhookCuentaCobroEstricto({
  event,
  publicIdFromEvent = "",
  requestId = "",
  contractId = "",
  signatureId = "",
  rawStatus = "",
  status = ""
} = {}) {
  const { cuenta, estadoEnFirma } = await registrarHintWebhookCuentaCobro({
    event,
    publicIdFromEvent,
    requestId,
    contractId,
    signatureId,
    rawStatus,
    status
  });

  if (!cuenta) {
    console.warn("Webhook Click&Sign de cuenta de cobro sin cuenta asociada:", {
      requestId,
      contractId,
      signatureId,
      rawStatus
    });
    return;
  }

  const resolution = await resolverFirmaCuentaVerificada({
    cuenta,
    prevAdjuntos: asPlainObject(cuenta.datos_adjuntos)
  });
  const activeFirma = asPlainObject(asPlainObject(cuenta.datos_adjuntos).firma);
  const expectedRequestId = resolution.requestId ||
    asPlainObject(resolution.diagnostico).request_id ||
    activeFirma.request_id ||
    "";

  if (resolution.signed) {
    const cierre = await cerrarCuentaCobroConFirmaResuelta({
      cuenta,
      resolution,
      origen: "webhook"
    });
    if (cierre.updated !== true) {
      const diagnostico = buildCuentaFirmaDiagnosticoFromResolution(resolution);
      await persistirDiagnosticoFirmaCuenta({
        cuentaId: cuenta.id,
        estadoEnFirma,
        status: asPlainObject(asPlainObject(cuenta.datos_adjuntos).firma).estado || "pending",
        resolution: {
          ...resolution,
          signed: false,
          reason: "firmado_verificado_pendiente_cierre",
          diagnostico: {
            ...diagnostico,
            reason: "firmado_verificado_pendiente_cierre"
          }
        },
        origen: "webhook",
        expectedRequestId
      });
    }
    return;
  }

  await persistirDiagnosticoFirmaCuenta({
    cuentaId: cuenta.id,
    estadoEnFirma,
    status: resolution.normalizedStatus === "rejected" ? "rejected" : asPlainObject(asPlainObject(cuenta.datos_adjuntos).firma).estado || "pending",
    resolution,
    origen: "webhook",
    expectedRequestId
  });

  if (cuentasFirmaAutocierreHabilitado() && resolution.normalizedStatus !== "rejected") {
    console.warn("Webhook cuenta cobro: firma no verificada, reintentando en 30s", {
      cuentaId: cuenta.id,
      requestId,
      contractId,
      rawStatus
    });
    setTimeout(() => reintentarCuentaCobroFirma(cuenta.id), 30000);
    return;
  }

  console.warn("Webhook cuenta cobro: firma no verificada; autocierre deshabilitado, sin reintento 30s", {
    cuentaId: cuenta.id,
    requestId,
    contractId,
    rawStatus,
    reason: resolution.reason || "pending"
  });
}

/**
 * Reintenta procesar una cuenta de cobro firmada
 */
async function reintentarCuentaCobroFirma(cuentaId) {
  {
    const { getCuentaCobroEstadoEnFirma } = getIndexHelpers();
    try {
      const cuentaResultStrict = await pool.query(
        `SELECT cc.id, cc.public_id, cc.created_by, cc.fecha_correspondiente, cc.created_at, cc.datos_adjuntos,
                u.nombre_usuario, u.email
         FROM cuenta_cobro cc LEFT JOIN usuarios u ON u.id = cc.created_by
         WHERE cc.id = $1 LIMIT 1`,
        [cuentaId]
      );
      const cuentaStrict = cuentaResultStrict.rows[0] || null;
      if (!cuentaStrict) return;

      const prevAdjuntosStrict = asPlainObject(cuentaStrict.datos_adjuntos);
      const prevFirmaStrict = asPlainObject(prevAdjuntosStrict.firma);
      if (prevFirmaStrict.documento_firmado?.url) return;

      const estadoEnFirma = await getCuentaCobroEstadoEnFirma();
      const resolution = await resolverFirmaCuentaVerificada({
        cuenta: cuentaStrict,
        prevAdjuntos: prevAdjuntosStrict
      });
      const expectedRequestId = resolution.requestId ||
        asPlainObject(resolution.diagnostico).request_id ||
        prevFirmaStrict.request_id ||
        "";
      if (resolution.signed) {
        const cierre = await cerrarCuentaCobroConFirmaResuelta({
          cuenta: cuentaStrict,
          resolution,
          origen: "webhook-reintento"
        });
        if (cierre.updated !== true) {
          const diagnostico = buildCuentaFirmaDiagnosticoFromResolution(resolution);
          await persistirDiagnosticoFirmaCuenta({
            cuentaId: cuentaStrict.id,
            estadoEnFirma,
            status: prevFirmaStrict.estado || "pending",
            resolution: {
              ...resolution,
              signed: false,
              reason: "firmado_verificado_pendiente_cierre",
              diagnostico: {
                ...diagnostico,
                reason: "firmado_verificado_pendiente_cierre"
              }
            },
            origen: "webhook-reintento",
            expectedRequestId
          });
        }
        return;
      }

      await persistirDiagnosticoFirmaCuenta({
        cuentaId: cuentaStrict.id,
        estadoEnFirma,
        status: resolution.normalizedStatus === "rejected" ? "rejected" : prevFirmaStrict.estado || "pending",
        resolution,
        origen: "webhook-reintento",
        expectedRequestId
      });
    } catch (err) {
      console.error("Error en reintento diferido de cuenta cobro firmada:", err?.message || err);
    }
    return;
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
    handleClickSignAnexoIndividualWebhook,
    handleClickSignContratoWebhook
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

    if (esCuentaCobro) {
      const publicIdFromEvent = extractPublicIdFromContract(contractId) || pickStringByPaths(event, [
        "public_id",
        "cuenta_public_id",
        "data.public_id"
      ]);
      await procesarWebhookCuentaCobroEstricto({
        event,
        publicIdFromEvent,
        requestId,
        contractId,
        signatureId,
        rawStatus,
        status
      });
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
      } else {
        await rollbackIfOpen();
        await procesarWebhookCuentaCobroEstricto({
          event,
          publicIdFromEvent,
          requestId,
          contractId,
          signatureId,
          rawStatus,
          status
        });
        return;
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

  } catch (innerErr) {
    console.error("Error procesando webhook Click&Sign:", innerErr);
  }
}

module.exports = {
  processSignatureEvent,
  reintentarCuentaCobroFirma,
  __private: {
    getFirmaWebhookMismatch,
    registrarHintWebhookCuentaCobro
  }
};
