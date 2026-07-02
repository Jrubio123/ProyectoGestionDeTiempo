const crypto = require("crypto");
const { pool } = require("../db");

function getIndexHelpers() {
  return require("../index");
}

async function syncPersonaCorreoElectronico({ personaContext, correoPersonal, numeroDocumento, preregistroId }) {
  const correo = String(correoPersonal || "").trim().toLowerCase();
  if (!correo) return 0;

  const personaId = Number(personaContext?.persona_id) || null;
  const documento = String(personaContext?.numeroDocumento || numeroDocumento || "").trim() || null;
  const preId = Number(personaContext?.preregistro_id || preregistroId) || null;

  if (!personaId && !documento && !preId) return 0;

  const result = await pool.query(
    `
    WITH target AS (
      SELECT id
      FROM personas
      WHERE
        ($2::int IS NOT NULL AND id = $2)
        OR ($3::text IS NOT NULL AND NULLIF(BTRIM(numero_documento), '') = $3)
        OR ($4::int IS NOT NULL AND preregistro_id = $4)
      ORDER BY
        CASE WHEN $2::int IS NOT NULL AND id = $2 THEN 0 ELSE 1 END,
        CASE WHEN $4::int IS NOT NULL AND preregistro_id = $4 THEN 0 ELSE 1 END,
        updated_at DESC NULLS LAST,
        id DESC
      LIMIT 1
    )
    UPDATE personas p
       SET correo_electronico = $1,
           updated_at = NOW()
      FROM target
     WHERE p.id = target.id
       AND COALESCE(LOWER(NULLIF(BTRIM(p.correo_electronico), '')), '') <> LOWER($1)
    RETURNING p.id
    `,
    [correo, personaId, documento, preId]
  );

  return result.rowCount;
}

async function resolveDatosLaboralesPersonaContext(input, helpers) {
  const {
    resolveContratoPersonaContext,
    resolveProcesoForPersona,
    resolveInternalIdFromPublicIdOrId,
    ID_TABLES,
    toNullableTrimmedString
  } = helpers;

  const solicitudInput = input?.solicitud_id || null;
  const preregistroInput = input?.preregistro_id || null;
  const numeroDocumento = toNullableTrimmedString(input?.numero_documento);
  const correoPersonal = toNullableTrimmedString(input?.correo_personal);

  let solicitudId = null;
  let preregistroId = null;
  if (solicitudInput) {
    solicitudId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.solicitudesContratacion, solicitudInput);
    if (!solicitudId) {
      const err = new Error("Solicitud no encontrada");
      err.status = 404;
      throw err;
    }
  }
  if (preregistroInput) {
    preregistroId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.preregistroPersonas, preregistroInput);
    if (!preregistroId) {
      const err = new Error("Preregistro no encontrado");
      err.status = 404;
      throw err;
    }
  }

  if (!solicitudId && !preregistroId && !numeroDocumento && !correoPersonal) {
    const err = new Error("Debes indicar numero_documento, correo_personal, solicitud_id o preregistro_id");
    err.status = 400;
    throw err;
  }

  // Sin IDs de proceso: resolvemos el proceso vigente por documento/correo para heredar
  // datos del flujo del coordinador (ej. grupo_distribucion => tipo de contratación sugerido).
  if (!solicitudId && !preregistroId && (numeroDocumento || correoPersonal)) {
    const proceso = await resolveProcesoForPersona(pool, {
      numero_documento: numeroDocumento,
      correo_personal: correoPersonal
    });
    solicitudId = proceso.solicitud_id;
    preregistroId = proceso.preregistro_id;
  }

  return resolveContratoPersonaContext({
    solicitud_id: solicitudId,
    preregistro_id: preregistroId,
    numero_documento: numeroDocumento,
    correo_personal: correoPersonal
  });
}

// Sugerencia del tipo de contratación (vinculado | todosilver) para prellenar el formulario
// de firma. Prioriza lo que envió el coordinador (grupo_distribucion) y cae a la naturaleza
// del contrato ya registrada en personas. Es solo una sugerencia: TH puede editarla.
function resolveTipoContratacionSugerido(personaContext) {
  const grupo = String(personaContext?.grupoDistribucion || "").toLowerCase();
  if (grupo.includes("vinculado")) return "vinculado";
  if (grupo.includes("todos silver") || grupo.includes("todosilver")) return "todosilver";
  if (String(personaContext?.tipoContrato || "").trim() === "Vinculado") return "vinculado";
  return null;
}

function buildDatosLaboralesResponse(personaContext, getCamposLaboralesFaltantes) {
  const tipoContratacionSugerido = resolveTipoContratacionSugerido(personaContext);

  if (!personaContext?.persona_id) {
    return {
      persona_id: null,
      tipo_contrato: null,
      tipo_contratacion_sugerido: tipoContratacionSugerido,
      requiere_laboral: false,
      datos: {},
      faltantes: []
    };
  }

  const requiereLaboral = personaContext?.tipoContrato === "Vinculado";
  return {
    persona_id: personaContext.persona_id,
    tipo_contrato: personaContext.tipoContrato || null,
    tipo_contratacion_sugerido: tipoContratacionSugerido,
    requiere_laboral: requiereLaboral,
    datos: {
      tipo_trabajador: personaContext.tipoTrabajador || null,
      cargo: personaContext.cargo || personaContext.perfilSolicitud || null,
      salario_mensual: personaContext.salarioMensual ?? personaContext.tarifaMes ?? null,
      salario_moneda: personaContext.salarioMoneda || "COP",
      periodo_pago: personaContext.periodoPago || "Quincenal",
      periodo_prueba: personaContext.periodoPrueba || "2 meses",
      jefe_inmediato: personaContext.jefeInmediato || personaContext.supervisorNombre || null,
      caja_compensacion: personaContext.cajaCompensacion || null,
      condiciones_especiales: personaContext.condicionesEspeciales || null,
      duracion_contrato: personaContext.duracionContrato || "Indefinida",
      fecha_inicio_labores: personaContext.fechaInicioLabores || null,
      lugar_celebracion: personaContext.lugarCelebracion || null,
      eps: personaContext.eps || null,
      afp: personaContext.afp || null,
      arl: personaContext.arl || null
    },
    faltantes: requiereLaboral ? getCamposLaboralesFaltantes(personaContext) : []
  };
}

function normalizeTipoContratacionFirma(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["vinculado", "todosilver"].includes(normalized) ? normalized : null;
}

/**
 * Obtiene la lista de tokens generados para procesos de firma de contratos
 */
async function listFirmaContratos(req, res) {
  const {
    CLAVES_REQUERIDAS_FIRMA,
    esProcesoVinculado,
    getClavesRequeridasFirma
  } = getIndexHelpers();

  try {
    const result = await pool.query(`
      SELECT
        t.public_id        AS id,
        t.nombre_persona,
        t.correo_personal,
        t.estado,
        t.checks_completados,
        t.docs_firma,
        t.expires_at,
        t.created_at,
        sc.public_id       AS solicitud_public_id,
        sc.perfil          AS solicitud_perfil,
        pp.public_id       AS preregistro_public_id,
        u.nombre_usuario   AS generado_por_nombre
      FROM tokens_firma_contrato t
        LEFT JOIN solicitudes_contratacion sc ON sc.id = t.solicitud_id
        LEFT JOIN preregistro_personas pp ON pp.id = t.preregistro_id
        LEFT JOIN usuarios u ON u.id = t.generado_por
      ORDER BY t.created_at DESC
    `);
    const checksRequeridosFallback = Array.isArray(CLAVES_REQUERIDAS_FIRMA) && CLAVES_REQUERIDAS_FIRMA.length
      ? [...CLAVES_REQUERIDAS_FIRMA]
      : ["pdf1", "pdf2", "pdf3", "pdf4", "pdf5"];
    const getChecksRequeridosRow = (row) => {
      if (typeof getClavesRequeridasFirma !== "function") return [...checksRequeridosFallback];
      try {
        const vinculado = typeof esProcesoVinculado === "function"
          ? esProcesoVinculado(row.docs_firma)
          : false;
        return getClavesRequeridasFirma(vinculado);
      } catch {
        return [...checksRequeridosFallback];
      }
    };
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.json(result.rows.map((row) => ({
      ...row,
      checks_requeridos: getChecksRequeridosRow(row)
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tokens de firma" });
  }
}

/**
 * Lista las personas candidatas que son elegibles para iniciar un proceso de contratación
 */
async function listCandidatos(req, res) {
  try {
    // Personas registradas en tabla personas
    const personasQuery = pool.query(`
      SELECT
        COALESCE(NULLIF(BTRIM(p.numero_documento), ''), LOWER(NULLIF(BTRIM(p.correo_electronico), ''))) AS persona_key,
        CONCAT_WS(' ', NULLIF(BTRIM(p.nombre), ''), NULLIF(BTRIM(p.apellidos), '')) AS nombre_completo,
        p.correo_electronico AS correo_personal,
        p.numero_documento,
        p.factura_en_colombia,
        'persona' AS origen,
        p.created_at,
        EXISTS (
          SELECT 1 FROM tokens_firma_contrato tf
          WHERE tf.estado IN ('pendiente','en_proceso')
            AND (
              EXISTS (SELECT 1 FROM solicitudes_contratacion sc WHERE sc.id = tf.solicitud_id AND NULLIF(BTRIM(sc.numero_documento),'') = NULLIF(BTRIM(p.numero_documento),''))
              OR EXISTS (SELECT 1 FROM preregistro_personas pp WHERE pp.id = tf.preregistro_id AND NULLIF(BTRIM(pp.numero_documento),'') = NULLIF(BTRIM(p.numero_documento),''))
              OR LOWER(NULLIF(BTRIM(tf.correo_personal),'')) = LOWER(NULLIF(BTRIM(p.correo_electronico),''))
            )
        ) AS tiene_proceso_activo
      FROM personas p
      WHERE p.correo_electronico IS NOT NULL AND BTRIM(p.correo_electronico) <> ''
      ORDER BY p.created_at DESC
      LIMIT 200
    `);

    // Personas en vuelo: solicitudes o preregistros pendientes sin fila en personas aún
    const evQuery = pool.query(`
      SELECT
        COALESCE(NULLIF(BTRIM(x.numero_documento),''), LOWER(NULLIF(BTRIM(x.correo_personal),''))) AS persona_key,
        x.nombre_completo,
        x.correo_personal,
        x.numero_documento,
        NULL::boolean AS factura_en_colombia,
        'en_vuelo' AS origen,
        x.created_at,
        EXISTS (
          SELECT 1 FROM tokens_firma_contrato tf
          WHERE tf.estado IN ('pendiente','en_proceso')
            AND (
              EXISTS (SELECT 1 FROM solicitudes_contratacion sc WHERE sc.id = tf.solicitud_id AND NULLIF(BTRIM(sc.numero_documento),'') = NULLIF(BTRIM(x.numero_documento),''))
              OR EXISTS (SELECT 1 FROM preregistro_personas pp WHERE pp.id = tf.preregistro_id AND NULLIF(BTRIM(pp.numero_documento),'') = NULLIF(BTRIM(x.numero_documento),''))
              OR LOWER(NULLIF(BTRIM(tf.correo_personal),'')) = LOWER(NULLIF(BTRIM(x.correo_personal),''))
            )
        ) AS tiene_proceso_activo
      FROM (
        SELECT
          BTRIM(sc.numero_documento) AS numero_documento,
          BTRIM(sc.correo_personal)  AS correo_personal,
          CONCAT_WS(' ', NULLIF(BTRIM(sc.nombre),''), NULLIF(BTRIM(sc.apellidos),'')) AS nombre_completo,
          MAX(sc.created_at) AS created_at
        FROM solicitudes_contratacion sc
        WHERE sc.tipo_solicitud = 'Nuevo'
          AND sc.estado IN ('Pendiente Revision TH', 'Pendiente Correo Silver')
          AND sc.correo_personal IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM personas p
            WHERE NULLIF(BTRIM(p.numero_documento),'') = NULLIF(BTRIM(sc.numero_documento),'')
              OR LOWER(NULLIF(BTRIM(p.correo_electronico),'')) = LOWER(NULLIF(BTRIM(sc.correo_personal),''))
          )
        GROUP BY BTRIM(sc.numero_documento), BTRIM(sc.correo_personal),
                 CONCAT_WS(' ', NULLIF(BTRIM(sc.nombre),''), NULLIF(BTRIM(sc.apellidos),''))
        UNION ALL
        SELECT
          BTRIM(pp.numero_documento) AS numero_documento,
          BTRIM(pp.correo_personal)  AS correo_personal,
          CONCAT_WS(' ', NULLIF(BTRIM(pp.nombre),''), NULLIF(BTRIM(pp.apellidos),'')) AS nombre_completo,
          MAX(pp.created_at) AS created_at
        FROM preregistro_personas pp
        WHERE pp.estado IN ('Pendiente Revision TH', 'Pendiente Correo Silver')
          AND pp.correo_personal IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM personas p
            WHERE NULLIF(BTRIM(p.numero_documento),'') = NULLIF(BTRIM(pp.numero_documento),'')
              OR LOWER(NULLIF(BTRIM(p.correo_electronico),'')) = LOWER(NULLIF(BTRIM(pp.correo_personal),''))
          )
        GROUP BY BTRIM(pp.numero_documento), BTRIM(pp.correo_personal),
                 CONCAT_WS(' ', NULLIF(BTRIM(pp.nombre),''), NULLIF(BTRIM(pp.apellidos),''))
      ) x
      ORDER BY x.created_at DESC
      LIMIT 200
    `);

    const [personasRes, evRes] = await Promise.all([personasQuery, evQuery]);

    const seen = new Map();
    for (const row of personasRes.rows) seen.set(row.persona_key, row);
    for (const row of evRes.rows) {
      if (!seen.has(row.persona_key)) seen.set(row.persona_key, row);
    }

    const candidatos = [...seen.values()]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 200);

    res.json({ candidatos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener candidatos" });
  }
}

/**
 * Genera un token único temporal y envía el enlace de firma por correo electrónico
 */
async function generarTokenFirma(req, res) {
  const {
    sendEmailSafe,
    getGraphContext,
    resolveProcesoForPersona,
    toNullableTrimmedString,
    resolveContratoPersonaContext,
    hasContratoBaseFirmado,
    buildDocsFirmaPlan,
    requirePersistedAnexoFromProceso,
    getCamposLaboralesFaltantes,
    CONTRATOS_TOKEN_EXPIRY_HOURS,
    CONTRATOS_BASE_URL,
    buildContratoEmailHtml,
    normalizeDocsFirmaListCompat
  } = getIndexHelpers();

  const { solicitud_id, preregistro_id, nombre_persona, correo_personal, numero_documento } = req.body || {};
  const tipoContratacion = normalizeTipoContratacionFirma(req.body?.tipo_contratacion);
  if (!tipoContratacion) {
    return res.status(400).json({ error: "Debes indicar el tipo de contratación (vinculado o todosilver)" });
  }

  if (!solicitud_id && !preregistro_id && !numero_documento && !correo_personal) {
    return res.status(400).json({ error: "Debes indicar numero_documento, correo_personal, solicitud_id o preregistro_id" });
  }

  try {
    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + CONTRATOS_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

    let solId = null;
    let preId = null;

    if (solicitud_id) {
      const r = await pool.query("SELECT id FROM solicitudes_contratacion WHERE public_id = $1", [solicitud_id]);
      if (r.rowCount === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
      solId = r.rows[0].id;
    } else if (preregistro_id) {
      const r = await pool.query("SELECT id FROM preregistro_personas WHERE public_id = $1", [preregistro_id]);
      if (r.rowCount === 0) return res.status(404).json({ error: "Preregistro no encontrado" });
      preId = r.rows[0].id;
    } else {
      // Auto-resolver por numero_documento o correo_personal
      const resolved = await resolveProcesoForPersona(pool, {
        numero_documento: toNullableTrimmedString(numero_documento),
        correo_personal: toNullableTrimmedString(correo_personal)
      });
      solId = resolved.solicitud_id;
      preId = resolved.preregistro_id;
    }

    const procesoContext = {
      solicitud_id: solId,
      preregistro_id: preId,
      nombre_persona: nombre_persona || "",
      correo_personal: correo_personal || "",
      numero_documento: numero_documento || ""
    };
    const personaContext = await resolveContratoPersonaContext(procesoContext);
    const nombreIngresado = toNullableTrimmedString(nombre_persona);
    const correoIngresado = toNullableTrimmedString(correo_personal);
    const nombreFinal =
      nombreIngresado ||
      toNullableTrimmedString(personaContext?.nombreCompleto) ||
      "";
    const correoFinal =
      correoIngresado ||
      toNullableTrimmedString(personaContext?.correoPersonal) ||
      "";
    if (!nombreFinal || !correoFinal) {
      return res.status(400).json({ error: "No se pudo resolver nombre_persona o correo_personal del proceso" });
    }

    if (correoIngresado) {
      await syncPersonaCorreoElectronico({
        personaContext,
        correoPersonal: correoIngresado,
        numeroDocumento: numero_documento,
        preregistroId: preId
      });
      if (personaContext) personaContext.correoPersonal = correoIngresado;
    }

    if (tipoContratacion === "vinculado" || personaContext?.tipoContrato === "Vinculado") {
      let personaLaboral = personaContext;
      if (personaContext?.persona_id) {
        const personaRes = await pool.query("SELECT * FROM personas WHERE id = $1", [personaContext.persona_id]);
        personaLaboral = personaRes.rows[0] || personaLaboral;
      }
      const faltantes = getCamposLaboralesFaltantes(personaLaboral);
      if (faltantes.length) {
        return res.status(400).json({
          error: `Faltan datos laborales obligatorios para el contrato: ${faltantes.join(", ")}`,
          missing: faltantes
        });
      }
    }

    // Expirar todos los tokens activos de la persona (por numero_documento)
    const numDocFinal = toNullableTrimmedString(personaContext?.numeroDocumento) || toNullableTrimmedString(numero_documento);
    if (numDocFinal) {
      await pool.query(
        `UPDATE tokens_firma_contrato tf SET estado = 'expirado', updated_at = NOW()
         WHERE tf.estado IN ('pendiente', 'en_proceso')
           AND (
             EXISTS (SELECT 1 FROM solicitudes_contratacion sc WHERE sc.id = tf.solicitud_id AND NULLIF(BTRIM(sc.numero_documento),'') = $1)
             OR EXISTS (SELECT 1 FROM preregistro_personas pp WHERE pp.id = tf.preregistro_id AND NULLIF(BTRIM(pp.numero_documento),'') = $1)
             OR ($2::text IS NOT NULL AND LOWER(NULLIF(BTRIM(tf.correo_personal),'')) = LOWER($2))
           )`,
        [numDocFinal, correoFinal || null]
      );
    } else {
      if (correoFinal) {
        await pool.query(
          "UPDATE tokens_firma_contrato SET estado = 'expirado', updated_at = NOW() WHERE LOWER(correo_personal) = LOWER($1) AND estado IN ('pendiente', 'en_proceso')",
          [correoFinal]
        );
      }
      if (solId) {
        await pool.query(
          "UPDATE tokens_firma_contrato SET estado = 'expirado', updated_at = NOW() WHERE solicitud_id = $1 AND estado IN ('pendiente', 'en_proceso')",
          [solId]
        );
      }
      if (preId) {
        await pool.query(
          "UPDATE tokens_firma_contrato SET estado = 'expirado', updated_at = NOW() WHERE preregistro_id = $1 AND estado IN ('pendiente', 'en_proceso')",
          [preId]
        );
      }
    }

    const hasBaseContract = await hasContratoBaseFirmado({
      correoPersonal: correoFinal || toNullableTrimmedString(personaContext?.correoPersonal),
      numeroDocumento: personaContext?.numeroDocumento || null
    });
    const docsPlan = buildDocsFirmaPlan({
      hasContratoBase: hasBaseContract,
      facturaEnColombia: personaContext?.facturaEnColombia ?? null,
      tipoContratacion
    });
    if (docsPlan.some((doc) => doc?.doc_key === "anexo_tecnico")) {
      await requirePersistedAnexoFromProceso(procesoContext, personaContext);
    }

    const insert = await pool.query(
      `INSERT INTO tokens_firma_contrato
        (token, solicitud_id, preregistro_id, nombre_persona, correo_personal, docs_firma, generado_por, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING public_id AS id, token, expires_at, docs_firma`,
      [token, solId, preId, nombreFinal, correoFinal, JSON.stringify(docsPlan), req.user.id, expiresAt]
    );

    const row = insert.rows[0];

    const baseUrl = CONTRATOS_BASE_URL || "https://icy-ground-03832ec1e.1.azurestaticapps.net";
    const link = `${baseUrl}/contratacion.html?t=${token}`;

    const sendResult = await sendEmailSafe({
      ...getGraphContext(req),
      to: correoFinal,
      subject: "Proceso de contratación - Silver Consulting",
      html: buildContratoEmailHtml({ nombre: nombreFinal, token, link })
    });
    if (!sendResult?.ok) {
      await pool.query("DELETE FROM tokens_firma_contrato WHERE token = $1", [token]).catch((cleanupErr) => {
        console.error("No se pudo limpiar token de firma tras fallo de correo:", cleanupErr?.message || cleanupErr);
      });
      const sendErr = new Error(sendResult?.error || "No fue posible enviar el correo");
      sendErr.status = 502;
      throw sendErr;
    }

    res.status(201).json({
      id: row.id,
      token,
      expires_at: row.expires_at,
      docs_firma: normalizeDocsFirmaListCompat(row.docs_firma),
      paquete_documentos: tipoContratacion === "vinculado" ? "vinculado" : (hasBaseContract ? "anexo_tecnico" : "completo"),
      link,
      correo_destino: correoFinal,
      correo_enviado: true
    });
  } catch (err) {
    console.error(err);
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || "No fue posible generar el token de firma" });
    }
    res.status(500).json({ error: "Error generando token de firma" });
  }
}

/**
 * Consulta y guarda datos laborales requeridos antes de generar contratos vinculados
 */
async function getDatosLaboralesFirma(req, res) {
  const helpers = getIndexHelpers();
  const { getCamposLaboralesFaltantes } = helpers;

  try {
    const personaContext = await resolveDatosLaboralesPersonaContext(req.query || {}, helpers);
    res.json(buildDatosLaboralesResponse(personaContext, getCamposLaboralesFaltantes));
  } catch (err) {
    const status = Number(err?.status || 500);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || "No fue posible consultar datos laborales" });
    }
    console.error(err);
    res.status(500).json({ error: "Error consultando datos laborales" });
  }
}

async function updateDatosLaboralesFirma(req, res) {
  const helpers = getIndexHelpers();
  const {
    getCamposLaboralesFaltantes,
    updatePersonaDatosLaborales
  } = helpers;
  let client = null;

  try {
    const personaContext = await resolveDatosLaboralesPersonaContext(req.body || {}, helpers);
    if (!personaContext?.persona_id) {
      return res.status(400).json({ error: "No existe ficha de persona para guardar datos laborales" });
    }

    client = await pool.connect();
    await client.query("BEGIN");
    const personaActualizada = await updatePersonaDatosLaborales(client, personaContext.persona_id, req.body || {});
    await client.query("COMMIT");

    res.json({
      success: true,
      faltantes: getCamposLaboralesFaltantes(personaActualizada)
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => { });
    const status = Number(err?.status || 500);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || "No fue posible guardar datos laborales" });
    }
    console.error(err);
    res.status(500).json({ error: "Error guardando datos laborales" });
  } finally {
    if (client) client.release();
  }
}

/**
 * Obtiene la lista de ítems del anexo técnico asociados a un proceso de contratación
 */
async function listAnexoItems(req, res) {
  const {
    toNullableTrimmedString,
    resolveInternalIdFromPublicIdOrId,
    ID_TABLES,
    listAnexoTecnicoItems,
    toAnexoApiRow
  } = getIndexHelpers();

  try {
    const solicitudInput = req.query?.solicitud_id || null;
    const preregistroInput = req.query?.preregistro_id || null;
    let numeroDocumento = toNullableTrimmedString(req.query?.numero_documento);
    let correoPersonal = toNullableTrimmedString(req.query?.correo_personal);

    let solicitudId = null;
    let preregistroId = null;
    if (solicitudInput) {
      solicitudId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.solicitudesContratacion, solicitudInput);
      if (!solicitudId) return res.status(404).json({ error: "Solicitud no encontrada" });
    }
    if (preregistroInput) {
      preregistroId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.preregistroPersonas, preregistroInput);
      if (!preregistroId) return res.status(404).json({ error: "Preregistro no encontrado" });
    }

    if (!solicitudId && !preregistroId && !numeroDocumento && !correoPersonal) {
      return res.status(400).json({ error: "Debes indicar solicitud_id, preregistro_id, numero_documento o correo_personal" });
    }

    // Cuando hay IDs de proceso (solicitud/preregistro), NO se resuelven ni agregan
    // numero_documento ni correo_personal: hacerlo causaria que listAnexoTecnicoItems
    // devuelva filas de otras recontrataciones del mismo colaborador via OR.
    // Los identificadores personales solo se usan como fallback cuando no hay IDs.
    const rows = await listAnexoTecnicoItems({
      solicitudId,
      preregistroId,
      numeroDocumento: (!solicitudId && !preregistroId) ? numeroDocumento : null,
      correoPersonal: (!solicitudId && !preregistroId && !numeroDocumento) ? correoPersonal : null
    });
    res.json(rows.map(toAnexoApiRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo items de anexo tecnico" });
  }
}

/**
 * Crea un nuevo registro manual para el anexo técnico de un candidato
 */
async function createAnexoItem(req, res) {
  const {
    resolveInternalIdFromPublicIdOrId,
    ID_TABLES,
    resolveContratoPersonaContext,
    toNullableTrimmedString,
    buildAnexoInsertPayload,
    insertAnexoTecnicoItem,
    getAnexoTecnicoItemByInternalId,
    toAnexoApiRow
  } = getIndexHelpers();

  const payload = req.body || {};
  try {
    const solicitudInput = payload.solicitud_id || null;
    const preregistroInput = payload.preregistro_id || null;
    if (!solicitudInput && !preregistroInput) {
      return res.status(400).json({ error: "Debes indicar solicitud_id o preregistro_id" });
    }

    let solicitudId = null;
    let preregistroId = null;
    if (solicitudInput) {
      solicitudId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.solicitudesContratacion, solicitudInput);
      if (!solicitudId) return res.status(404).json({ error: "Solicitud no encontrada" });
    }
    if (preregistroInput) {
      preregistroId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.preregistroPersonas, preregistroInput);
      if (!preregistroId) return res.status(404).json({ error: "Preregistro no encontrado" });
    }

    const personaContext = await resolveContratoPersonaContext({
      solicitud_id: solicitudId,
      preregistro_id: preregistroId,
      nombre_persona: payload.nombre_persona || "",
      correo_personal: payload.correo_personal || ""
    });

    const clienteInput = payload.cliente_id || null;
    let clienteId = null;
    let clienteNombre = toNullableTrimmedString(payload.cliente_nombre) || personaContext?.clienteNombre || "";
    if (clienteInput) {
      clienteId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.clientes, clienteInput);
      if (!clienteId) return res.status(404).json({ error: "Cliente no encontrado" });
      const c = await pool.query("SELECT titulo FROM clientes WHERE id = $1 LIMIT 1", [clienteId]);
      clienteNombre = c.rows[0]?.titulo || clienteNombre || "";
    } else if (personaContext?.clienteId) {
      clienteId = personaContext.clienteId;
      if (!clienteNombre) clienteNombre = personaContext?.clienteNombre || "";
    }

    const insertPayload = buildAnexoInsertPayload({
      input: payload,
      personaContext,
      solicitudId,
      preregistroId,
      clienteId,
      clienteNombre,
      creadoPor: req.user.id,
      origen: "manual"
    });

    const insert = await insertAnexoTecnicoItem(insertPayload);
    const row = await getAnexoTecnicoItemByInternalId(insert.row?.id);
    const statusCode = insert.duplicated ? 200 : 201;
    return res.status(statusCode).json({
      duplicated: insert.duplicated,
      item: toAnexoApiRow(row)
    });
  } catch (err) {
    const statusCode = Number(err?.status || 500);
    if (statusCode >= 400 && statusCode < 500) {
      return res.status(statusCode).json({ error: err.message || "Datos inválidos para anexo tecnico" });
    }
    console.error(err);
    return res.status(500).json({ error: "Error creando item de anexo tecnico" });
  }
}

/**
 * Anula o expira manualmente un token de firma de contrato que estaba pendiente
 */
async function deleteFirmaContrato(req, res) {
  try {
    const r = await pool.query(
      "UPDATE tokens_firma_contrato SET estado = 'expirado', updated_at = NOW() WHERE public_id = $1 RETURNING id",
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Token no encontrado" });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error anulando token" });
  }
}

module.exports = {
  listFirmaContratos,
  listCandidatos,
  generarTokenFirma,
  getDatosLaboralesFirma,
  updateDatosLaboralesFirma,
  listAnexoItems,
  createAnexoItem,
  deleteFirmaContrato
};
