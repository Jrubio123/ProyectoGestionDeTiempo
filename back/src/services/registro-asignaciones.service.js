const { pool } = require("../db");

const normalizeValue = (value) => String(value || "").toLowerCase().trim();
const ERROR_TARIFA_HORAS = "No se puede asignar: El consultor no tiene una tarifa registrada en el sistema";

function getIndexHelpers() {
  return require("../index");
}

// Actualizar asignación (registro_asignaciones)
/**
 * Actualiza los detalles, tiempos y valores de una asignación ya registrada
 */
async function actualizarRegistroAsignacion(req, res) {
  const {
    getEstadoAsignacionValues,
    normalizeTipoServicioInput,
    resolveEstadoAsignacionInput,
    resolveInternalIdFromPublicIdOrId,
    toNullableInteger,
    toNullableNumber,
    toBooleanInput,
    withPublicId,
    isGuid,
    ID_TABLES
  } = getIndexHelpers();

  const { id } = req.params;
  const {
    consultor_responsable_id,
    id_modulo,
    fecha_inicio,
    fecha_fin,
    cantidad_dias,
    horas_asignadas,
    valor_hora,
    valor_dia,
    nro_caso_interno,
    nro_caso_cliente,
    tipo_servicio,
    estado,
    observacion,
    total_pagar,
    es_costo_total
  } = req.body;

  try {
    if (!isGuid(id)) {
      return res.status(400).json({ error: "Id de asignación inválido" });
    }
    if (consultor_responsable_id && !isGuid(consultor_responsable_id)) {
      return res.status(400).json({ error: "Consultor inválido" });
    }

    const cantidadDiasNum = toNullableInteger(cantidad_dias);
    const horasAsignadasNum = toNullableNumber(horas_asignadas);
    const valorHoraNum = toNullableNumber(valor_hora);
    const valorDiaNum = toNullableNumber(valor_dia);
    const totalPagarNum = toNullableNumber(total_pagar);
    const esCostoTotalInput = toBooleanInput(es_costo_total, false);

    const estados = await getEstadoAsignacionValues();
    const estadoNormalizado = resolveEstadoAsignacionInput(estado, estados);
    if (estado && !estadoNormalizado) {
      return res.status(400).json({ error: "Estado de asignación inválido" });
    }

    const tipoServicioNormalizado = normalizeTipoServicioInput(tipo_servicio);
    if (tipo_servicio && !tipoServicioNormalizado) {
      return res.status(400).json({ error: "Tipo de servicio inválido" });
    }

    const moduloInternalId = id_modulo
      ? await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.modulo, id_modulo)
      : null;
    if (id_modulo && !moduloInternalId) {
      return res.status(404).json({ error: "Modulo no encontrado" });
    }

    // Coordinadores solo pueden editar asignaciones de sus propias consultorías
    if (normalizeValue(req.user?.rol) === "coordinador") {
      const own = await pool.query(
        `SELECT 1 FROM registro_asignaciones ra
         JOIN consultorias con ON con.id = ra.id_consultoria
         WHERE ra.public_id = $1 AND con.coordinador_responsable_id = $2`,
        [id, req.user?.id]
      );
      if (own.rowCount === 0) {
        return res.status(403).json({ error: "No tienes permisos para modificar esta asignación" });
      }
    }

    const cteQuery = `
      WITH
        c_asignacion AS (SELECT id, id_consultoria FROM registro_asignaciones WHERE public_id = $1),
        c_consultor AS (SELECT id FROM usuarios WHERE public_id = $2),
        c_modulo AS (SELECT id FROM modulo WHERE id = $3::int),
        
        c_meta AS (
          SELECT
            con.id_cliente,
            con.id_tipo_asignacion,
            (SELECT id FROM c_consultor) AS id_consultor,
            (SELECT id FROM c_modulo) AS id_modulo,
            ta.titulo AS tipo_asignacion_titulo,
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(LOWER(TRIM(COALESCE(ta.titulo, ''))), 'á', 'a'),
                      'é',
                      'e'
                    ),
                    'í',
                    'i'
                  ),
                  'ó',
                  'o'
                ),
                'ú',
                'u'
              ),
              'ü',
              'u'
            ) AS n_tipo
          FROM c_asignacion a
          JOIN consultorias con ON con.id = a.id_consultoria
          LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
        ),

        c_tarifa AS (
          SELECT
            CASE
              WHEN NOT (
                  m.n_tipo LIKE '%capacitacion%'
                  OR m.n_tipo LIKE '%training%'
                )
                AND (
                  m.n_tipo LIKE '%hora%'
                  OR m.n_tipo LIKE '%demanda%'
                  OR REPLACE(REPLACE(m.n_tipo, ' ', ''), '_', '') IN ('horas', 'porhoras', 'horaspordemanda', 'hourly')
                ) THEN true
              ELSE false
            END AS es_modalidad_horas,
            COALESCE(
              (
                SELECT tc.valor_tarifa
                FROM tarifa_consultor tc
                WHERE tc.consultor_id = m.id_consultor
                  AND tc.id_cliente = m.id_cliente
                  AND (m.id_modulo IS NULL OR tc.modulo_id = m.id_modulo)
                  AND (m.id_tipo_asignacion IS NULL OR tc.id_tipo_asignacion = m.id_tipo_asignacion)
                  AND tc.activo = true
                  AND (tc.vigencia_hasta IS NULL OR tc.vigencia_hasta >= CURRENT_DATE)
                ORDER BY tc.vigencia_desde DESC NULLS LAST, tc.id DESC
                LIMIT 1
              ),
              0
            ) AS tarifa_calculada
          FROM c_meta m
        ),
        
        c_calc AS (
          SELECT
            CASE WHEN m.n_tipo LIKE '%tiempo y costo fijo%' OR m.n_tipo LIKE '%costo fijo%' THEN true ELSE false END AS es_t_c_fijo,
            (SELECT es_modalidad_horas FROM c_tarifa) AS es_modalidad_horas,
            (SELECT tarifa_calculada FROM c_tarifa) AS tarifa_calculada
          FROM c_meta m
        ),
        
        c_valores AS (
          SELECT
            c.es_t_c_fijo,
            c.es_modalidad_horas,
            c.tarifa_calculada,
            -- Aplicamos regla de costo total; horas también se nullifican en modo costo total TCF
            CASE WHEN c.es_t_c_fijo AND $13::boolean THEN null ELSE $16::numeric END AS out_horas,
            CASE WHEN c.es_t_c_fijo AND $13::boolean THEN null ELSE $4::int END AS out_dias,
            CASE WHEN c.es_modalidad_horas THEN c.tarifa_calculada WHEN c.es_t_c_fijo AND $13::boolean THEN null ELSE $5::numeric END AS out_v_hora,
            CASE WHEN c.es_t_c_fijo AND $13::boolean THEN null ELSE $6::numeric END AS out_v_dia
          FROM c_calc c
        ),

        upd AS (
          UPDATE registro_asignaciones ra
          SET consultor_responsable_id = (CASE WHEN $2::text IS NOT NULL THEN (SELECT id FROM c_consultor) ELSE NULL END),
              id_modulo = (CASE WHEN $3::text IS NOT NULL THEN (SELECT id FROM c_modulo) ELSE NULL END),
              fecha_inicio = $7::date,
              fecha_fin = $8::date,
              horas_asignadas = (SELECT out_horas FROM c_valores),
              cantidad_dias = (SELECT out_dias FROM c_valores),
              valor_hora = (SELECT out_v_hora FROM c_valores),
              valor_dia = (SELECT out_v_dia FROM c_valores),
              nro_caso_interno = $9,
              nro_caso_cliente = $10,
              tipo_servicio = COALESCE($11, ra.tipo_servicio),
              estado = COALESCE($12::tipo_estado_asignacion, ra.estado),
              observacion = $14,
              total_pagar = $15::numeric,
              es_costo_total = (SELECT es_t_c_fijo FROM c_valores) AND $13::boolean
          WHERE id = (SELECT id FROM c_asignacion)
            AND (NOT ((SELECT es_t_c_fijo FROM c_valores) AND $13::boolean) OR $15::numeric > 0)
            AND (NOT (SELECT es_modalidad_horas FROM c_valores) OR (SELECT tarifa_calculada FROM c_valores) > 0)
            AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM c_consultor))
            AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM c_modulo))
          RETURNING ra.*
        )
      
      SELECT
        u.*,
        
        -- Diagnostic flags incase of 0 rows returned
        (SELECT id FROM c_asignacion) AS diag_asignacion,
        (SELECT id FROM c_consultor) AS diag_consultor,
        (SELECT id FROM c_modulo) AS diag_modulo,
        (SELECT es_t_c_fijo FROM c_calc) AS diag_es_tcf,
        (SELECT es_modalidad_horas FROM c_tarifa) AS diag_es_modalidad_horas,
        (SELECT tarifa_calculada FROM c_tarifa) AS diag_tarifa_calc
      FROM upd u RIGHT JOIN c_asignacion ON true
    `;

    const client = await pool.connect();
    let txStarted = false;
    let result;
    try {
      await client.query("BEGIN");
      txStarted = true;
      result = await client.query(cteQuery, [
      id,                               // $1
      consultor_responsable_id || null, // $2
      moduloInternalId || null,         // $3
      cantidadDiasNum,                  // $4
      valorHoraNum,                     // $5
      valorDiaNum,                      // $6
      fecha_inicio || null,             // $7
      fecha_fin || null,                // $8
      nro_caso_interno || null,         // $9
      nro_caso_cliente || null,         // $10
      tipoServicioNormalizado || null,  // $11
      estadoNormalizado || null,        // $12
      esCostoTotalInput,                // $13
      observacion || null,              // $14
      totalPagarNum,                    // $15
      horasAsignadasNum                 // $16
      ]);
      await client.query("COMMIT");
      txStarted = false;
    } catch (txErr) {
      if (txStarted) await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    const row = result.rows[0];

    if (!row || !row.id) {
      // Check diagnostics
      if (!row) return res.status(404).json({ error: "Asignación o referencias no encontradas" });
      if (!row.diag_asignacion) return res.status(404).json({ error: "Asignación no encontrada" });
      if (consultor_responsable_id && !row.diag_consultor) return res.status(404).json({ error: "Consultor no encontrado" });
      if (id_modulo && !row.diag_modulo) return res.status(404).json({ error: "Módulo no encontrado" });

      if (row.diag_es_modalidad_horas && !(Number(row.diag_tarifa_calc) > 0)) {
        return res.status(400).json({ error: ERROR_TARIFA_HORAS });
      }
      if (row.diag_es_tcf && esCostoTotalInput && !(Number(totalPagarNum) > 0)) {
        return res.status(400).json({ error: "Debes indicar un presupuesto total mayor a 0 para costo total." });
      }
      return res.status(500).json({ error: "Error desconocido al actualizar asignación" });
    }

    delete row.diag_asignacion;
    delete row.diag_consultor;
    delete row.diag_modulo;
    delete row.diag_es_tcf;
    delete row.diag_es_modalidad_horas;
    delete row.diag_tarifa_calc;

    res.json(withPublicId(row));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar asignación" });
  }
}

// Cerrar asignación (soft delete operativo)
/**
 * Finaliza o cierra de manera operativa una asignación de Mesa o Fábrica
 */
async function eliminarRegistroAsignacion(req, res) {
  const {
    getEstadoAsignacionValues,
    getMesaFabricaScope,
    withPublicId
  } = getIndexHelpers();

  const { id } = req.params;
  try {
    const estados = await getEstadoAsignacionValues();
    const role = normalizeValue(req.user?.rol);
    const meta = await pool.query(
      `
       WITH c_asignacion AS (SELECT id FROM registro_asignaciones WHERE public_id = $1)
       SELECT
         ra.id,
         con.coordinador_responsable_id,
         con.id_tipo_asignacion,
         ta.titulo AS tipo_asignacion_titulo
       FROM registro_asignaciones ra
       JOIN consultorias con ON con.id = ra.id_consultoria
       LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
       WHERE ra.id = (SELECT id FROM c_asignacion)
      `,
      [id]
    );
    if (!meta.rows.length) {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }
    const info = meta.rows[0];
    if (role === "coordinador" && String(info.coordinador_responsable_id || "") !== String(req.user?.id || "")) {
      return res.status(404).json({ error: "Asignación no encontrada o sin permisos para cerrarla" });
    }
    const scope = getMesaFabricaScope(info.id_tipo_asignacion, info.tipo_asignacion_titulo);
    if (!scope) {
      return res.status(400).json({ error: "Solo se pueden cerrar asignaciones de Mesa/Fábrica." });
    }
    const result = await pool.query(
      `UPDATE registro_asignaciones
       SET estado = $1::tipo_estado_asignacion,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [estados.cerrado, info.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Asignación no encontrada o sin permisos para cerrarla" });
    }

    res.json(withPublicId(result.rows[0]));
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al cerrar asignación" });
  }
}

// Crear asignación (registro_asignaciones)
/**
 * Registra una nueva asignación para un consultor y le envía una notificación
 */
async function crearRegistroAsignacion(req, res) {
  const {
    getEstadoAsignacionValues,
    normalizeTipoServicioInput,
    resolveInternalIdFromPublicIdOrId,
    toNullableInteger,
    toNullableNumber,
    toBooleanInput,
    sendEmailSafe,
    buildPortalUrl,
    getGraphContext,
    buildEmailLayout,
    isGuid,
    ID_TABLES
  } = getIndexHelpers();

  const {
    id_consultoria,
    id_modulo,
    consultor_responsable_id,
    fecha_inicio,
    fecha_fin,
    cantidad_dias,
    horas_asignadas,
    valor_hora,
    valor_dia,
    tipo_servicio,
    total_pagar,
    es_costo_total
  } = req.body;

  try {
    if (!isGuid(id_consultoria) || !isGuid(consultor_responsable_id)) {
      return res.status(400).json({ error: "Consultoría o consultor inválido" });
    }

    const cantidadDiasNum = toNullableInteger(cantidad_dias);
    const horasAsignadasNum = toNullableNumber(horas_asignadas);
    const valorHoraInput = toNullableNumber(valor_hora);
    const valorDiaInput = toNullableNumber(valor_dia);
    const totalPagarInput = toNullableNumber(total_pagar);
    const esCostoTotalInput = toBooleanInput(es_costo_total, false);
    const estados = await getEstadoAsignacionValues();

    if (!id_consultoria || !consultor_responsable_id || !id_modulo) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const tipoServicioNormalizado = normalizeTipoServicioInput(tipo_servicio || "Servicio");
    if (!tipoServicioNormalizado) {
      return res.status(400).json({ error: "Tipo de servicio inválido" });
    }

    const moduloInternalId = await resolveInternalIdFromPublicIdOrId(pool, ID_TABLES.modulo, id_modulo);
    if (!moduloInternalId) {
      return res.status(404).json({ error: "Modulo no encontrado" });
    }

    // Coordinadores solo pueden asignar en sus propias consultorías
    if (normalizeValue(req.user?.rol) === "coordinador") {
      const own = await pool.query(
        `SELECT 1 FROM consultorias WHERE public_id = $1 AND coordinador_responsable_id = $2 AND activo = true`,
        [id_consultoria, req.user?.id]
      );
      if (own.rowCount === 0) {
        return res.status(403).json({ error: "No tienes permisos para asignar en esta consultoría" });
      }
    }

    // CTE monumental que:
    // 1. Resuelve IDs (consultoria, consultor, modulo)
    // 2. Extrae meta (cliente, tipo_asignacion)
    // 3. Valida duplicados de asignación activa
    // 4. Calcula tarifas si es necesario o aplica cálculos de presupuesto
    // 5. Inserta
    const cteQuery = `
      WITH 
        c_consultoria AS (
          SELECT
            con.id,
            con.id_cliente,
            con.id_tipo_asignacion,
            con.coordinador_responsable_id,
            ta.titulo AS tipo_asig_titulo
          FROM consultorias con
          LEFT JOIN tipo_asignacion ta ON ta.id = con.id_tipo_asignacion
          WHERE con.public_id = $1::uuid AND con.activo = true
        ),
        c_consultor AS (SELECT id, email, nombre_usuario FROM usuarios WHERE public_id = $2::uuid),
        c_modulo AS (SELECT id, titulo FROM modulo WHERE id = $3::int),
        c_estados AS (
          SELECT $4::tipo_estado_asignacion AS st_abierto, $5::tipo_estado_asignacion AS st_proceso
        ),
        
        -- Validar duplicidad activa en la misma consultoría, consultor y módulo.
        -- Para asignaciones con fechas, solo bloquea si el rango se solapa.
        c_dup AS (
          SELECT ra.id
          FROM registro_asignaciones ra
          JOIN c_consultoria con ON ra.id_consultoria = con.id
          JOIN c_consultor uc ON ra.consultor_responsable_id = uc.id
          JOIN c_modulo m ON ra.id_modulo = m.id
          WHERE ra.estado IN ((SELECT st_abierto FROM c_estados), (SELECT st_proceso FROM c_estados))
            AND daterange(
              COALESCE(ra.fecha_inicio, DATE '-infinity'),
              COALESCE(ra.fecha_fin, DATE 'infinity'),
              '[]'
            ) && daterange(
              COALESCE($13::date, DATE '-infinity'),
              COALESCE($14::date, DATE 'infinity'),
              '[]'
            )
          LIMIT 1
        ),
        
        -- Metadatos procesados
        c_meta AS (
          SELECT 
            (SELECT id FROM c_consultoria) AS id_consultoria,
            (SELECT id_cliente FROM c_consultoria) AS id_cliente,
            (SELECT id_tipo_asignacion FROM c_consultoria) AS id_tipo_asignacion,
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(LOWER(TRIM(COALESCE((SELECT tipo_asig_titulo FROM c_consultoria), ''))), 'á', 'a'),
                      'é',
                      'e'
                    ),
                    'í',
                    'i'
                  ),
                  'ó',
                  'o'
                ),
                'ú',
                'u'
              ),
              'ü',
              'u'
            ) AS n_tipo,
            (SELECT id FROM c_consultor) AS id_consultor,
            (SELECT id FROM c_modulo) AS id_modulo
        ),
        
        -- Obtener tarifa vigente si aplica (es_mesa_o_fabrica)
        c_tarifa AS (
          SELECT 
            m.n_tipo,
            m.id_consultoria,
            m.id_consultor,
            m.id_modulo,
            CASE 
              WHEN m.id_tipo_asignacion IN (5, 6)
                OR m.n_tipo LIKE '%mesa%'
                OR m.n_tipo LIKE '%service desk%'
                OR m.n_tipo LIKE '%servicedesk%'
                OR m.n_tipo LIKE '%fabrica%' THEN true
              ELSE false
            END AS es_mesa_fabrica,
            CASE 
              WHEN m.n_tipo LIKE '%full%'
                OR m.n_tipo LIKE '%part%'
                OR m.n_tipo LIKE '%mensual%'
                OR m.n_tipo LIKE '%tiempo completo%'
                OR m.n_tipo LIKE '%tiempocompleto%'
                OR m.n_tipo LIKE '%medio tiempo%'
                OR m.n_tipo LIKE '%mediotiempo%' THEN true
              ELSE false
            END AS es_mensual,
            CASE 
              WHEN m.n_tipo LIKE '%tiempo y costo fijo%' OR m.n_tipo LIKE '%costo fijo%' THEN true
              ELSE false
            END AS es_t_c_fijo,
            CASE 
              WHEN m.n_tipo LIKE '%horas por demanda%' OR m.n_tipo LIKE '%horaspordemanda%' OR m.n_tipo LIKE '%demanda%' THEN true
              ELSE false
            END AS es_h_demanda,
            CASE
              WHEN NOT (
                  m.n_tipo LIKE '%capacitacion%'
                  OR m.n_tipo LIKE '%training%'
                )
                AND (
                  m.n_tipo LIKE '%hora%'
                  OR m.n_tipo LIKE '%demanda%'
                  OR REPLACE(REPLACE(m.n_tipo, ' ', ''), '_', '') IN ('horas', 'porhoras', 'horaspordemanda', 'hourly')
                ) THEN true
              ELSE false
            END AS es_modalidad_horas,
            COALESCE(
              (
                SELECT tc.valor_tarifa
                FROM tarifa_consultor tc
                WHERE tc.consultor_id = m.id_consultor
                  AND tc.id_cliente = m.id_cliente
                  AND (m.id_modulo IS NULL OR tc.modulo_id = m.id_modulo)
                  AND (m.id_tipo_asignacion IS NULL OR tc.id_tipo_asignacion = m.id_tipo_asignacion)
                  AND tc.activo = true
                  AND (tc.vigencia_hasta IS NULL OR tc.vigencia_hasta >= CURRENT_DATE)
                ORDER BY tc.vigencia_desde DESC
                LIMIT 1
              ),
              0
            ) AS tarifa_calculada
          FROM c_meta m
        ),
        
        -- Cálculos de valores finales
        c_valores AS (
          SELECT 
            t.es_mesa_fabrica,
            t.es_mensual,
            t.es_t_c_fijo,
            t.es_h_demanda,
            t.es_modalidad_horas,
            t.tarifa_calculada,
            
            -- Lógica estricta de variables adaptada a postgres
            CASE 
              WHEN t.es_h_demanda THEN null
              WHEN t.es_t_c_fijo AND $12::boolean THEN null  -- esA_costo_totalFinal
              ELSE $6::numeric -- horas_asignadas
            END AS out_horas,
            
            CASE 
              WHEN t.es_h_demanda THEN null
              ELSE $7::int -- cantidad_dias
            END AS out_dias,
            
            CASE 
              WHEN t.es_mesa_fabrica OR t.es_modalidad_horas THEN t.tarifa_calculada
              WHEN t.es_t_c_fijo AND $12::boolean THEN null
              ELSE $8::numeric -- valor_hora
            END AS out_v_hora,
            
            CASE 
              WHEN t.es_mesa_fabrica THEN null
              WHEN t.es_t_c_fijo AND $12::boolean THEN null
              ELSE $9::numeric -- valor_dia
            END AS out_v_dia,
            
            CASE 
              WHEN t.es_h_demanda THEN 0
              WHEN t.es_mesa_fabrica THEN COALESCE($10::numeric, ($6::numeric * t.tarifa_calculada))
              WHEN t.es_t_c_fijo AND $12::boolean THEN ROUND($10::numeric, 2)
              WHEN NOT t.es_mensual AND $10::numeric IS NULL AND $8::numeric IS NOT NULL AND $6::numeric IS NOT NULL THEN ($8::numeric * $6::numeric)
              ELSE $10::numeric
            END AS out_t_pagar
          FROM c_tarifa t
        ),
        
        insertar AS (
          INSERT INTO registro_asignaciones (
            id_consultoria, id_modulo, consultor_responsable_id, fecha_inicio, fecha_fin,
            cantidad_dias, horas_asignadas, valor_hora, valor_dia, tipo_servicio, total_pagar, es_costo_total, estado, aprobar_coordinador
          )
          SELECT 
            (SELECT id FROM c_consultoria),
            (SELECT id FROM c_modulo),
            (SELECT id FROM c_consultor),
            $13::date, -- fecha_inicio
            $14::date, -- fecha_fin
            v.out_dias,
            v.out_horas,
            v.out_v_hora,
            v.out_v_dia,
            $11, -- tipo_servicio
            v.out_t_pagar,
            ($12::boolean AND v.es_t_c_fijo) AS es_costo_total_f,
            (SELECT st_abierto FROM c_estados),
            'Pendiente'
          FROM c_valores v
          WHERE EXISTS (SELECT 1 FROM c_consultoria)
            AND EXISTS (SELECT 1 FROM c_consultor)
            AND EXISTS (SELECT 1 FROM c_modulo)
            AND NOT EXISTS (SELECT 1 FROM c_dup)
            -- Validaciones que bloquearían el insert:
            AND (NOT v.es_mesa_fabrica OR v.tarifa_calculada > 0)
            AND (NOT v.es_modalidad_horas OR v.tarifa_calculada > 0)
            AND (NOT (v.es_t_c_fijo AND $12::boolean) OR $10::numeric > 0)
          RETURNING public_id AS id, 
                    id_consultoria,
                    id_modulo,
                    consultor_responsable_id,
                    fecha_inicio,
                    fecha_fin,
                    cantidad_dias,
                    horas_asignadas,
                    valor_hora,
                    valor_dia,
                    tipo_servicio,
                    total_pagar,
                    es_costo_total,
                    estado,
                    created_at,
                    updated_at
        )

      SELECT 
        i.*,
        (SELECT email FROM c_consultor) AS email_consultor,
        (SELECT nombre_usuario FROM c_consultor) AS nombre_consultor,
        (SELECT titulo FROM modulo WHERE id = i.id_modulo) AS nombre_modulo,
        (SELECT cli.titulo FROM clientes cli JOIN consultorias c ON c.id_cliente = cli.id WHERE c.id = i.id_consultoria) AS nombre_cliente,
        (SELECT ta.titulo FROM tipo_asignacion ta JOIN consultorias c ON c.id_tipo_asignacion = ta.id WHERE c.id = i.id_consultoria) AS tipo_asignacion,
        (SELECT u.nombre_usuario FROM usuarios u JOIN consultorias c ON c.coordinador_responsable_id = u.id WHERE c.id = i.id_consultoria) AS nombre_coordinador,
        
        -- Diagnostic flags incase of 0 rows returned
        (SELECT id FROM c_consultoria) AS diag_consultoria,
        (SELECT id FROM c_consultor) AS diag_consultor,
        (SELECT id FROM c_modulo) AS diag_modulo,
        (SELECT id FROM c_dup) AS diag_dup,
        (SELECT tarifa_calculada FROM c_tarifa) AS diag_tarifa_calc,
        (SELECT es_mesa_fabrica FROM c_tarifa) AS diag_es_mf,
        (SELECT es_t_c_fijo FROM c_tarifa) AS diag_es_tcf,
        (SELECT es_modalidad_horas FROM c_tarifa) AS diag_es_modalidad_horas
      FROM insertar i RIGHT JOIN c_consultoria ON true
    `;

    const client = await pool.connect();
    let txStarted = false;
    let result;
    try {
      await client.query("BEGIN");
      txStarted = true;
      result = await client.query(cteQuery, [
      id_consultoria,          // $1
      consultor_responsable_id,// $2
      moduloInternalId,        // $3
      estados.abierto,         // $4
      estados.proceso,         // $5
      horasAsignadasNum,       // $6
      cantidadDiasNum,         // $7
      valorHoraInput,          // $8
      valorDiaInput,           // $9
      totalPagarInput,         // $10
      tipoServicioNormalizado, // $11
      esCostoTotalInput,       // $12
      fecha_inicio || null,    // $13
      fecha_fin || null        // $14
      ]);
      await client.query("COMMIT");
      txStarted = false;
    } catch (txErr) {
      if (txStarted) await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    const row = result.rows[0];

    // If no row or an empty row without our inserted ID was returned, it means validation failed inside CTE
    if (!row || !row.id) {
      // Using the diag flags from RIGHT JOIN
      if (!row) return res.status(404).json({ error: "Consultoría o referencias no encontradas" });
      if (!row.diag_consultoria) return res.status(404).json({ error: "Consultoría no válida" });
      if (!row.diag_consultor) return res.status(404).json({ error: "Consultor no encontrado" });
      if (!row.diag_modulo) return res.status(404).json({ error: "Módulo no encontrado" });
      if (row.diag_dup) {
        return res.status(400).json({
          error: "Ya existe una asignación activa para este consultor y módulo en la consultoría seleccionada (mismo período)."
        });
      }

      if (row.diag_es_modalidad_horas && !(Number(row.diag_tarifa_calc) > 0)) {
        return res.status(400).json({ error: ERROR_TARIFA_HORAS });
      }
      if (row.diag_es_mf && !(Number(row.diag_tarifa_calc) > 0)) {
        return res.status(400).json({ error: "No existe una tarifa vigente para este consultor, cliente, módulo y tipo de asignación." });
      }
      if (row.diag_es_tcf && esCostoTotalInput && !(Number(totalPagarInput) > 0)) {
        return res.status(400).json({ error: "Debes indicar un presupuesto total mayor a 0 para costo total." });
      }
      return res.status(500).json({ error: "Error desconocido al procesar asignación" });
    }

    const created = row;

    // Notificación best-effort: no debe revertir ni fallar la creación.
    try {
      if (created.email_consultor) {
        const portalUrl = buildPortalUrl("mis-asignaciones-consultor");
        await sendEmailSafe({
          ...getGraphContext(req),
          to: created.email_consultor,
          subject: `🚀 Nueva asignación: ${created.nombre_modulo || "Proyecto"} - ${created.nombre_cliente}`,
          text:
            `Hola ${created.nombre_consultor || ""},\n` +
            `Tienes una nueva asignación.\n` +
            `Cliente: ${created.nombre_cliente}\n` +
            `Tipo: ${created.tipo_asignacion || "N/A"}\n` +
            `Módulo: ${created.nombre_modulo || "N/A"}\n` +
            `Coordinador: ${created.nombre_coordinador || "N/A"}\n` +
            `Ingresa al portal: ${portalUrl}\n`,
          html: buildEmailLayout({
            title: "Nueva asignación de actividad",
            intro: `Hola <strong>${created.nombre_consultor || "Consultor"}</strong>, has sido asignado a una nueva actividad de consultoría.`,
            blocks: [
              { label: "Cliente", value: created.nombre_cliente },
              { label: "Módulo/Tecnología", value: created.nombre_modulo || "N/A" },
              { label: "Tipo de asignación", value: created.tipo_asignacion || "N/A" },
              { label: "Coordinador", value: created.nombre_coordinador || "N/A" }
            ],
            ctaLabel: "Ver asignación en el portal",
            ctaUrl: portalUrl
          })
        });
      }
    } catch (mailErr) {
      console.error("Error notificando asignación al consultor:", mailErr?.message || mailErr);
    }

    // cleanup response
    delete created.email_consultor;
    delete created.nombre_consultor;
    delete created.nombre_modulo;
    delete created.nombre_cliente;
    delete created.tipo_asignacion;
    delete created.nombre_coordinador;
    delete created.diag_consultoria;
    delete created.diag_consultor;
    delete created.diag_modulo;
    delete created.diag_dup;
    delete created.diag_tarifa_calc;
    delete created.diag_es_mf;
    delete created.diag_es_tcf;
    delete created.diag_es_modalidad_horas;

    res.json(created);
  } catch (err) {
    if (err?.code === "PUBLIC_ID_NOT_FOUND") {
      return res.status(400).json({ error: "Consultoría, consultor o módulo no válido" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al crear asignación" });
  }
}

module.exports = {
  actualizarRegistroAsignacion,
  eliminarRegistroAsignacion,
  crearRegistroAsignacion
};
