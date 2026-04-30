const { pool } = require("../db");
const { getGraphAccessToken } = require("../email");
const PDFDocument = require("pdfkit");

const normalizeValue = (value) => String(value || "").toLowerCase().trim();

function getIndexHelpers() {
  return require("../index");
}

// Vista previa de cuenta de cobro (total + letras)
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
async function getSoportesCuentas(req, res) {
  const { consultor_id } = req.query || {};
  try {
    const result = await pool.query(
      `
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
        cc.datos_adjuntos
      FROM cuenta_cobro cc
        JOIN usuarios u ON u.id = cc.created_by
      WHERE cc.datos_adjuntos IS NOT NULL
        AND (
          cc.datos_adjuntos ? 'soportes'
          OR cc.datos_adjuntos #> '{firma,documento_firmado}' IS NOT NULL
        )
        AND ($1::uuid IS NULL OR u.public_id = $1::uuid)
      ORDER BY cc.id DESC
      `,
      [consultor_id || null]
    );
    res.json(result.rows || []);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.json([]);
    console.error(err);
    res.status(500).json({ error: "Error al obtener soportes de cuentas de cobro" });
  }
}

// Detalle de cuenta de cobro
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

module.exports = {
  previewCuentaCobro,
  crearCuentaCobro,
  getHistorialCuentas,
  getSoportesCuentas,
  getDetalleCuenta,
  getCuentaPdf
};
