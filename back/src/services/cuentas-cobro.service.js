const { pool } = require("../db");
const { getGraphAccessToken } = require("../email");
const { FIRMA_CUENTA_TIMEOUT_HOURS, marcarCuentaCobroFirmaExpirada } = require("./firma-cuenta-timeout.service");
const PDFDocument = require("pdfkit");

const normalizeValue = (value) => String(value || "").toLowerCase().trim();

function getIndexHelpers() {
  return require("../index");
}

// Vista previa de cuenta de cobro (total + letras)
/**
 * Previsualiza el total a cobrar y su valor convertido a letras
 */
async function previewCuentaCobro(req, res) {
  const { buildTotalLetras } = getIndexHelpers();
  const { consultor_id, ids_reportes } = req.body;

  if (!consultor_id || !Array.isArray(ids_reportes) || ids_reportes.length === 0) {
    return res.status(400).json({ error: "Faltan datos para previsualizar" });
  }

  try {
    if (normalizeValue(req.user?.tipo_consultor) === "asociado") {
      return res.status(403).json({ error: "Acceso denegado" });
    }

    const meta = await pool.query(
      `
      WITH
        c_consultor AS (SELECT id, moneda_cobro FROM usuarios WHERE public_id = $1),
        c_reportes AS (SELECT id FROM reporte_horas WHERE public_id = ANY($2::uuid[]))
      SELECT
        COUNT(rh.id) AS count,
        COALESCE(SUM(rh.total_cobrar), 0) AS total,
        MIN(rh.created_at)::date AS min_fecha,
        MAX(rh.created_at)::date AS max_fecha,
        (SELECT id FROM c_consultor) AS _consultor_id,
        COALESCE((SELECT moneda_cobro FROM c_consultor), 'COP') AS moneda
      FROM reporte_horas rh
      WHERE rh.id IN (SELECT id FROM c_reportes)
        AND rh.estado_reporte = 'Aprobado'
        AND rh.id_cuenta_cobro IS NULL
        AND (
          rh.consultor_responsable_id = (SELECT id FROM c_consultor)
          OR rh.consultor_principal_id = (SELECT id FROM c_consultor)
          OR rh.consultor_responsable_id IN (
            SELECT u.id
            FROM usuarios u
            WHERE u.activo = true
              AND u.id_consultor_principal = (SELECT id FROM c_consultor)
          )
        )
      `,
      [consultor_id, ids_reportes]
    );

    const info = meta.rows[0];

    if (!info._consultor_id) {
      return res.status(404).json({ error: "Consultor no encontrado" });
    }

    if (String(req.user?.id) !== String(info._consultor_id)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }

    // 3. Validar que todos los registros sean válidos
    if (Number(info.count) !== ids_reportes.length) {
      return res.status(400).json({
        error: "Algunos registros no son válidos para cobro"
      });
    }

    // 4. Convertir a letras
    const total = Number(info.total || 0);
    const total_letras = buildTotalLetras(total, info.moneda);

    // 5. Retornar respuesta
    res.json({
      total: total,
      total_letras: total_letras,
      moneda: info.moneda,
      fecha_inicio: info.min_fecha,
      fecha_fin: info.max_fecha
    });

  } catch (error) {
    if (error?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(400).json({ error: "Consultor o reportes inválidos para previsualizar" });
    }
    console.error('[ERROR] Error en /cuentas-cobro/preview:', error);
    res.status(500).json({ error: "Error al calcular preview" });
  }
}

// Crear cuenta de cobro
/**
 * Genera una nueva cuenta de cobro y asocia los reportes de horas correspondientes
 */
async function crearCuentaCobro(req, res) {
  const { buildTotalLetras, getEstadoAsignacionValues, sendEmailSafe, getGraphContext } = getIndexHelpers();
  const { consultor_id, fecha_inicio, fecha_fin, total_letras, ciudad_cobro, total_numeros, ids_reportes } = req.body;
  if (!consultor_id || !fecha_inicio || !fecha_fin || !total_letras || !ciudad_cobro || !Array.isArray(ids_reportes) || ids_reportes.length === 0) {
    return res.status(400).json({ error: "Faltan datos para generar la cuenta" });
  }

  const client = await pool.connect();
  let txStarted = false;
  try {
    if (normalizeValue(req.user?.tipo_consultor) === "asociado") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    await client.query("BEGIN");
    txStarted = true;

    const meta = await client.query(
      `
      WITH
        c_consultor AS (SELECT id, moneda_cobro FROM usuarios WHERE public_id = $1),
        c_reportes AS (
          SELECT id, total_cobrar, created_at
          FROM reporte_horas
          WHERE public_id = ANY($2::uuid[])
            AND estado_reporte = 'Aprobado'
            AND id_cuenta_cobro IS NULL
            AND (
              consultor_responsable_id = (SELECT id FROM c_consultor)
              OR consultor_principal_id = (SELECT id FROM c_consultor)
              OR consultor_responsable_id IN (
                SELECT u.id
                FROM usuarios u
                WHERE u.activo = true
                  AND u.id_consultor_principal = (SELECT id FROM c_consultor)
              )
            )
        )
      SELECT
        COUNT(id) AS count,
        COALESCE(SUM(total_cobrar), 0) AS total,
        MIN(created_at)::date AS min_fecha,
        MAX(created_at)::date AS max_fecha,
        COALESCE((SELECT moneda_cobro FROM c_consultor), 'COP') AS moneda,
        ARRAY_AGG(id) AS used_ids,
        (SELECT id FROM c_consultor) AS _consultor_id
      FROM c_reportes
      `,
      [consultor_id, ids_reportes]
    );

    const info = meta.rows[0];
    if (!info._consultor_id) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Consultor no encontrado" });
    }
    if (String(req.user?.id) !== String(info._consultor_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (Number(info.count) !== ids_reportes.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Algunos registros no son válidos para cobro" });
    }

    if (total_numeros !== undefined && Number(total_numeros) !== Number(info.total || 0)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El total no coincide con los reportes aprobados" });
    }

    const totalLetrasFinal = buildTotalLetras(Number(info.total || 0), info.moneda);
    const descripcionFinal =
      (typeof req.body.descripcion === "string" && req.body.descripcion.trim()) ||
      `Cuenta de cobro ${fecha_inicio} - ${fecha_fin}`;

    const estadosAsignacion = await getEstadoAsignacionValues();

    const insert = await client.query(
      `
      WITH
        c_insert AS (
          INSERT INTO cuenta_cobro
            (descripcion, fecha_correspondiente, fecha_periodo_inicio, fecha_periodo_fin, total_cuenta_cobro, total_letras, ciudad_cobro, created_by)
          VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
          RETURNING *
        ),
        c_upd_rep AS (
          UPDATE reporte_horas
          SET id_cuenta_cobro = (SELECT id FROM c_insert)
          WHERE id = ANY($8::int[])
          RETURNING id_registro_asignacion
        ),
        c_upd_ra AS (
          UPDATE registro_asignaciones ra
          SET estado = $9::tipo_estado_asignacion
          FROM consultorias con
          LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
          WHERE ra.id_consultoria = con.id
            AND ra.id IN (SELECT id_registro_asignacion FROM c_upd_rep)
            AND NOT (
              COALESCE(con.id_tipo_asignacion, 0) IN (5, 6)
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%mesa%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%service desk%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%servicedesk%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%fabrica%'
              OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%fábrica%'
            )
        )
      SELECT * FROM c_insert
      `,
      [
        descripcionFinal,
        fecha_inicio,
        fecha_fin,
        info.total,
        totalLetrasFinal,
        ciudad_cobro,
        info._consultor_id,
        info.used_ids || [],
        estadosAsignacion.cerrado
      ]
    );

    await client.query("COMMIT");

    // Email a contabilidad
    const cuenta = insert.rows[0];
    const contabilidadEmail = process.env.EMAIL_TO_CONTABILIDAD || "";
    if (contabilidadEmail) {
      const userInfo = await pool.query(
        `SELECT nombre_usuario, email
         FROM usuarios
         WHERE id = $1`,
        [info._consultor_id]
      );
      const consultor = userInfo.rows[0];
      await sendEmailSafe({
        ...getGraphContext(req),
        to: contabilidadEmail,
        subject: `Nueva cuenta de cobro #${cuenta.public_id || cuenta.id}`,
        text:
          `Se generó una cuenta de cobro.\n` +
          `Consultor: ${consultor?.nombre_usuario || ""} (${consultor?.email || ""})\n` +
          `Periodo: ${cuenta.fecha_periodo_inicio} a ${cuenta.fecha_periodo_fin}\n` +
          `Total: ${cuenta.total_cuenta_cobro}\n` +
          `Descripción: ${cuenta.descripcion || ""}\n`
      });
    }

    res.json({
      ok: true,
      cuenta: {
        ...cuenta,
        id: cuenta.public_id || String(cuenta.id || "")
      }
    });
  } catch (err) {
    if (txStarted) {
      await client.query("ROLLBACK");
    }
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(400).json({ error: "Consultor o reportes inválidos para crear la cuenta" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al generar cuenta de cobro" });
  } finally {
    client.release();
  }
}

// Historial de cuentas de cobro por usuario
/**
 * Consulta el historial de cuentas de cobro generadas por un consultor específico
 */
async function getHistorialCuentas(req, res) {
  const { userId } = req.params;
  const { fecha_inicio, fecha_fin } = req.query;
  try {
    const role = normalizeValue(req.user?.rol);
    const params = [userId];
    let whereFecha = "";
    if (fecha_inicio && fecha_fin) {
      params.push(fecha_inicio, fecha_fin);
      whereFecha = "AND cc.fecha_correspondiente BETWEEN $2 AND $3";
    }
    const result = await pool.query(
      `
      WITH c_consultor AS (SELECT id FROM usuarios WHERE public_id = $1)
      SELECT
        cc.public_id AS id,
        COALESCE(NULLIF(cc.descripcion, ''), 'Cuenta de cobro') AS descripcion,
        cc.fecha_correspondiente,
        cc.fecha_periodo_inicio AS fecha_inicio_periodo,
        cc.fecha_periodo_fin AS fecha_fin_periodo,
        cc.total_cuenta_cobro AS total_numeros,
        cc.total_letras,
        cc.estado,
        cc.datos_adjuntos,
        cc.created_at,
        (SELECT id FROM c_consultor) AS _consultor_id
      FROM cuenta_cobro cc
      WHERE cc.created_by = (SELECT id FROM c_consultor)
        ${whereFecha}
      ORDER BY cc.id DESC
      `,
      params
    );
    const checkRows = result.rows;
    if (checkRows.length > 0 && !["administrador", "coordinador"].includes(role) && String(req.user?.id) !== String(checkRows[0]._consultor_id)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    res.json(checkRows.map(({ _consultor_id, ...row }) => row));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.json([]);
    console.error(err);
    res.status(500).json({ error: "Error al obtener historial de cobros" });
  }
}

// Soportes cargados de cuentas de cobro (solo admin/coordinador)
/**
 * Lista usuarios que pueden aprobar reportes de horas
 */
async function getAprobadoresCuentas(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        u.public_id AS id,
        u.nombre_usuario AS nombre,
        r.titulo AS rol
      FROM usuarios u
      JOIN roles r ON r.id = u.rol_usuario_id
      WHERE u.activo = true
        AND r.titulo IN ('Administrador', 'Coordinador')
      ORDER BY r.titulo ASC, u.nombre_usuario ASC
    `);

    res.json(result.rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener aprobadores" });
  }
}

/**
 * Lista las cuentas de cobro que tienen archivos adjuntos cargados en el sistema
 */
async function getSoportesCuentas(req, res) {
  const { consultor_id, coordinador_id } = req.query || {};
  try {
    const result = await pool.query(
      `
      WITH c_aprobador AS (
        SELECT id FROM usuarios WHERE public_id = $2::uuid
      )
      SELECT
        cc.public_id AS id,
        cc.created_at,
        cc.fecha_periodo_inicio AS fecha_inicio_periodo,
        cc.fecha_periodo_fin AS fecha_fin_periodo,
        cc.descripcion,
        cc.total_cuenta_cobro AS total_numeros,
        u.public_id AS consultor_id,
        u.nombre_usuario AS consultor_nombre,
        u.email AS consultor_email,
        aprobadores.coordinador_nombre,
        cc.datos_adjuntos
      FROM cuenta_cobro cc
        JOIN usuarios u ON u.id = cc.created_by
        LEFT JOIN LATERAL (
          SELECT
            string_agg(DISTINCT aprobador.nombre_usuario, ', ' ORDER BY aprobador.nombre_usuario) AS coordinador_nombre
          FROM reporte_horas rh
          LEFT JOIN usuarios aprobador ON aprobador.id = COALESCE(rh.aprobado_por, rh.coordinador_id)
          WHERE rh.id_cuenta_cobro = cc.id
            AND rh.estado_reporte = 'Aprobado'
        ) aprobadores ON true
      WHERE cc.datos_adjuntos IS NOT NULL
        AND (
          cc.datos_adjuntos ? 'soportes'
          OR cc.datos_adjuntos #> '{firma,documento_firmado}' IS NOT NULL
        )
        AND ($1::uuid IS NULL OR u.public_id = $1::uuid)
        AND (
          $2::uuid IS NULL
          OR EXISTS (
            SELECT 1
            FROM reporte_horas rhf
            WHERE rhf.id_cuenta_cobro = cc.id
              AND rhf.estado_reporte = 'Aprobado'
              AND COALESCE(rhf.aprobado_por, rhf.coordinador_id) = (SELECT id FROM c_aprobador)
          )
        )
      ORDER BY cc.id DESC
      `,
      [consultor_id || null, coordinador_id || null]
    );
    res.json(result.rows || []);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.json([]);
    console.error(err);
    res.status(500).json({ error: "Error al obtener soportes de cuentas de cobro" });
  }
}

// Detalle de cuenta de cobro
/**
 * Retorna la lista detallada de reportes de horas asociados a una cuenta
 */
async function getDetalleCuenta(req, res) {
  const { cuentaId } = req.params;
  try {
    const role = normalizeValue(req.user?.rol);
    const meta = await pool.query("SELECT id, created_by FROM cuenta_cobro WHERE public_id = $1", [cuentaId]);
    if (!meta.rows.length) return res.status(404).json({ error: "Cuenta no encontrada" });
    const cuentaInfo = meta.rows[0];

    if (!["administrador", "coordinador"].includes(role)) {
      if (String(cuentaInfo.created_by) !== String(req.user?.id)) {
        return res.status(403).json({ error: "Acceso denegado" });
      }
    }
    const result = await pool.query(
      `
        SELECT
          rh.public_id AS id,
          c.titulo AS cliente,
          m.titulo AS modulo,
          ta.titulo AS tipo_asignacion,
          u.nombre_usuario AS consultor_responsable,
          rh.nro_caso_int_ext,
          rh.horas_reportadas,
          rh.cantidad_dias_reportados,
          rh.total_cobrar
        FROM reporte_horas rh
          LEFT JOIN clientes c ON rh.cliente_id = c.id
          LEFT JOIN modulo m ON rh.modulo_id = m.id
          LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
          LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
      WHERE rh.id_cuenta_cobro = $1
      ORDER BY rh.id DESC
      `,
      [cuentaInfo.id]
    );
    res.json(result.rows);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al obtener detalle de cuenta" });
  }
}

// Descargar PDF de cuenta de cobro
/**
 * Genera y descarga el archivo PDF con el formato de la cuenta de cobro
 */
async function getCuentaPdf(req, res) {
  const { assertCuentaCobroOwnerAccess, getCuentaCobroPdfContext, writeCuentaCobroPdf } = getIndexHelpers();
  const { id } = req.params;
  try {
    const meta = await pool.query("SELECT id, created_by FROM cuenta_cobro WHERE public_id = $1", [id]);
    if (!meta.rows.length) return res.status(404).json({ error: "Cuenta no encontrada" });
    const cuentaInternalId = meta.rows[0].id;
    await assertCuentaCobroOwnerAccess(meta.rows[0].created_by, req);
    const { cuenta, detalles } = await getCuentaCobroPdfContext(cuentaInternalId);
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });

    res.setHeader("Content-Type", "application/pdf");
    const publicIdForFile = cuenta.public_id || id;
    res.setHeader("Content-Disposition", `attachment; filename="CuentaCobro_${publicIdForFile}.pdf"`);

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);
    writeCuentaCobroPdf(doc, cuenta, detalles);
    doc.end();
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }
    if (err?.code === "ACCESS_DENIED") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al generar PDF" });
  }
}

// Subir adjuntos (cuenta firmada + seguridad social)
/**
 * Sube y asocia los documentos PDF de soporte de cobro hacia OneDrive
 */
async function uploadAdjuntosCuenta(req, res) {
  const {
    encodeGraphPath,
    ensureGraphFolder,
    graphGet,
    graphPutBinary,
    isPdfBuffer,
    parseGraphErrorStatus,
    parsePdfDataUrl,
    sanitizePathSegment,
    sanitizePdfFileName
  } = getIndexHelpers();
  const ONEDRIVE_ENABLED = String(process.env.ONEDRIVE_ENABLED || "true").toLowerCase() === "true";
  const ONEDRIVE_TARGET_USER = process.env.ONEDRIVE_TARGET_USER || "admin.apps@silverconsulting.com.co";
  const ONEDRIVE_ROOT_FOLDER = process.env.ONEDRIVE_ROOT_FOLDER || "AdjuntosCuentasCobro";
  const { id } = req.params;
  const {
    cuenta_pdf_nombre,
    cuenta_pdf_base64,
    seguridad_social_nombre,
    seguridad_social_base64
  } = req.body || {};

  if (!cuenta_pdf_base64 || !seguridad_social_base64) {
    return res.status(400).json({ error: "Debe adjuntar ambos archivos en PDF." });
  }

  if (!ONEDRIVE_ENABLED) {
    return res.status(503).json({ error: "Servicio de carga no disponible temporalmente." });
  }

  let graphStage = "init";
  try {
    const ownerResult = await pool.query(
      `
      SELECT
        cc.id,
        cc.public_id,
        cc.created_by,
        cc.fecha_correspondiente,
        cc.created_at,
        cc.datos_adjuntos,
        u.nombre_usuario
      FROM cuenta_cobro cc
      JOIN usuarios u ON u.id = cc.created_by
      WHERE cc.public_id = $1
      `,
      [id]
    );

    const cuenta = ownerResult.rows[0];
    if (!cuenta) return res.status(404).json({ error: "Cuenta de cobro no encontrada." });

    const role = normalizeValue(req.user?.rol);
    if (!["administrador", "coordinador"].includes(role) && String(cuenta.created_by) !== String(req.user?.id)) {
      return res.status(403).json({ error: "Acceso denegado" });
    }

    const cuentaPdfBuffer = parsePdfDataUrl(cuenta_pdf_base64);
    const seguridadPdfBuffer = parsePdfDataUrl(seguridad_social_base64);

    if (!isPdfBuffer(cuentaPdfBuffer) || !isPdfBuffer(seguridadPdfBuffer)) {
      return res.status(400).json({ error: "Los archivos adjuntos deben estar en formato PDF válido." });
    }

    const maxSize = 8 * 1024 * 1024;
    if (cuentaPdfBuffer.length > maxSize || seguridadPdfBuffer.length > maxSize) {
      return res.status(400).json({ error: "Cada archivo debe pesar máximo 8MB." });
    }

    let token = null;
    try {
      token = await getGraphAccessToken();
    } catch (tokenErr) {
      const delegated = String(req?.headers?.["x-graph-access-token"] || "").trim();
      if (!delegated) throw tokenErr;
      token = delegated;
    }
    const encodedUser = encodeURIComponent(ONEDRIVE_TARGET_USER);
    graphStage = "graph-drive-check";
    await graphGet(`/v1.0/users/${encodedUser}/drive`, token);

    const fechaBase = String(cuenta.fecha_correspondiente || cuenta.created_at || new Date().toISOString()).slice(0, 10);
    const consultorFolder = sanitizePathSegment(cuenta.nombre_usuario || `Consultor_${cuenta.created_by}`, `Consultor_${cuenta.created_by}`);
    const cuentaFolderToken = String(cuenta.public_id || cuenta.id).split("-")[0];
    const cuentaFolderName = `CuentaCobro_${cuentaFolderToken}_${fechaBase}`;

    let targetPath = sanitizePathSegment(ONEDRIVE_ROOT_FOLDER, "AdjuntosCuentasCobro");
    graphStage = "ensure-root-folder";
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, "", targetPath);
    graphStage = "ensure-consultor-folder";
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, consultorFolder);
    graphStage = "ensure-cuenta-folder";
    targetPath = await ensureGraphFolder(token, ONEDRIVE_TARGET_USER, targetPath, cuentaFolderName);

    const cuentaFileName = sanitizePdfFileName(
      cuenta_pdf_nombre || `CuentaCobroFirmada_${cuentaFolderToken}.pdf`,
      `CuentaCobroFirmada_${cuentaFolderToken}.pdf`
    );
    const seguridadFileName = sanitizePdfFileName(
      seguridad_social_nombre || `SeguridadSocial_${cuentaFolderToken}.pdf`,
      `SeguridadSocial_${cuentaFolderToken}.pdf`
    );

    const cuentaPath = `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(`${targetPath}/${cuentaFileName}`)}:/content`;
    const seguridadPath = `/v1.0/users/${encodedUser}/drive/root:/${encodeGraphPath(`${targetPath}/${seguridadFileName}`)}:/content`;

    graphStage = "upload-files";
    const [cuentaUpload, seguridadUpload] = await Promise.all([
      graphPutBinary(cuentaPath, token, cuentaPdfBuffer, "application/pdf"),
      graphPutBinary(seguridadPath, token, seguridadPdfBuffer, "application/pdf")
    ]);

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
      ? cuenta.datos_adjuntos
      : {};

    const adjuntos = {
      ...prevAdjuntos,
      soportes: {
        carpeta: targetPath,
        actualizado_en: new Date().toISOString(),
        cuenta_cobro_original: {
          id: cuentaUpload.id,
          nombre: cuentaUpload.name,
          url: cuentaUpload.webUrl
        },
        cuenta_cobro: {
          id: cuentaUpload.id,
          nombre: cuentaUpload.name,
          url: cuentaUpload.webUrl
        },
        seguridad_social: {
          id: seguridadUpload.id,
          nombre: seguridadUpload.name,
          url: seguridadUpload.webUrl
        }
      }
    };

    await pool.query(
      `
      UPDATE cuenta_cobro
      SET datos_adjuntos = $1::jsonb,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [JSON.stringify(adjuntos), cuenta.id]
    );

    res.json({
      ok: true,
      mensaje: "Soportes cargados exitosamente",
      soportes: adjuntos.soportes
    });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ ok: false, error: "Cuenta de cobro no encontrada." });
    }
    const status = parseGraphErrorStatus(err.message);
    console.error("Error cargando adjuntos de cuenta:", err.message, "stage:", graphStage);

    if (status === 401 || status === 403) {
      return res.status(502).json({
        ok: false,
        error: "Servicio de almacenamiento no autorizado. Contacte a soporte."
      });
    }

    if (status === 404) {
      return res.status(502).json({
        ok: false,
        error: "No se encontró el repositorio de archivos configurado. Contacte a soporte."
      });
    }

    res.status(500).json({
      ok: false,
      error: "Error al cargar el archivo. Por favor verifique su conexión o intente más tarde."
    });
  }
}

async function iniciarFirmaCuenta(req, res) {
  const {
    isClickSignConfigured,
    assertCuentaCobroOwnerAccess,
    getCuentaCobroPdfContext,
    generateCuentaCobroPdfBuffer,
    sanitizePdfFileName,
    getRequestPublicBaseUrl,
    jsonRequest,
    buildClickSignUrl,
    buildClickSignAuthHeaders,
    extractClickSignSignatureId,
    getClickSignLandingUrl,
    getCuentaCobroEstadoEnFirma,
    CLICKSIGN_USER,
    CLICKSIGN_SIGNATURE_CB_URL,
    CLICKSIGN_SIGNATORY_CB_URL,
    CLICKSIGN_SIGNATORY_EMAIL_CB_URL,
    CLICKSIGN_WEBHOOK_TOKEN
  } = getIndexHelpers();
  const CLICKSIGN_CONFIG_ID = Number(process.env.CLICKSIGN_CONFIG_ID || 0);
  const { id } = req.params;
  if (!isClickSignConfigured()) {
    return res.status(503).json({
      error: "Click&Sign no esta configurado. Falta CLICKSIGN_API_KEY, CLICKSIGN_USER o CLICKSIGN_CONFIG_ID."
    });
  }

  try {
    const meta = await pool.query("SELECT id, created_by FROM cuenta_cobro WHERE public_id = $1", [id]);
    if (!meta.rows.length) return res.status(404).json({ error: "Cuenta no encontrada" });
    const cuentaInternalId = meta.rows[0].id;
    await assertCuentaCobroOwnerAccess(meta.rows[0].created_by, req);

    const { cuenta, detalles } = await getCuentaCobroPdfContext(cuentaInternalId);
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });
    if (!cuenta.email) {
      return res.status(400).json({
        error: "El consultor no tiene correo para iniciar firma digital."
      });
    }

    const firmaExistente =
      cuenta.datos_adjuntos &&
        typeof cuenta.datos_adjuntos === "object" &&
        cuenta.datos_adjuntos.firma &&
        typeof cuenta.datos_adjuntos.firma === "object"
        ? cuenta.datos_adjuntos.firma
        : null;
    const forceRestart = String(req.body?.force || "").toLowerCase() === "true" || req.body?.force === true;
    const firmaEstado = String(firmaExistente?.estado || "").toLowerCase().trim();
    if (
      !forceRestart &&
      firmaExistente?.url_firma &&
      ["pending", "in_progress", "en_firma", "started", "sent"].includes(firmaEstado)
    ) {
      return res.json({
        ok: true,
        reused: true,
        cuenta_id: String(cuenta.public_id || cuenta.id || ""),
        request_id: firmaExistente.request_id || null,
        contract_id: firmaExistente.contract_id || null,
        url_firma: firmaExistente.url_firma
      });
    }

    const pdfBuffer = await generateCuentaCobroPdfBuffer(cuenta, detalles);
    const cuentaPublicId = String(cuenta.public_id || "");
    const requestId = `CC-${cuentaPublicId || cuenta.id}-${Date.now()}`;
    const contractId = `CC-${String(cuentaPublicId || cuenta.id || "").split("-")[0]}`;
    const fileName = sanitizePdfFileName(
      `CuentaCobro_${cuentaPublicId || cuenta.id}.pdf`,
      `CuentaCobro_${cuenta.id}.pdf`
    );
    const signatoryExternalId = String(cuenta.created_by || "");

    const signaturePayload = {
      request: "START_SIGNATURE",
      request_id: requestId,
      user: CLICKSIGN_USER,
      signature: {
        config_id: CLICKSIGN_CONFIG_ID,
        contract_id: contractId,
        level: [
          {
            level_order: 0,
            required_signatories_to_complete_level: 1,
            signatories: [
              {
                email: cuenta.email,
                name: cuenta.nombre_usuario || cuenta.email,
                external_id: signatoryExternalId
              }
            ]
          }
        ],
        file: [
          {
            filename: fileName,
            content: pdfBuffer.toString("base64"),
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
    const signatoryEmailCbUrl = CLICKSIGN_SIGNATORY_EMAIL_CB_URL || signatureCbUrl;
    if (signatureCbUrl) {
      signaturePayload.signature.signature_cb_url = signatureCbUrl;
    }
    if (signatoryCbUrl) {
      signaturePayload.signature.signatory_cb_url = signatoryCbUrl;
    }
    if (signatoryEmailCbUrl) {
      signaturePayload.signature.signatory_email_cb_url = signatoryEmailCbUrl;
    }
    const clickSignRes = await jsonRequest({
      method: "POST",
      url: buildClickSignUrl("start_signature"),
      headers: buildClickSignAuthHeaders(),
      body: signaturePayload
    });
    const signatureId = extractClickSignSignatureId(clickSignRes.data);
    const urlFirma = getClickSignLandingUrl(clickSignRes.data);
    if (!urlFirma) {
      return res.status(502).json({
        error: "Click&Sign no devolvio URL de firma.",
        detalle: clickSignRes.data
      });
    }

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
      ? cuenta.datos_adjuntos
      : {};
    const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object"
      ? prevAdjuntos.firma
      : {};
    const ahoraIso = new Date().toISOString();
    const firma = {
      ...prevFirma,
      proveedor: "clicksign",
      estado: "pending",
      request_id: requestId,
      contract_id: contractId,
      signature_id: signatureId || null,
      url_firma: urlFirma,
      iniciado_en: ahoraIso,
      actualizado_en: ahoraIso,
      ultimo_evento: "START_SIGNATURE"
    };
    const adjuntos = {
      ...prevAdjuntos,
      firma
    };
    const estadoEnFirma = await getCuentaCobroEstadoEnFirma();
    await pool.query(
      `
      UPDATE cuenta_cobro
      SET datos_adjuntos = $1::jsonb,
          estado = $2::tipo_estado_reporte,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      `,
      [JSON.stringify(adjuntos), estadoEnFirma, cuentaInternalId]
    );

    return res.json({
      ok: true,
      cuenta_id: cuentaPublicId || String(cuenta.id || ""),
      request_id: requestId,
      contract_id: contractId,
      signature_id: signatureId || null,
      url_firma: urlFirma
    });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }
    if (err?.code === "ACCESS_DENIED") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (Number(err?.status || 0) > 0) {
      return res.status(502).json({
        error: "Error al iniciar firma en Click&Sign",
        detalle: err.response || err.message
      });
    }
    console.error("Error iniciando firma digital:", err);
    return res.status(500).json({ error: "Error al iniciar proceso de firma" });
  }
}

async function reconciliarFirmaCuenta(req, res) {
  const {
    isClickSignConfigured,
    assertCuentaCobroOwnerAccess,
    fetchClickSignSignatureSnapshot,
    extractClickSignSignatureId,
    normalizeClickSignStatus,
    resolveClickSignArtifacts,
    isPdfBuffer,
    buildCuentaCobroEmailAttachments,
    uploadSignedPdfToOneDrive,
    uploadClickSignExtraFilesToOneDrive,
    sameResourceUrl,
    notifyCuentaCobroFirmadaToProveedores,
    getGraphContext,
    getCuentaCobroEstadoAprobado,
    getCuentaCobroEstadoEnFirma
  } = getIndexHelpers();
  const { id } = req.params;
  if (!isClickSignConfigured()) {
    return res.status(503).json({
      error: "Click&Sign no esta configurado. Falta CLICKSIGN_API_KEY, CLICKSIGN_USER o CLICKSIGN_CONFIG_ID."
    });
  }

  try {
    const cuentaResult = await pool.query(
      `
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
      LEFT JOIN usuarios u ON u.id = cc.created_by
      WHERE cc.public_id = $1
      LIMIT 1
      `,
      [id]
    );

    const cuenta = cuentaResult.rows[0] || null;
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });
    await assertCuentaCobroOwnerAccess(cuenta.created_by, req);

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
      ? cuenta.datos_adjuntos
      : {};
    const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object"
      ? prevAdjuntos.firma
      : {};
    const prevDocumentoFirmado = prevFirma.documento_firmado && typeof prevFirma.documento_firmado === "object"
      ? prevFirma.documento_firmado
      : null;
    const estadoEnFirma = await getCuentaCobroEstadoEnFirma();

    const requestId = String(req.body?.request_id || prevFirma.request_id || "").trim();
    const contractId = String(req.body?.contract_id || prevFirma.contract_id || `CC-${cuenta.public_id || cuenta.id}`).trim();
    const signatureId = String(req.body?.signature_id || prevFirma.signature_id || "").trim();

    if (!requestId && !contractId) {
      return res.status(400).json({
        error: "La cuenta no tiene request_id/contract_id para reconciliar."
      });
    }

    const snapshot = await fetchClickSignSignatureSnapshot({ requestId, contractId, signatureId });
    const event = snapshot.event && typeof snapshot.event === "object" ? snapshot.event : {};
    const signatureIdFromSnapshot = String(extractClickSignSignatureId(event) || "").trim();
    const effectiveSignatureId = signatureId || signatureIdFromSnapshot;
    const rawStatusFromRequest = String(req.body?.status || "").trim();
    const rawStatus = rawStatusFromRequest || snapshot.rawStatus || prevFirma.ultimo_evento || prevFirma.estado || "pending";
    let status = normalizeClickSignStatus(rawStatus);
    const nowIso = new Date().toISOString();

    const eventosPrev = Array.isArray(prevFirma.eventos) ? prevFirma.eventos.slice(-19) : [];
    const eventoResumen = {
      recibido_en: nowIso,
      status: rawStatus || status || "",
      request_id: requestId || null,
      contract_id: contractId || null,
      origen: "reconciliacion"
    };

    let documentoFirmado = prevDocumentoFirmado;
    let documentoFirmadoError = "";
    let documentosAdjuntosCorreo = [];

    let uploadedExtras = [];
    let catalogSource = null;
    if (status === "signed" || !status || status === "pending") {
      const artifacts = await resolveClickSignArtifacts({
        event,
        requestId,
        contractId,
        publicId: String(cuenta.public_id || ""),
        signatureId: effectiveSignatureId
      });
      catalogSource = artifacts?.catalogSource || null;
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
          status = "signed";
          try {
            const extrasResult = await uploadClickSignExtraFilesToOneDrive(
              cuenta,
              artifacts?.extraFiles || [],
              uploadResult.carpeta || ""
            );
            uploadedExtras = extrasResult.uploaded || [];
          } catch (extraErr) {
            console.warn("No se pudieron subir adjuntos extra de Click&Sign (reconciliacion):", extraErr?.message || extraErr);
          }
        } catch (uploadErr) {
          documentoFirmadoError = `Error almacenando firmado en OneDrive: ${uploadErr.message || "desconocido"}`;
        }
      } else if (status === "signed") {
        documentoFirmadoError = "No se encontró PDF firmado en API de Click&Sign.";
      }
    }

    if (status === "pending" && !documentoFirmado?.url) {
      const timeoutResult = await marcarCuentaCobroFirmaExpirada({
        cuentaId: cuenta.id,
        estadoEnFirma,
        timeoutHours: FIRMA_CUENTA_TIMEOUT_HOURS,
        origen: "reconciliacion"
      });
      if (timeoutResult.updated) {
        const firmaExpirada = timeoutResult.firma || {};
        return res.json({
          ok: true,
          cuenta_id: String(cuenta.public_id || cuenta.id || ""),
          request_id: firmaExpirada.request_id || null,
          contract_id: firmaExpirada.contract_id || null,
          estado_firma: firmaExpirada.estado || null,
          estado_cuenta: timeoutResult.estadoDestino || "Rechazado",
          documento_firmado_url: null,
          documento_firmado_error: firmaExpirada.documento_firmado_error || null,
          origen_snapshot: "timeout",
          origen_catalogo: catalogSource,
          extras_subidos: []
        });
      }
    }

    const ultimoEvento = status === "pending" && String(prevFirma.ultimo_evento || "").trim().toUpperCase() === "START_SIGNATURE"
      ? prevFirma.ultimo_evento
      : rawStatus || status || "reconciliacion";
    const firma = {
      ...prevFirma,
      estado: status || prevFirma.estado || "pending",
      request_id: requestId || prevFirma.request_id || null,
      contract_id: contractId || prevFirma.contract_id || null,
      signature_id: effectiveSignatureId || prevFirma.signature_id || null,
      actualizado_en: nowIso,
      ultimo_evento: ultimoEvento,
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
        nowIso,
        graphContext: getGraphContext(req)
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
        : estadoEnFirma;
    } else if (status === "rejected") {
      estadoDestino = "Rechazado";
    } else if (status === "pending") {
      estadoDestino = estadoEnFirma;
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

    return res.json({
      ok: true,
      cuenta_id: String(cuenta.public_id || cuenta.id || ""),
      request_id: requestId || null,
      contract_id: contractId || null,
      estado_firma: firma.estado || null,
      estado_cuenta: estadoDestino || null,
      documento_firmado_url: firma?.documento_firmado?.url || null,
      documento_firmado_error: firma?.documento_firmado_error || null,
      origen_snapshot: snapshot.source || null,
      origen_catalogo: catalogSource,
      extras_subidos: uploadedExtras.map((item) => ({ kind: item.kind, nombre: item.nombre, url: item.url }))
    });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }
    if (err?.code === "ACCESS_DENIED") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (Number(err?.status || 0) > 0) {
      return res.status(502).json({
        error: "Error consultando firma en Click&Sign",
        detalle: err.response || err.message
      });
    }
    console.error("Error reconciliando firma digital:", err);
    return res.status(500).json({ error: "Error reconciliando firma digital" });
  }
}

async function adjuntarFirmaCuenta(req, res) {
  const {
    assertCuentaCobroOwnerAccess,
    parsePdfDataUrl,
    isPdfBuffer,
    sanitizePdfFileName,
    uploadSignedPdfToOneDrive,
    buildCuentaCobroEmailAttachments,
    notifyCuentaCobroFirmadaToProveedores,
    getGraphContext,
    getCuentaCobroEstadoAprobado,
    parseGraphErrorStatus
  } = getIndexHelpers();
  const ONEDRIVE_ENABLED = String(process.env.ONEDRIVE_ENABLED || "true").toLowerCase() === "true";
  const { id } = req.params;
  const cuentaPdfBase64 = req.body?.cuenta_pdf_base64 || req.body?.archivo_base64 || req.body?.signed_pdf_base64 || "";
  const cuentaPdfNombre = req.body?.cuenta_pdf_nombre || req.body?.archivo_nombre || req.body?.signed_pdf_nombre || "";

  if (!ONEDRIVE_ENABLED) {
    return res.status(503).json({ error: "Servicio de carga no disponible temporalmente." });
  }
  if (!cuentaPdfBase64) {
    return res.status(400).json({ error: "Debe enviar el PDF firmado en base64." });
  }

  try {
    const cuentaResult = await pool.query(
      `
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
      LEFT JOIN usuarios u ON u.id = cc.created_by
      WHERE cc.public_id = $1
      LIMIT 1
      `,
      [id]
    );

    const cuenta = cuentaResult.rows[0] || null;
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });
    await assertCuentaCobroOwnerAccess(cuenta.created_by, req);
    const cuentaInternalId = cuenta.id;

    const pdfBuffer = parsePdfDataUrl(cuentaPdfBase64);
    if (!isPdfBuffer(pdfBuffer)) {
      return res.status(400).json({ error: "El archivo firmado debe ser un PDF válido." });
    }

    const defaultName = sanitizePdfFileName(
      `CuentaCobroFirmada_${String(cuenta.public_id || cuenta.id || "cuenta")}.pdf`,
      "CuentaCobroFirmada.pdf"
    );
    let uploadResult = null;
    const uploadName = sanitizePdfFileName(cuentaPdfNombre || defaultName, defaultName);
    try {
      uploadResult = await uploadSignedPdfToOneDrive(
        cuenta,
        pdfBuffer,
        uploadName
      );
    } catch (uploadErr) {
      const delegatedGraphToken = String(req?.headers?.["x-graph-access-token"] || "").trim();
      if (!delegatedGraphToken) throw uploadErr;
      uploadResult = await uploadSignedPdfToOneDrive(
        cuenta,
        pdfBuffer,
        uploadName,
        { accessToken: delegatedGraphToken }
      );
    }

    const prevAdjuntos = cuenta.datos_adjuntos && typeof cuenta.datos_adjuntos === "object"
      ? cuenta.datos_adjuntos
      : {};
    const prevFirma = prevAdjuntos.firma && typeof prevAdjuntos.firma === "object"
      ? prevAdjuntos.firma
      : {};
    const prevSoportes = prevAdjuntos.soportes && typeof prevAdjuntos.soportes === "object"
      ? prevAdjuntos.soportes
      : {};
    const nowIso = new Date().toISOString();

    const documentoFirmado = {
      ...uploadResult.archivo,
      carpeta: uploadResult.carpeta,
      origen: "manual_upload",
      actualizado_en: nowIso
    };
    const documentosAdjuntosCorreo = buildCuentaCobroEmailAttachments({
      cuenta,
      signedPdf: {
        buffer: pdfBuffer,
        fileName: uploadName
      }
    });
    const firma = {
      ...prevFirma,
      estado: "signed",
      actualizado_en: nowIso,
      ultimo_evento: "MANUAL_UPLOAD",
      documento_firmado: documentoFirmado,
      documento_firmado_error: null
    };
    if (documentoFirmado?.url) {
      const prevNotificacionProveedores =
        prevFirma.notificacion_proveedores && typeof prevFirma.notificacion_proveedores === "object"
          ? prevFirma.notificacion_proveedores
          : {};
      const notificacion = await notifyCuentaCobroFirmadaToProveedores({
        cuenta,
        documentoFirmado,
        attachments: documentosAdjuntosCorreo,
        prevNotification: prevNotificacionProveedores,
        nowIso,
        graphContext: getGraphContext(req)
      });
      if (notificacion) {
        firma.notificacion_proveedores = notificacion;
      }
    }
    const adjuntos = {
      ...prevAdjuntos,
      firma,
      soportes: {
        ...prevSoportes,
        carpeta: uploadResult.carpeta || prevSoportes.carpeta || "",
        actualizado_en: nowIso,
        cuenta_cobro_firmada: {
          id: documentoFirmado.id || null,
          nombre: documentoFirmado.nombre || defaultName,
          url: documentoFirmado.url || ""
        }
      }
    };

    const estadoAprobado = await getCuentaCobroEstadoAprobado();
    await pool.query(
      `
      UPDATE cuenta_cobro
      SET datos_adjuntos = $1::jsonb,
          estado = $2::tipo_estado_reporte,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      `,
      [JSON.stringify(adjuntos), estadoAprobado, cuenta.id]
    );

    return res.json({
      ok: true,
      cuenta_id: String(cuenta.public_id || cuenta.id || ""),
      estado_cuenta: estadoAprobado,
      documento_firmado_url: documentoFirmado.url || null
    });
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }
    if (err?.code === "ACCESS_DENIED") {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    if (err?.code === "GRAPH_TOKEN_ERROR") {
      return res.status(502).json({
        error: "No se pudo autenticar OneDrive (Microsoft Graph). Verifica credenciales y permisos."
      });
    }
    const status = parseGraphErrorStatus(err?.message || "");
    if (status === 401 || status === 403) {
      return res.status(502).json({
        error: "Servicio de almacenamiento no autorizado. Verifica permisos de Graph/OneDrive."
      });
    }
    if (status === 404) {
      return res.status(502).json({
        error: "No se encontró el repositorio de OneDrive configurado."
      });
    }
    console.error("Error adjuntando PDF firmado manual:", err);
    return res.status(500).json({
      error: "Error adjuntando PDF firmado",
      codigo: err?.code || null,
      detalle: err?.message || null
    });
  }
}

module.exports = { previewCuentaCobro, crearCuentaCobro, getHistorialCuentas, getAprobadoresCuentas, getSoportesCuentas, getDetalleCuenta, getCuentaPdf, uploadAdjuntosCuenta, iniciarFirmaCuenta, reconciliarFirmaCuenta, adjuntarFirmaCuenta };
