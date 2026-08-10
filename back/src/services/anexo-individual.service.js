const crypto = require("crypto");
const { pool } = require("../db");

function getIndexHelpers() {
  return require("../index");
}

const DESTINOS_TH_FALLBACK =
  process.env.CONTRATACIONES_DESTINO_TH ||
  "catalina.loaiza@silverconsulting.com.co,ana.garcia@silverconsulting.com.co";

function parseEmailList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueEmailList(input) {
  return Array.from(new Set((Array.isArray(input) ? input : parseEmailList(input)).filter(Boolean)));
}

async function getDestinosTalentoHumano(client = pool) {
  try {
    const result = await client.query(
      `
      SELECT u.email
      FROM usuarios u
      JOIN roles r ON r.id = u.rol_usuario_id
      WHERE u.activo = true
        AND NULLIF(BTRIM(u.email), '') IS NOT NULL
        AND LOWER(r.titulo) = LOWER('Talento Humano')
      ORDER BY LOWER(BTRIM(u.email)) ASC
      `
    );
    const roleRecipients = uniqueEmailList(result.rows.map((row) => row.email));
    return roleRecipients.length ? roleRecipients : uniqueEmailList(DESTINOS_TH_FALLBACK);
  } catch (err) {
    console.error("No se pudieron resolver destinatarios TH:", err?.message || err);
    return uniqueEmailList(DESTINOS_TH_FALLBACK);
  }
}

async function notifyThIfZeroAnexos(client = pool, { usuario_id, numero_documento, exclude_item_id, nombre_persona, graphContext = null } = {}) {
  const usuarioId = usuario_id || null;
  const numeroDocumento = String(numero_documento || "").trim() || null;
  if (!usuarioId && !numeroDocumento) return { sent: false, remainingCount: null, skipped: true };

  const countRes = await client.query(
    `
    SELECT COUNT(*)::int AS total
    FROM anexo_tecnico_items
    WHERE estado = 'activo'
      AND id != $1
      AND (
        ($2::text IS NOT NULL AND numero_documento = $2)
        OR ($3::int IS NOT NULL AND usuario_id = $3)
      )
    `,
    [exclude_item_id, numeroDocumento, usuarioId]
  );
  const total = countRes.rows[0]?.total || 0;
  if (total !== 0) return { sent: false, remainingCount: total };

  const { sendEmailSafe, buildEmailLayout } = getIndexHelpers();
  const destinosTh = await getDestinosTalentoHumano(client);
  const nombre = String(nombre_persona || "").trim() || "Persona sin nombre";
  const documento = String(numeroDocumento || "").trim();
  const blocks = [
    { label: "Persona", value: nombre },
    { label: "Documento", value: documento || "N/A" }
  ];
  const intro = "La persona se quedo sin anexos activos. Revisar proceso de retiro total segun politica interna.";
  const result = await sendEmailSafe({
    ...(graphContext || {}),
    to: destinosTh.join(","),
    subject: "Administrativos: Persona sin anexos activos",
    text: `${intro}\n\n${blocks.map((item) => `${item.label}: ${item.value}`).join("\n")}`,
    html: buildEmailLayout({
      title: "Persona sin anexos activos",
      intro,
      blocks
    })
  });

  return { sent: Boolean(result?.ok), remainingCount: total };
}

/**
 * Busca usuarios corporativos disponibles para anexo individual
 */
async function searchAnexoIndividualUsuarios(req, res) {
  try {
    const q = String(req.query?.q || "").trim();
    const like = `%${q}%`;
    const result = await pool.query(
      `
      SELECT *
      FROM (
        SELECT
          u.id AS internal_id,
          u.public_id AS id,
          u.public_id,
          u.nombre_usuario AS nombre,
          u.nombre_usuario AS nombre_usuario,
          u.email,
          COALESCE(p.numero_documento, u.cedula) AS cedula,
          u.tipo_consultor::text AS tipo_consultor,
          COALESCE(u.activo, false) AS activo,
          EXISTS (
            SELECT 1
            FROM anexo_tecnico_items ati
            WHERE ati.estado = 'activo'
              AND (
                ati.usuario_id = u.id
                OR (
                  COALESCE(p.numero_documento, u.cedula) IS NOT NULL
                  AND ati.usuario_id IS NULL
                  AND ati.numero_documento = COALESCE(p.numero_documento, u.cedula)
                )
              )
          ) AS tiene_items_activos,
          EXISTS (
            SELECT 1
            FROM tokens_firma_anexo_individual t
            WHERE (
                t.usuario_id = u.id
                OR (p.id IS NOT NULL AND t.persona_id = p.id)
              )
              AND t.estado = 'enviado'
          ) AS envio_pendiente,
          'usuario' AS source
        FROM usuarios u
        LEFT JOIN personas p ON u.persona_id = p.id
        WHERE LOWER(COALESCE(u.email, '')) LIKE '%@silverconsulting.com.co'
          AND (
            $1 = ''
            OR u.nombre_usuario ILIKE $2
            OR u.email ILIKE $2
            OR COALESCE(p.numero_documento, u.cedula, '') ILIKE $2
          )
        UNION ALL
        SELECT
          p.id AS internal_id,
          p.public_id AS id,
          p.public_id,
          TRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) AS nombre,
          TRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) AS nombre_usuario,
          p.correo_electronico AS email,
          p.numero_documento AS cedula,
          NULL::text AS tipo_consultor,
          (p.estado = 'activo') AS activo,
          EXISTS (
            SELECT 1
            FROM anexo_tecnico_items ati
            WHERE ati.estado = 'activo'
              AND p.numero_documento IS NOT NULL
              AND ati.numero_documento = p.numero_documento
          ) AS tiene_items_activos,
          EXISTS (
            SELECT 1
            FROM tokens_firma_anexo_individual t
            WHERE t.persona_id = p.id
              AND t.estado = 'enviado'
          ) AS envio_pendiente,
          'persona' AS source
        FROM personas p
        WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.persona_id = p.id)
          AND (
            $1 = ''
            OR TRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) ILIKE $2
            OR COALESCE(p.correo_electronico, '') ILIKE $2
            OR COALESCE(p.numero_documento, '') ILIKE $2
          )
      ) AS combined
      ORDER BY
        CASE WHEN combined.activo THEN 0 ELSE 1 END,
        CASE WHEN combined.nombre ILIKE $2 THEN 0 ELSE 1 END,
        combined.nombre ASC
      LIMIT 20
      `,
      [q, like]
    );
    res.json(result.rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error buscando usuarios para anexo tecnico" });
  }
}

/**
 * Obtiene el tablero de anexos individuales de un usuario
 */
async function getAnexoIndividualUsuarioItems(req, res) {
  const {
    getUsuarioAnexoIndividualById,
    buildAnexoIndividualDashboardPayload
  } = getIndexHelpers();

  try {
    const userRow = await getUsuarioAnexoIndividualById(req.params.usuarioId);
    if (!userRow) return res.status(404).json({ error: "Usuario no encontrado" });
    const payload = await buildAnexoIndividualDashboardPayload(userRow, {
      includeFinalizados: String(req.query?.incluir_finalizados || "").toLowerCase() === "true"
    });
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo items del anexo tecnico" });
  }
}

/**
 * Obtiene un item especifico de anexo individual
 */
async function getAnexoIndividualItem(req, res) {
  const {
    getAnexoIndividualItemByInput,
    toAnexoApiRow
  } = getIndexHelpers();

  try {
    const item = await getAnexoIndividualItemByInput(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Item no encontrado" });
    res.json(toAnexoApiRow(item));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo item del anexo tecnico" });
  }
}

/**
 * Crea un nuevo item de anexo individual
 */
async function createAnexoIndividualItem(req, res) {
  const {
    getUsuarioAnexoIndividualById,
    buildAnexoIndividualItemPayload,
    getAnexoTecnicoItemByInternalId,
    toAnexoApiRow
  } = getIndexHelpers();

  try {
    const userRow = await getUsuarioAnexoIndividualById(req.body?.usuario_id);
    if (!userRow) return res.status(404).json({ error: "Usuario no encontrado" });

    let solicitanteInternalId = null;
    let rolSolicitante = null;
    if (req.body?.solicitante_id) {
      const solRes = await pool.query(
        `SELECT u.id, r.titulo AS rol FROM usuarios u JOIN roles r ON r.id = u.rol_usuario_id WHERE u.public_id::text = $1::text LIMIT 1`,
        [req.body.solicitante_id]
      );
      if (solRes.rows[0]) {
        solicitanteInternalId = solRes.rows[0].id;
        rolSolicitante = solRes.rows[0].rol || null;
      }
    }

    const payload = await buildAnexoIndividualItemPayload({
      input: req.body || {},
      userRow,
      existingRow: null,
      actorUserId: req.user?.id || null
    });

    const insert = await pool.query(
      `
      INSERT INTO anexo_tecnico_items (
        solicitud_contratacion_id,
        preregistro_id,
        usuario_id,
        nombre_persona,
        numero_documento,
        correo_personal,
        tipo_asignacion,
        cliente_id,
        cliente_nombre,
        modulo_id,
        modulo_nombre,
        moneda,
        valor_tarifa,
        fecha_inicio,
        fecha_fin,
        fecha_fin_calculada,
        origen,
        estado,
        estado_firma,
        creado_por,
        updated_by,
        solicitante_id,
        rol_solicitante
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23
      )
      RETURNING id
      `,
      [
        payload.solicitud_contratacion_id,
        payload.preregistro_id,
        payload.usuario_id,
        payload.nombre_persona,
        payload.numero_documento,
        payload.correo_personal,
        payload.tipo_asignacion,
        payload.cliente_id,
        payload.cliente_nombre,
        payload.modulo_id,
        payload.modulo_nombre,
        payload.moneda,
        payload.valor_tarifa,
        payload.fecha_inicio,
        payload.fecha_fin,
        payload.fecha_fin_calculada,
        payload.origen,
        payload.estado,
        "pendiente",
        payload.creado_por,
        null,
        solicitanteInternalId,
        rolSolicitante
      ]
    );

    const row = await getAnexoTecnicoItemByInternalId(insert.rows[0]?.id);
    res.status(201).json({ item: toAnexoApiRow(row) });
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || "Datos invalidos para item de anexo tecnico" });
    }
    if (err?.code === "23514") {
      console.error("CHECK anexo_tecnico_items:", err.message);
      return res.status(400).json({
        error:
          "Los datos no cumplen las reglas del anexo en base de datos. Si acabas de habilitar anexo individual, aplica la migracion 2026-03-25-anexo-individual-check-usuario.sql."
      });
    }
    console.error(err);
    res.status(500).json({ error: "Error creando item de anexo tecnico" });
  }
}

/**
 * Actualiza un item activo de anexo individual
 */
async function updateAnexoIndividualItem(req, res) {
  const {
    getAnexoIndividualItemByInput,
    getUsuarioAnexoIndividualById,
    buildAnexoIndividualItemPayload,
    getAnexoTecnicoItemByInternalId,
    toAnexoApiRow
  } = getIndexHelpers();

  try {
    const existingRow = await getAnexoIndividualItemByInput(req.params.itemId);
    if (!existingRow) return res.status(404).json({ error: "Item no encontrado" });
    if (existingRow.estado !== "activo") {
      return res.status(409).json({ error: "Solo se pueden editar items activos" });
    }

    const userRow = await getUsuarioAnexoIndividualById(
      req.body?.usuario_id || existingRow.usuario_public_id || existingRow.usuario_id
    );
    if (!userRow) return res.status(404).json({ error: "Usuario no encontrado" });

    const payload = await buildAnexoIndividualItemPayload({
      input: req.body || {},
      userRow,
      existingRow,
      actorUserId: req.user?.id || null
    });

    await pool.query(
      `
      UPDATE anexo_tecnico_items
      SET
        usuario_id = $1,
        nombre_persona = $2,
        numero_documento = $3,
        correo_personal = $4,
        tipo_asignacion = $5,
        cliente_id = $6,
        cliente_nombre = $7,
        modulo_id = $8,
        modulo_nombre = $9,
        moneda = $10,
        valor_tarifa = $11,
        fecha_inicio = $12,
        fecha_fin = $13,
        fecha_fin_calculada = $14,
        estado_firma = $15,
        updated_by = $16,
        updated_at = NOW()
      WHERE id = $17
      `,
      [
        payload.usuario_id,
        payload.nombre_persona,
        payload.numero_documento,
        payload.correo_personal,
        payload.tipo_asignacion,
        payload.cliente_id,
        payload.cliente_nombre,
        payload.modulo_id,
        payload.modulo_nombre,
        payload.moneda,
        payload.valor_tarifa,
        payload.fecha_inicio,
        payload.fecha_fin,
        payload.fecha_fin_calculada,
        payload.estado_firma,
        req.user?.id || null,
        existingRow.id
      ]
    );

    const refreshed = await getAnexoTecnicoItemByInternalId(existingRow.id);
    res.json({ item: toAnexoApiRow(refreshed) });
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || "Datos invalidos para actualizar el item" });
    }
    console.error(err);
    res.status(500).json({ error: "Error actualizando item de anexo tecnico" });
  }
}

/**
 * Marca un item de anexo individual como finalizado
 */
async function finalizarAnexoIndividualItem(req, res) {
  const {
    getAnexoIndividualItemByInput,
    getAnexoTecnicoItemByInternalId,
    toAnexoApiRow,
    getGraphContext
  } = getIndexHelpers();

  try {
    const existingRow = await getAnexoIndividualItemByInput(req.params.itemId);
    if (!existingRow) return res.status(404).json({ error: "Item no encontrado" });

    await pool.query(
      `
      UPDATE anexo_tecnico_items
      SET estado = 'finalizado',
          updated_by = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [existingRow.id, req.user?.id || null]
    );
    await notifyThIfZeroAnexos(pool, {
      usuario_id: existingRow.usuario_id || null,
      numero_documento: existingRow.numero_documento || null,
      exclude_item_id: existingRow.id,
      nombre_persona: existingRow.nombre_persona || null,
      graphContext: typeof getGraphContext === "function" ? getGraphContext(req) : null
    });

    const refreshed = await getAnexoTecnicoItemByInternalId(existingRow.id);
    res.json({ item: toAnexoApiRow(refreshed) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error finalizando item de anexo tecnico" });
  }
}

/**
 * Genera la vista previa PDF del anexo individual
 */
async function previewAnexoIndividualPdf(req, res) {
  const {
    collectAnexoIndividualSignatureContext,
    generateAnexoIndividualPdfFromItems,
    sanitizeDownloadFileName,
    isAnexoIndividualInfraError,
    buildAnexoIndividualInfraErrorPayload,
    isDocxTemplateFailureMessage,
    isDocxInfraFailureMessage
  } = getIndexHelpers();

  const correoFirmante = String(req.body?.correo_firmante || "").trim();
  const usuarioInput = req.body?.usuario_id || null;
  if (!usuarioInput) return res.status(400).json({ error: "usuario_id es obligatorio" });
  if (correoFirmante && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoFirmante)) {
    return res.status(400).json({ error: "correo_firmante invalido" });
  }

  try {
    const { userRow, items, correoFirmante: correoFinal, facturaEnColombia } = await collectAnexoIndividualSignatureContext({
      userInput: usuarioInput,
      correoFirmante,
      requestedItemIds: req.body?.item_ids || []
    });
    const generated = await generateAnexoIndividualPdfFromItems({
      userRow,
      items,
      correoFirmante: correoFinal,
      facturaEnColombia
    });
    const fileName = sanitizeDownloadFileName(
      generated.fileName || "AnexoTecnico.pdf",
      "AnexoTecnico.pdf"
    ).replace(/"/g, "");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(generated.pdfBuffer);
  } catch (err) {
    console.error("Error descargando preview de anexo individual:", err);
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({
        error: err.message || "No fue posible generar la vista previa",
        missing: Array.isArray(err?.missing) ? err.missing : undefined
      });
    }
    if (isAnexoIndividualInfraError(err)) {
      return res.status(503).json(buildAnexoIndividualInfraErrorPayload());
    }
    const errMessage = String(err?.message || "");
    if (isDocxTemplateFailureMessage(errMessage)) {
      return res.status(422).json({
        error: "No fue posible generar la vista previa porque la plantilla del anexo tecnico tiene marcadores invalidos."
      });
    }
    if (isDocxInfraFailureMessage(errMessage)) {
      return res.status(503).json({
        error: "No fue posible generar el PDF del anexo tecnico.",
        detalle: errMessage || "Sin detalle tecnico"
      });
    }
    return res.status(500).json({ error: "Error generando la vista previa del anexo tecnico" });
  }
}

/**
 * Inicia el proceso de firma del anexo individual
 */
async function iniciarFirmaAnexoIndividual(req, res) {
  const {
    isAnexoTecnicoClickSignConfigured,
    getUsuarioAnexoIndividualById,
    mapAnexoIndividualTokenRow,
    collectAnexoIndividualSignatureContext,
    generateAnexoIndividualPdfFromItems,
    getRequestPublicBaseUrl,
    pickStringByPaths,
    extractClickSignSignatureId,
    getClickSignLandingUrl,
    jsonRequest,
    buildClickSignUrl,
    buildClickSignAuthHeaders,
    isAnexoIndividualInfraError,
    buildAnexoIndividualInfraErrorPayload,
    isDocxTemplateFailureMessage,
    isDocxInfraFailureMessage,
    getAnexoTecnicoClickSignConfigId,
    CLICKSIGN_USER,
    CLICKSIGN_SIGNATURE_CB_URL,
    CLICKSIGN_SIGNATORY_CB_URL,
    CLICKSIGN_SIGNATORY_EMAIL_CB_URL,
    CLICKSIGN_WEBHOOK_TOKEN
  } = getIndexHelpers();

  if (!isAnexoTecnicoClickSignConfigured()) {
    return res.status(503).json({
      error: "Click&Sign no esta configurado para Anexo Tecnico. Configura CLICKSIGN_ANEXO_TECNICO_CONFIG_ID con una plantilla simple sin adjuntos."
    });
  }

  const correoFirmante = String(req.body?.correo_firmante || "").trim();
  const usuarioInput = req.body?.usuario_id || null;
  if (!usuarioInput) return res.status(400).json({ error: "usuario_id es obligatorio" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoFirmante)) {
    return res.status(400).json({ error: "correo_firmante invalido" });
  }

  try {
    const userRow = await getUsuarioAnexoIndividualById(usuarioInput);
    if (!userRow) return res.status(404).json({ error: "Usuario no encontrado" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const activeToken = await client.query(
        `
        SELECT *
        FROM tokens_firma_anexo_individual
        WHERE (
            ($1::int IS NOT NULL AND usuario_id = $1)
            OR ($2::int IS NOT NULL AND persona_id = $2)
          )
          AND estado = 'enviado'
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        `,
        [Number(userRow.id) > 0 ? Number(userRow.id) : null, userRow.persona_id || null]
      );
      if (activeToken.rowCount > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Ya existe un envio pendiente para esta persona",
          token_activo: mapAnexoIndividualTokenRow(activeToken.rows[0])
        });
      }

      const {
        items,
        correoFirmante: correoFinal,
        facturaEnColombia,
        clicksignDocumentType
      } = await collectAnexoIndividualSignatureContext({
        userInput: usuarioInput,
        correoFirmante,
        requestedItemIds: req.body?.item_ids || [],
        client,
        lockRows: true
      });

      const generated = await generateAnexoIndividualPdfFromItems({
        userRow,
        items,
        correoFirmante: correoFinal,
        facturaEnColombia
      });
      const token = crypto.randomBytes(32).toString("hex");
      const requestId = `ANX-${token.slice(0, 12)}-${Date.now()}`;
      const contractId = `anexo_individual_${String(userRow.public_id || userRow.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}_${Date.now()}`;
      const signatoryExternalId = String(userRow.public_id || userRow.id || Date.now());
      const documentType = clicksignDocumentType || "AnexoTecnico";
      const clicksignConfigId = getAnexoTecnicoClickSignConfigId();
      const clicksignPayload = {
        request: "START_SIGNATURE",
        request_id: requestId,
        user: CLICKSIGN_USER,
        signature: {
          config_id: clicksignConfigId,
          contract_id: contractId,
          document_type: documentType,
          title: `Anexo Tecnico - ${userRow.nombre_usuario || "Persona"}`,
          level: [
            {
              level_order: 0,
              required_signatories_to_complete_level: 1,
              signatories: [
                {
                  email: correoFinal,
                  name: userRow.nombre_usuario || correoFinal,
                  external_id: signatoryExternalId
                }
              ]
            }
          ],
          file: [
            {
              filename: generated.fileName,
              document_type: documentType,
              content: generated.pdfBuffer.toString("base64"),
              sign_on_landing: "Y",
              signature_position: [
                {
                  signatory_external_id: signatoryExternalId,
                  page: "last",
                  x: 140,
                  y: 240,
                  width: 84,
                  height: 36,
                  rotation: 0
                }
              ]
            }
          ]
        }
      };

      const fallbackWebhookBase = getRequestPublicBaseUrl(req);
      const fallbackSignatureCbUrl = fallbackWebhookBase
        ? `${fallbackWebhookBase}/webhooks/clicksign/signature${CLICKSIGN_WEBHOOK_TOKEN
          ? `?token=${encodeURIComponent(CLICKSIGN_WEBHOOK_TOKEN)}`
          : ""
        }`
        : "";
      const signatureCbUrl = CLICKSIGN_SIGNATURE_CB_URL || fallbackSignatureCbUrl;
      const signatoryCbUrl = CLICKSIGN_SIGNATORY_CB_URL || signatureCbUrl;
      const signatoryEmailCbUrl = CLICKSIGN_SIGNATORY_EMAIL_CB_URL || signatoryCbUrl;
      if (signatureCbUrl) clicksignPayload.signature.signature_cb_url = signatureCbUrl;
      if (signatoryCbUrl) clicksignPayload.signature.signatory_cb_url = signatoryCbUrl;
      if (signatoryEmailCbUrl) clicksignPayload.signature.signatory_email_cb_url = signatoryEmailCbUrl;

      let clicksignRes = null;
      try {
        clicksignRes = await jsonRequest({
          method: "POST",
          url: buildClickSignUrl("start_signature"),
          headers: buildClickSignAuthHeaders(),
          body: clicksignPayload
        });
      } catch (clickErr) {
        await client.query("ROLLBACK");
        return res.status(502).json({
          error: "Error al iniciar firma en Click&Sign",
          detalle: clickErr?.response || clickErr?.message || "Error desconocido",
          http_status: Number(clickErr?.status || 0) || null
        });
      }

      const clicksignBody = clicksignRes?.data && typeof clicksignRes.data === "object" ? clicksignRes.data : {};
      const urlFirma = getClickSignLandingUrl(clicksignBody);
      const responseRequestId = pickStringByPaths(clicksignBody, [
        "request_id",
        "data.request_id",
        "signature.request_id",
        "request.id",
        "data.request.id",
        "result.request_id",
        "result.request.id"
      ]);
      const resolvedRequestId = responseRequestId || requestId;
      const signatureId = extractClickSignSignatureId(clicksignBody);
      if (!urlFirma) {
        await client.query("ROLLBACK");
        return res.status(502).json({
          error: "Click&Sign no devolvio URL de firma",
          detalle: clicksignBody
        });
      }

      const insertToken = await client.query(
        `
        INSERT INTO tokens_firma_anexo_individual (
          token,
          usuario_id,
          persona_id,
          anexo_item_ids,
          correo_firmante,
          nombre_persona,
          estado,
          request_id,
          contract_id,
          signature_id,
          url_firma,
          generado_por
        )
        VALUES (
          $1, $2, $3, $4::int[], $5, $6, 'enviado', $7, $8, $9, $10, $11
        )
        RETURNING *
        `,
        [
          token,
          Number(userRow.id) > 0 ? Number(userRow.id) : null,
          userRow.persona_id || null,
          items.map((item) => Number(item.id)).filter(Number.isInteger),
          correoFinal,
          userRow.nombre_usuario || "",
          resolvedRequestId || null,
          contractId,
          signatureId || null,
          urlFirma || null,
          req.user?.id || null
        ]
      );

      await client.query(
        `
        UPDATE anexo_tecnico_items
        SET estado_firma = 'enviado',
            updated_at = NOW()
        WHERE id = ANY($1::int[])
        `,
        [items.map((item) => Number(item.id)).filter(Number.isInteger)]
      );

      await client.query("COMMIT");
      return res.status(200).json({
        ok: true,
        token: mapAnexoIndividualTokenRow(insertToken.rows[0]),
        url_firma: urlFirma || null
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch { }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error iniciando firma de anexo individual:", err);
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({
        error: err.message || "No fue posible iniciar la firma",
        missing: Array.isArray(err?.missing) ? err.missing : undefined
      });
    }
    if (isAnexoIndividualInfraError(err)) {
      return res.status(503).json(buildAnexoIndividualInfraErrorPayload());
    }
    const errMessage = String(err?.message || "");
    if (isDocxTemplateFailureMessage(errMessage)) {
      return res.status(422).json({
        error: "No fue posible generar el PDF porque la plantilla del anexo tecnico tiene marcadores invalidos."
      });
    }
    if (isDocxInfraFailureMessage(errMessage)) {
      return res.status(503).json({
        error: "No fue posible generar el PDF del anexo tecnico.",
        detalle: errMessage || "Sin detalle tecnico"
      });
    }
    res.status(500).json({ error: "Error iniciando proceso de firma del anexo tecnico" });
  }
}

/**
 * Cancela un envio pendiente de firma de anexo individual
 */
async function cancelarFirmaAnexoIndividual(req, res) {
  const { isGuid } = getIndexHelpers();

  const rawId = String(req.params.tokenId || "").trim();
  if (!rawId) return res.status(400).json({ error: "Token invalido" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let lookup = null;
    if (isGuid(rawId)) {
      lookup = await client.query(
        `
        SELECT *
        FROM tokens_firma_anexo_individual
        WHERE public_id = $1
          AND estado = 'enviado'
        LIMIT 1
        FOR UPDATE
        `,
        [rawId]
      );
    } else {
      lookup = await client.query(
        `
        SELECT *
        FROM tokens_firma_anexo_individual
        WHERE token = $1
          AND estado = 'enviado'
        LIMIT 1
        FOR UPDATE
        `,
        [rawId]
      );
    }

    if (!lookup || lookup.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No existe un envio pendiente con ese identificador" });
    }

    const tokenRow = lookup.rows[0];
    await client.query(
      `
      UPDATE tokens_firma_anexo_individual
      SET estado = 'cancelado',
          cancelado_at = NOW(),
          cancelado_por = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [tokenRow.id, req.user?.id || null]
    );
    await client.query(
      `
      UPDATE anexo_tecnico_items
      SET estado_firma = 'pendiente',
          updated_at = NOW()
      WHERE id = ANY($1::int[])
      `,
      [tokenRow.anexo_item_ids || []]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch { }
    console.error(err);
    res.status(500).json({ error: "Error cancelando el envio de firma" });
  } finally {
    client.release();
  }
}

module.exports = {
  searchAnexoIndividualUsuarios,
  getAnexoIndividualUsuarioItems,
  getAnexoIndividualItem,
  createAnexoIndividualItem,
  updateAnexoIndividualItem,
  finalizarAnexoIndividualItem,
  notifyThIfZeroAnexos,
  previewAnexoIndividualPdf,
  iniciarFirmaAnexoIndividual,
  cancelarFirmaAnexoIndividual
};
