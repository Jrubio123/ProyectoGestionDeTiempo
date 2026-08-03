const { pool } = require("../db");

const normalizeValue = (value) => String(value || "").toLowerCase().trim();
const normalizeModalidadTarifaKey = (value) => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();
const isModalidadHorasConTarifa = (value) => {
  const norm = normalizeModalidadTarifaKey(value);
  const compact = norm.replace(/[\s_-]+/g, "");
  if (!norm || norm.includes("capacitacion") || norm.includes("training")) return false;
  return (
    norm.includes("hora") ||
    norm.includes("demanda") ||
    ["horas", "porhoras", "horaspordemanda", "hourly"].includes(compact)
  );
};
const roundCurrency = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const normalizeDateOnlyInput = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
};

function getIndexHelpers() {
  return require("../index");
}

// Reportar horas
/**
 * Registra horas o días trabajados por un consultor para una asignación específica
 */
async function reportarHoras(req, res) {
  const {
    toNullableNumber,
    getEstadoAsignacionValues,
    isAsignacionReportableEstado,
    getMesaFabricaScope,
    isTipoAsignacionMensual,
    isTipoAsignacionTiempoCostoFijo,
    toBooleanInput,
    isTipoAsignacionHoraExtra,
    isTipoAsignacionHorasPorDemanda,
    buildPortalUrl,
    sendEmailSafe,
    getGraphContext,
    buildEmailLayout,
    buildReporteResumen,
    withPublicId
  } = getIndexHelpers();

  const {
    id_registro_asignacion,
    horas_reportadas,
    cantidad_dias_reportados,
    total_cobrar,
    tipo_servicio,
    nro_caso_int_ext
  } = req.body;

  try {
    const horasReportadasInput = toNullableNumber(horas_reportadas);
    const diasReportadosInput = toNullableNumber(cantidad_dias_reportados);
    const totalCobrarNum = toNullableNumber(total_cobrar);

    if (!id_registro_asignacion) {
      return res.status(400).json({ error: "Falta id_registro_asignacion" });
    }

    const metaConsulta = await pool.query(
      `
      WITH c_asignacion AS (SELECT id FROM registro_asignaciones WHERE public_id = $1)
      SELECT
        ra.id,
        ra.estado AS estado_asignacion,
        ra.id_modulo,
        ra.horas_asignadas,
        ra.cantidad_dias,
        ra.valor_hora,
        ra.valor_dia,
        ra.total_pagar,
        ra.es_costo_total,
        ra.consultor_responsable_id,
        con.id_cliente,
        con.id_tipo_asignacion,
        con.coordinador_responsable_id,
        ta.titulo AS tipo_asignacion_titulo,
        ur.ultimo_reporte_id,
        ur.ultimo_reporte_estado
      FROM registro_asignaciones ra
        JOIN consultorias con ON ra.id_consultoria = con.id
        LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
        LEFT JOIN LATERAL (
          SELECT
            rh.id AS ultimo_reporte_id,
            rh.estado_reporte AS ultimo_reporte_estado
          FROM reporte_horas rh
          WHERE rh.id_registro_asignacion = ra.id
          ORDER BY rh.updated_at DESC NULLS LAST, rh.id DESC
          LIMIT 1
        ) ur ON true
      WHERE ra.id = (SELECT id FROM c_asignacion)
      `,
      [id_registro_asignacion]
    );

    if (metaConsulta.rows.length === 0) {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }

    const info = metaConsulta.rows[0];
    const registroAsignacionId = info.id;
    if (!info.consultor_responsable_id) {
      return res.status(400).json({ error: "La asignación no tiene consultor responsable." });
    }
    if (req.user?.id) {
      const permiso = await pool.query(
        `SELECT 1
         FROM usuarios u
         WHERE u.id = $1
           AND (u.id = $2 OR u.id_consultor_principal = $2)
         LIMIT 1`,
        [info.consultor_responsable_id, req.user.id]
      );
      if (permiso.rows.length === 0) {
        return res.status(403).json({ error: "No tienes permisos para reportar esta asignación" });
      }
    }
    const estadosAsignacion = await getEstadoAsignacionValues();
    if (!isAsignacionReportableEstado(info.estado_asignacion, estadosAsignacion)) {
      return res.status(400).json({ error: "La asignación está cerrada y no permite nuevos reportes." });
    }
    const tipoAsignacionId = Number(info.id_tipo_asignacion || 0);
    const tipoAsignacionTitulo = String(info.tipo_asignacion_titulo || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
    const esMesaOFabrica = Boolean(
      getMesaFabricaScope(tipoAsignacionId, tipoAsignacionTitulo, info)
    );
    if (esMesaOFabrica) {
      return res.status(400).json({
        error: "Las asignaciones de Mesa/Fábrica se registran en el módulo de Mesa/Fábrica, no en Registro Horas."
      });
    }

    const esMensual =
      isTipoAsignacionMensual(tipoAsignacionTitulo);
    const esTiempoCostoFijo = isTipoAsignacionTiempoCostoFijo(tipoAsignacionTitulo);
    const permitirParcialesAcumulados = esTiempoCostoFijo;
    const esCostoTotal = esTiempoCostoFijo && toBooleanInput(info.es_costo_total, false);
    const esHoraExtra = isTipoAsignacionHoraExtra(tipoAsignacionTitulo);
    const esHorasPorDemanda = isTipoAsignacionHorasPorDemanda(tipoAsignacionTitulo);
    const ultimoReporteId = Number(info.ultimo_reporte_id || 0) || null;
    const ultimoReporteEstado = String(info.ultimo_reporte_estado || "").trim() || null;
    if (!permitirParcialesAcumulados && ultimoReporteEstado === "Pendiente") {
      return res.status(400).json({ error: "Ya hay un reporte pendiente para esta asignación" });
    }
    let cantidadSolicitada = 0;
    let horasReportadasFinal = 0;
    let diasReportadosFinal = 0;
    let totalCobrarFinal = totalCobrarNum;

    if (esCostoTotal) {
      const totalAsignado = toNullableNumber(info.total_pagar);
      if (totalAsignado === null) {
        return res.status(400).json({ error: "La asignación no tiene presupuesto total configurado." });
      }
      cantidadSolicitada = Number(totalCobrarNum || 0);
      if (!(cantidadSolicitada > 0)) {
        return res.status(400).json({ error: "Debes reportar un valor mayor a 0 para costo total" });
      }
      totalCobrarFinal = Math.round((cantidadSolicitada + Number.EPSILON) * 100) / 100;
    } else {
      if (esMensual && diasReportadosInput !== null && !Number.isInteger(diasReportadosInput)) {
        return res.status(400).json({ error: "Los días reportados deben ser un número entero" });
      }
      cantidadSolicitada = esMensual
        ? Number(diasReportadosInput || 0)
        : Number(horasReportadasInput || 0);
      horasReportadasFinal = esMensual ? 0 : Number(horasReportadasInput || 0);
      diasReportadosFinal = esMensual ? Math.trunc(diasReportadosInput || 0) : 0;
      const valorHoraAsignado = toNullableNumber(info.valor_hora);
      const valorDiaAsignado = toNullableNumber(info.valor_dia);
      if (esMensual) {
        const tarifaDia = valorDiaAsignado ?? (valorHoraAsignado !== null ? Number(valorHoraAsignado) / 20 : null);
        if (tarifaDia !== null) {
          totalCobrarFinal = Number(tarifaDia) * Number(diasReportadosFinal || 0);
        }
      } else if (valorHoraAsignado !== null) {
        totalCobrarFinal = Number(valorHoraAsignado) * Number(horasReportadasFinal || 0);
      }
      if (totalCobrarFinal !== null) {
        totalCobrarFinal = Math.round((Number(totalCobrarFinal) + Number.EPSILON) * 100) / 100;
      }
      if (!(cantidadSolicitada > 0)) {
        return res.status(400).json({ error: esMensual ? "Debes reportar días mayores a 0" : "Debes reportar horas mayores a 0" });
      }
    }

    if (!esHorasPorDemanda && !esHoraExtra) {
      const uso = await pool.query(
        `
        SELECT
          COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN horas_reportadas ELSE 0 END), 0) AS horas_aprobadas,
          COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN cantidad_dias_reportados ELSE 0 END), 0) AS dias_aprobados,
          COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN total_cobrar ELSE 0 END), 0) AS total_aprobado,
          COALESCE(SUM(CASE WHEN estado_reporte <> 'Rechazado' THEN horas_reportadas ELSE 0 END), 0) AS horas_comprometidas,
          COALESCE(SUM(CASE WHEN estado_reporte <> 'Rechazado' THEN cantidad_dias_reportados ELSE 0 END), 0) AS dias_comprometidos,
          COALESCE(SUM(CASE WHEN estado_reporte <> 'Rechazado' THEN total_cobrar ELSE 0 END), 0) AS total_comprometido
        FROM reporte_horas
        WHERE id_registro_asignacion = $1
        `,
        [registroAsignacionId]
      );
      if (esCostoTotal) {
        const totalAprobado = Number(uso.rows[0]?.total_aprobado || 0);
        const totalComprometido = Number(uso.rows[0]?.total_comprometido || 0);
        const totalAsignado = toNullableNumber(info.total_pagar);
        if (totalAsignado !== null) {
          const totalUsado = permitirParcialesAcumulados ? totalComprometido : totalAprobado;
          const disponibles = Math.max(totalAsignado - totalUsado, 0);
          if (cantidadSolicitada > disponibles) {
            return res.status(400).json({ error: `Excede presupuesto disponible de la asignación (${disponibles})` });
          }
        }
      } else {
        const horasAprobadas = Number(uso.rows[0]?.horas_aprobadas || 0);
        const diasAprobadas = Number(uso.rows[0]?.dias_aprobadas || 0);
        const horasComprometidas = Number(uso.rows[0]?.horas_comprometidas || 0);
        const diasComprometidas = Number(uso.rows[0]?.dias_comprometidos || 0);
        const horasAsignadas = toNullableNumber(info.horas_asignadas);
        const diasAsignados = toNullableNumber(info.cantidad_dias);

        if (esMensual) {
          // Modalidad mensual (full-time/part-time): no se bloquea el exceso.
          // El consultor puede reportar más días que los asignados;
          // el total se calcula como días * valor_dia.
        } else if (!esMensual && horasAsignadas !== null) {
          const horasUsadas = permitirParcialesAcumulados ? horasComprometidas : horasAprobadas;
          const disponibles = Math.max(horasAsignadas - horasUsadas, 0);
          if (cantidadSolicitada > disponibles) {
            return res.status(400).json({ error: `Excede horas disponibles de la asignación (${disponibles})` });
          }
        }
      }
    }

    const consultorId = info.consultor_responsable_id || req.user?.id || null;
    let consultorPrincipalId = null;
    if (consultorId) {
      const principalRes = await pool.query(
        "SELECT id_consultor_principal, tipo_consultor FROM usuarios WHERE id = $1",
        [consultorId]
      );
      const principalRow = principalRes.rows[0];
      if (principalRow?.id_consultor_principal) {
        consultorPrincipalId = principalRow.id_consultor_principal;
      }
    }
    let result;
    if (ultimoReporteEstado === "Rechazado" && ultimoReporteId) {
      result = await pool.query(
        `UPDATE reporte_horas
           SET horas_reportadas = $1,
               cantidad_dias_reportados = $2,
               total_cobrar = $3,
               tipo_servicio = $4,
               nro_caso_int_ext = $5,
               cliente_id = $6,
               tipo_asignacion_id = $7,
               modulo_id = $8,
               coordinador_id = $9,
               consultor_responsable_id = $10,
               consultor_principal_id = $11,
               estado_reporte = 'Pendiente',
               motivo_rechazo = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $12
           RETURNING *`,
        [
          horasReportadasFinal,
          diasReportadosFinal,
          totalCobrarFinal,
          tipo_servicio || null,
          nro_caso_int_ext || null,
          info.id_cliente,
          info.id_tipo_asignacion,
          info.id_modulo,
          info.coordinador_responsable_id,
          consultorId,
          consultorPrincipalId,
          ultimoReporteId
        ]
      );
    } else {
      result = await pool.query(
        `INSERT INTO reporte_horas
            (id_registro_asignacion, horas_reportadas, cantidad_dias_reportados, total_cobrar,
             tipo_servicio, nro_caso_int_ext, cliente_id, tipo_asignacion_id, modulo_id,
             coordinador_id, consultor_responsable_id, consultor_principal_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING *`,
        [
          registroAsignacionId,
          horasReportadasFinal,
          diasReportadosFinal,
          totalCobrarFinal,
          tipo_servicio || null,
          nro_caso_int_ext || null,
          info.id_cliente,
          info.id_tipo_asignacion,
          info.id_modulo,
          info.coordinador_responsable_id,
          consultorId,
          consultorPrincipalId,
          req.user?.id || consultorId
        ]
      );
    }

    const estados = await getEstadoAsignacionValues();
    await pool.query(
      `UPDATE registro_asignaciones
       SET estado = $2::tipo_estado_asignacion
       WHERE id = $1`,
      [registroAsignacionId, estados.proceso]
    );

    // Email al coordinador para aprobación
    const correoInfo = await pool.query(
      `SELECT
         ucoord.email AS coordinador_email,
         ucoord.nombre_usuario AS coordinador_nombre,
         ucons.nombre_usuario AS consultor_nombre,
         c.titulo AS cliente,
         ta.titulo AS tipo_asignacion
       FROM consultorias con
         JOIN clientes c ON con.id_cliente = c.id
         LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
         LEFT JOIN usuarios ucoord ON ucoord.id = con.coordinador_responsable_id
         LEFT JOIN usuarios ucons ON ucons.id = $2
       WHERE con.id = (
         SELECT id_consultoria FROM registro_asignaciones WHERE id = $1
       )`,
      [registroAsignacionId, consultorId]
    );
    const correoRow = correoInfo.rows[0];
    if (correoRow?.coordinador_email) {
      const portalUrl = buildPortalUrl("aprobar-rechazar-coordinador");
      await sendEmailSafe({
        ...getGraphContext(req),
        to: correoRow.coordinador_email,
        subject: `⏳ Aprobación pendiente: reporte de ${correoRow.consultor_nombre || "consultor"}`,
        text:
          `Hola ${correoRow.coordinador_nombre || ""},\n` +
          `El consultor ${correoRow.consultor_nombre || ""} reportó horas.\n` +
          `Cliente: ${correoRow.cliente}\n` +
          `Tipo: ${correoRow.tipo_asignacion || "N/A"}\n` +
          `Detalle: ${buildReporteResumen({ horas_reportadas: horasReportadasFinal, cantidad_dias_reportados: diasReportadosFinal, total_cobrar: totalCobrarFinal })}\n` +
          `Revisar: ${portalUrl}\n`,
        html: buildEmailLayout({
          title: "Aprobación pendiente de reporte",
          intro: `Hola <strong>${correoRow.coordinador_nombre || "Coordinador"}</strong>, el consultor <strong>${correoRow.consultor_nombre || "N/A"}</strong> registró horas y requiere validación.`,
          blocks: [
            { label: "Cliente", value: correoRow.cliente || "N/A" },
            { label: "Tipo de asignación", value: correoRow.tipo_asignacion || "N/A" },
            { label: "Resumen", value: buildReporteResumen({ horas_reportadas: horasReportadasFinal, cantidad_dias_reportados: diasReportadosFinal, total_cobrar: totalCobrarFinal }) }
          ],
          ctaLabel: "Revisar y aprobar",
          ctaUrl: portalUrl
        })
      });
    }

    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al reportar horas" });
  }
}

// Reportes pendientes para coordinador
/**
 * Obtiene los reportes de horas que están pendientes de revisión por un coordinador
 */
async function listarAprobacionesPendientes(req, res) {
  const {
    applyTicketCaseFields
  } = getIndexHelpers();

  try {
    const userId = req.user?.id;
    const result = await pool.query(`
      SELECT
        rh.public_id AS id,
        rh.created_at AS fecha_reporte,
        rh.nro_caso_int_ext,
        rh.tipo_servicio,
        rh.observacion_mesa_fabrica AS observacion_ticket,
        rh.requerimiento,
        rh.perfil_fabrica,
        rh.wricef,
        rh.id_registro_asignacion,
        rh.total_cobrar,
        rh.horas_reportadas,
        rh.cantidad_dias_reportados,
        c.titulo AS nombre_cliente,
        u.nombre_usuario AS nombre_consultor,
        u.email AS email_consultor,
        m.titulo AS nombre_modulo,
        ta.titulo AS nombre_tipo_asignacion,
        ra.public_id AS asignacion_id,
        ra.nro_caso_cliente AS asignacion_nro_caso_cliente,
        ra.nro_caso_interno AS asignacion_nro_caso_interno,
        ra.fecha_inicio AS asignacion_fecha_inicio,
        ra.fecha_fin AS asignacion_fecha_fin,
        ra.observacion AS asignacion_observacion
      FROM reporte_horas rh
        LEFT JOIN clientes c ON rh.cliente_id = c.id
        LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
        LEFT JOIN modulo m ON rh.modulo_id = m.id
        LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
        LEFT JOIN registro_asignaciones ra ON rh.id_registro_asignacion = ra.id
      WHERE rh.estado_reporte = 'Pendiente'
        AND rh.coordinador_id = $1
      ORDER BY rh.created_at DESC
    `, [userId]);
    const rows = (result.rows || []).map((row) => {
      const withCases = applyTicketCaseFields(row);
      return {
        ...withCases,
        nro_caso_cliente:
          withCases.nro_caso_cliente || row?.asignacion_nro_caso_cliente || null,
        nro_caso_interno:
          withCases.nro_caso_interno || row?.asignacion_nro_caso_interno || null
      };
    });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener reportes" });
  }
}

// Solicitudes historicas para exportacion de coordinador/admin responsable
async function listarSolicitudesAprobacion(req, res) {
  const {
    applyTicketCaseFields
  } = getIndexHelpers();

  try {
    const userId = req.user?.id;
    const isAdmin = normalizeValue(req.user?.rol) === "administrador";
    const fechaInicio = normalizeDateOnlyInput(req.query?.fecha_inicio);
    const fechaFin = normalizeDateOnlyInput(req.query?.fecha_fin);
    const tipo = String(req.query?.tipo || "general").toLowerCase().trim();

    if (!userId) {
      return res.status(401).json({ error: "Usuario no autenticado" });
    }
    if (!fechaInicio || !fechaFin) {
      return res.status(400).json({ error: "Fecha inicio y fecha fin son obligatorias" });
    }
    if (fechaFin < fechaInicio) {
      return res.status(400).json({ error: "La fecha fin no puede ser menor a la fecha inicio" });
    }

    let tipoWhere = "";
    if (tipo === "mesa") {
      tipoWhere = `
        AND (
          LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%mesa%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%service desk%'
          OR LOWER(REPLACE(TRIM(COALESCE(ta.titulo, '')), ' ', '')) LIKE '%servicedesk%'
        )
      `;
    } else if (tipo === "fabrica") {
      tipoWhere = `
        AND (
          LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%fabrica%'
          OR LOWER(TRIM(COALESCE(ta.titulo, ''))) LIKE '%fábrica%'
        )
      `;
    } else if (tipo !== "general") {
      return res.status(400).json({ error: "Tipo de exportacion invalido" });
    }

    const result = await pool.query(`
      SELECT *
      FROM (
        SELECT
          rh.public_id AS id,
          rh.estado_reporte::text AS estado,
          rh.estado_reporte::text AS estado_reporte,
          rh.created_at AS fecha_reporte,
          COALESCE(ra.fecha_inicio, rh.created_at::date) AS fecha_inicio,
          COALESCE(ra.fecha_fin, rh.fecha_cierre_mesa_fab) AS fecha_fin,
          rh.fecha_cierre_mesa_fab,
          rh.nro_caso_int_ext,
          rh.tipo_servicio::text AS tipo_servicio,
          rh.observacion_mesa_fabrica AS observacion_ticket,
          rh.requerimiento,
          rh.perfil_fabrica,
          rh.wricef,
          rh.id_registro_asignacion,
          rh.total_cobrar,
          rh.horas_reportadas,
          rh.cantidad_dias_reportados,
          c.titulo AS nombre_cliente,
          u.nombre_usuario AS nombre_consultor,
          u.email AS email_consultor,
          m.titulo AS nombre_modulo,
          ta.titulo AS nombre_tipo_asignacion,
          ra.public_id AS asignacion_id,
          ra.estado::text AS estado_asignacion,
          ra.nro_caso_cliente AS asignacion_nro_caso_cliente,
          ra.nro_caso_interno AS asignacion_nro_caso_interno,
          ra.fecha_inicio AS asignacion_fecha_inicio,
          ra.fecha_fin AS asignacion_fecha_fin,
          ra.observacion AS asignacion_observacion
        FROM reporte_horas rh
          LEFT JOIN clientes c ON rh.cliente_id = c.id
          LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
          LEFT JOIN modulo m ON rh.modulo_id = m.id
          LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
          LEFT JOIN registro_asignaciones ra ON rh.id_registro_asignacion = ra.id
        WHERE ($4::boolean OR rh.coordinador_id = $1)
          AND COALESCE(ra.fecha_inicio, rh.created_at::date) BETWEEN $2::date AND $3::date
          ${tipoWhere}

        UNION ALL

        SELECT
          ra.public_id AS id,
          ra.estado::text AS estado,
          NULL::text AS estado_reporte,
          ra.created_at AS fecha_reporte,
          COALESCE(ra.fecha_inicio, ra.created_at::date) AS fecha_inicio,
          ra.fecha_fin AS fecha_fin,
          ra.fecha_cierre_mesa_fab,
          NULL::text AS nro_caso_int_ext,
          ra.tipo_servicio::text AS tipo_servicio,
          ra.observacion AS observacion_ticket,
          NULL::text AS requerimiento,
          NULL::varchar AS perfil_fabrica,
          NULL::varchar AS wricef,
          ra.id AS id_registro_asignacion,
          ra.total_pagar AS total_cobrar,
          ra.horas_asignadas AS horas_reportadas,
          ra.cantidad_dias AS cantidad_dias_reportados,
          c.titulo AS nombre_cliente,
          u.nombre_usuario AS nombre_consultor,
          u.email AS email_consultor,
          m.titulo AS nombre_modulo,
          ta.titulo AS nombre_tipo_asignacion,
          ra.public_id AS asignacion_id,
          ra.estado::text AS estado_asignacion,
          ra.nro_caso_cliente AS asignacion_nro_caso_cliente,
          ra.nro_caso_interno AS asignacion_nro_caso_interno,
          ra.fecha_inicio AS asignacion_fecha_inicio,
          ra.fecha_fin AS asignacion_fecha_fin,
          ra.observacion AS asignacion_observacion
        FROM registro_asignaciones ra
          JOIN consultorias con ON ra.id_consultoria = con.id
          LEFT JOIN clientes c ON con.id_cliente = c.id
          LEFT JOIN usuarios u ON ra.consultor_responsable_id = u.id
          LEFT JOIN modulo m ON ra.id_modulo = m.id
          LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
        WHERE ($4::boolean OR con.coordinador_responsable_id = $1)
          AND COALESCE(ra.fecha_inicio, ra.created_at::date) BETWEEN $2::date AND $3::date
          AND LOWER(ra.estado::text) IN ('abierto', 'proceso')
          AND NOT EXISTS (
            SELECT 1
            FROM reporte_horas rh_existente
            WHERE rh_existente.id_registro_asignacion = ra.id
          )
          ${tipoWhere}
      ) solicitudes
      ORDER BY fecha_inicio DESC NULLS LAST, fecha_reporte DESC NULLS LAST
    `, [userId, fechaInicio, fechaFin, isAdmin]);

    const rows = (result.rows || []).map((row) => {
      const withCases = applyTicketCaseFields(row);
      return {
        ...withCases,
        nro_caso_cliente:
          withCases.nro_caso_cliente || row?.asignacion_nro_caso_cliente || null,
        nro_caso_interno:
          withCases.nro_caso_interno || row?.asignacion_nro_caso_interno || null
      };
    });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener solicitudes" });
  }
}

// Aprobar / Rechazar reporte
/**
 * Registra la aprobación o rechazo de un reporte y notifica al consultor respectivo
 */
async function actualizarAprobacion(req, res) {
  const {
    getEstadoAsignacionValues,
    getMesaFabricaScope,
    normalizeTipoAsignacionTitulo,
    isTipoAsignacionMensual,
    isTipoAsignacionTiempoCostoFijo,
    toBooleanInput,
    isTipoAsignacionHoraExtra,
    isTipoAsignacionHorasPorDemanda,
    toNullableNumber,
    buildReporteResumen,
    isTipoAsignacionMesaOFabrica,
    buildPortalUrl,
    sendEmailSafe,
    getGraphContext,
    buildEmailLayout,
    isGuid,
    withPublicId
  } = getIndexHelpers();

  const { id } = req.params;
  const { estado, motivo } = req.body;

  try {
    if (!estado) {
      return res.status(400).json({ error: "Falta estado" });
    }
    if (!isGuid(id)) {
      return res.status(400).json({ error: "Reporte inválido" });
    }

    const role = normalizeValue(req.user?.rol);
    const esAprobacion = String(estado || "").trim() === "Aprobado";
    const client = await pool.connect();
    let txStarted = false;
    let result;
    let reporteId = null;
    let registroId = null;

    try {
      await client.query("BEGIN");
      txStarted = true;

      const propiedad = await client.query(
        `SELECT rh.id
         FROM reporte_horas rh
         JOIN registro_asignaciones ra ON ra.id = rh.id_registro_asignacion
         JOIN consultorias con ON con.id = ra.id_consultoria
         WHERE rh.public_id = $1::uuid
           AND ($3::boolean = true OR con.coordinador_responsable_id = $2::int)`,
        [id, req.user?.id || null, role === "administrador"]
      );

      if (propiedad.rows.length === 0) {
        await client.query("ROLLBACK");
        txStarted = false;
        return res.status(404).json({ error: "Reporte no encontrado" });
      }

      let totalCobrarAprobado = null;
      if (esAprobacion) {
        const tarifaMeta = await client.query(
          `SELECT
             rh.id,
             rh.horas_reportadas,
             rh.consultor_responsable_id,
             con.id_cliente,
             con.id_tipo_asignacion,
             ra.id_modulo,
             ta.titulo AS tipo_asignacion_titulo,
             tarifa.valor_tarifa AS tarifa_consultor
           FROM reporte_horas rh
             JOIN registro_asignaciones ra ON ra.id = rh.id_registro_asignacion
             JOIN consultorias con ON con.id = ra.id_consultoria
             LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
             LEFT JOIN LATERAL (
               SELECT tc.valor_tarifa
               FROM tarifa_consultor tc
               WHERE tc.consultor_id = rh.consultor_responsable_id
                 AND tc.id_cliente = con.id_cliente
                 AND (ra.id_modulo IS NULL OR tc.modulo_id = ra.id_modulo)
                 AND (con.id_tipo_asignacion IS NULL OR tc.id_tipo_asignacion = con.id_tipo_asignacion)
                 AND tc.activo = true
                 AND (tc.vigencia_hasta IS NULL OR tc.vigencia_hasta >= CURRENT_DATE)
               ORDER BY tc.vigencia_desde DESC NULLS LAST, tc.id DESC
               LIMIT 1
             ) tarifa ON true
           WHERE rh.public_id = $1::uuid`,
          [id]
        );
        const tarifaInfo = tarifaMeta.rows[0];
        const requiereTarifaHoras =
          tarifaInfo &&
          isModalidadHorasConTarifa(tarifaInfo.tipo_asignacion_titulo) &&
          !isTipoAsignacionMesaOFabrica(tarifaInfo.tipo_asignacion_titulo);

        if (requiereTarifaHoras) {
          const tarifa = toNullableNumber(tarifaInfo.tarifa_consultor);
          if (!(tarifa > 0)) {
            await client.query("ROLLBACK");
            txStarted = false;
            return res.status(400).json({ error: "No se puede aprobar: tarifa del consultor ausente o inválida" });
          }
          const horas = toNullableNumber(tarifaInfo.horas_reportadas);
          if (horas !== null) {
            totalCobrarAprobado = roundCurrency(Number(tarifa) * Number(horas));
          }
        }
      }

      result = await client.query(
        `
         WITH c_reporte AS (SELECT id FROM reporte_horas WHERE public_id = $3::uuid)
         UPDATE reporte_horas
         SET estado_reporte = $1,
             motivo_rechazo = $2,
             total_cobrar = COALESCE($5::numeric, total_cobrar),
             aprobado_por = CASE
               WHEN $1::tipo_estado_reporte = 'Aprobado'::tipo_estado_reporte THEN $4::int
               ELSE NULL
             END,
             fecha_aprobacion = CASE
               WHEN $1::tipo_estado_reporte = 'Aprobado'::tipo_estado_reporte THEN CURRENT_TIMESTAMP
               ELSE NULL
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = (SELECT id FROM c_reporte)
         RETURNING *`,
        [estado, motivo || null, id, req.user?.id || null, totalCobrarAprobado]
      );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        txStarted = false;
        return res.status(404).json({ error: "Reporte no encontrado" });
      }

      reporteId = result.rows[0]?.id || null;
      registroId = result.rows[0]?.id_registro_asignacion || null;
      if (registroId) {
        const estados = await getEstadoAsignacionValues();
        let estadoAprobadoDestino = estados.proceso;
        const asignacionMeta = await client.query(
          `SELECT
           con.id_tipo_asignacion,
            ta.titulo AS tipo_asignacion_titulo,
            ra.horas_asignadas,
            ra.cantidad_dias,
            ra.total_pagar,
            ra.es_costo_total
           FROM registro_asignaciones ra
           JOIN consultorias con ON con.id = ra.id_consultoria
           LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
           WHERE ra.id = $1`,
          [registroId]
        );
        if (asignacionMeta.rows.length > 0) {
          const meta = asignacionMeta.rows[0];
          const scope = getMesaFabricaScope(meta.id_tipo_asignacion, meta.tipo_asignacion_titulo);
          if (scope) {
            // Mesa/Fabrica: se cierra la solicitud (reporte), pero la asignacion base sigue activa.
            estadoAprobadoDestino = estados.abierto || estados.proceso;
          } else {
            const tipoNorm = normalizeTipoAsignacionTitulo(meta.tipo_asignacion_titulo);
            const esMensual = isTipoAsignacionMensual(tipoNorm);
            const esTiempoCostoFijo = isTipoAsignacionTiempoCostoFijo(tipoNorm);
            const esCostoTotal = esTiempoCostoFijo && toBooleanInput(meta.es_costo_total, false);
            const esHoraExtra = isTipoAsignacionHoraExtra(tipoNorm);
            const esHorasPorDemanda = isTipoAsignacionHorasPorDemanda(tipoNorm);
            if (esHoraExtra) {
              // Las horas extra permanecen disponibles durante todo el periodo de vigencia.
              estadoAprobadoDestino = estados.proceso;
            } else if (esHorasPorDemanda) {
              // Para horas por demanda se cierra al aprobar para evitar reprocesos
              // del mismo bloque antes de pasar a cuenta de cobro.
              estadoAprobadoDestino = estados.cerrado || estados.proceso;
            } else {
              const uso = await client.query(
                `
                SELECT
                  COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN horas_reportadas ELSE 0 END), 0) AS horas_aprobadas,
                  COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN cantidad_dias_reportados ELSE 0 END), 0) AS dias_aprobados,
                  COALESCE(SUM(CASE WHEN estado_reporte = 'Aprobado' THEN total_cobrar ELSE 0 END), 0) AS total_aprobado
                FROM reporte_horas
                WHERE id_registro_asignacion = $1
                `,
                [registroId]
              );
              const horasAsignadas = toNullableNumber(meta.horas_asignadas);
              const diasAsignados = toNullableNumber(meta.cantidad_dias);
              const totalAsignado = toNullableNumber(meta.total_pagar);
              const horasAprobadas = Number(uso.rows[0]?.horas_aprobadas || 0);
              const diasAprobadas = Number(uso.rows[0]?.dias_aprobadas || 0);
              const totalAprobado = Number(uso.rows[0]?.total_aprobado || 0);
              const agotadoPorHoras = !esMensual && horasAsignadas !== null && horasAprobadas >= horasAsignadas;
              const agotadoPorDias = false; // mensual no tiene tope de días
              const agotadoPorTotal = esCostoTotal && totalAsignado !== null && totalAprobado >= totalAsignado;
              if (agotadoPorHoras || agotadoPorDias || agotadoPorTotal) {
                estadoAprobadoDestino = estados.cerrado || estados.proceso;
              }
            }
          }
        }
        // Actualizar aprobación y estado en la asignación asociada
        await client.query(
          `UPDATE registro_asignaciones
           SET aprobar_coordinador = $1::tipo_aprobacion,
               estado = CASE
                 WHEN $1::tipo_aprobacion = 'Aprobado'::tipo_aprobacion THEN $3::tipo_estado_asignacion
                 WHEN $1::tipo_aprobacion = 'Rechazado'::tipo_aprobacion THEN $4::tipo_estado_asignacion
                 ELSE estado
               END
           WHERE id = $2`,
          [estado, registroId, estadoAprobadoDestino, estados.abierto]
        );
      }

      await client.query("COMMIT");
      txStarted = false;
    } catch (txErr) {
      if (txStarted) {
        await client.query("ROLLBACK");
      }
      throw txErr;
    } finally {
      client.release();
    }

    // Email al consultor con resultado de aprobación
    const detalle = await pool.query(
      `SELECT
         u.email AS consultor_email,
         u.nombre_usuario AS consultor_nombre,
         u.tipo_consultor AS consultor_tipo,
         c.titulo AS cliente,
         ta.titulo AS tipo_asignacion,
         rh.horas_reportadas,
         rh.cantidad_dias_reportados,
         rh.total_cobrar
       FROM reporte_horas rh
         LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
         LEFT JOIN clientes c ON rh.cliente_id = c.id
         LEFT JOIN tipo_asignacion ta ON rh.tipo_asignacion_id = ta.id
       WHERE rh.id = $1`,
      [reporteId]
    );
    const info = detalle.rows[0];
    if (info?.consultor_email) {
      const esConsultorAsociado = normalizeValue(info.consultor_tipo) === "asociado";
      const resumenData = esConsultorAsociado
        ? { ...info, total_cobrar: null }
        : info;
      const resumenReporte = buildReporteResumen(resumenData);
      const esAprobado = estado === "Aprobado";
      const tipoNorm = String(info.tipo_asignacion || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
      const esMesaOFabrica = isTipoAsignacionMesaOFabrica(tipoNorm);
      const portalUrl = buildPortalUrl(esMesaOFabrica ? "asignacion-fabrica-mesa-servicio" : "registro-horas-consultor");
      const titulo = esAprobado
        ? "✅ Horas aprobadas"
        : estado === "Rechazado"
          ? "⚠️ Acción requerida: corrección de reporte"
          : "Actualización de reporte";
      await sendEmailSafe({
        ...getGraphContext(req),
        to: info.consultor_email,
        subject: `${titulo} - ${info.cliente || "Cliente"}`,
        text:
          `Hola ${info.consultor_nombre || ""},\n` +
          `Tu reporte fue ${estado}.\n` +
          `Cliente: ${info.cliente || "N/A"}\n` +
          `Tipo: ${info.tipo_asignacion || "N/A"}\n` +
          `Detalle: ${resumenReporte}\n` +
          (estado === "Rechazado" && motivo ? `Motivo: ${motivo}\n` : "") +
          `Portal: ${portalUrl}\n`,
        html: buildEmailLayout({
          title: esAprobado ? "Reporte aprobado exitosamente" : "Reporte con corrección requerida",
          intro: esAprobado
            ? `Hola <strong>${info.consultor_nombre || "Consultor"}</strong>, tu reporte fue validado y aprobado.`
            : `Hola <strong>${info.consultor_nombre || "Consultor"}</strong>, tu reporte requiere ajustes antes de procesarse.`,
          blocks: [
            { label: "Cliente", value: info.cliente || "N/A" },
            { label: "Tipo de asignación", value: info.tipo_asignacion || "N/A" },
            { label: "Resumen", value: resumenReporte },
            ...(estado === "Rechazado" ? [{ label: "Motivo", value: motivo || "Sin detalle" }] : [])
          ],
          ctaLabel: esAprobado ? "Ver reporte" : "Corregir reporte",
          ctaUrl: portalUrl,
          closing: esAprobado
            ? "Gracias por tu gestión. Atentamente, Coordinación de Operaciones."
            : "Por favor realiza la corrección y envía nuevamente a aprobación."
        })
      });
    }

    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Reporte no encontrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar reporte" });
  }
}

module.exports = {
  reportarHoras,
  listarAprobacionesPendientes,
  listarSolicitudesAprobacion,
  actualizarAprobacion
};
