const { pool } = require("../db");
const { calcularRetenciones } = require("./calculadoraRetenciones.service");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONCEPTOS = new Set([
  "consultor",
  "honorarios",
  "compra",
  "servicio",
  "arrendamiento_inmueble",
  "arrendamiento_mueble"
]);
const DOCUMENTOS_PAGO = new Set(["cuenta_cobro", "factura_electronica", "cualquiera"]);

class OperacionContableError extends Error {
  constructor(message, statusCode = 400, code = "CONTABILIDAD_VALIDATION") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function uuid(value, field = "id") {
  const result = text(value, 50);
  if (!UUID_RE.test(result)) throw new OperacionContableError(`${field} no es válido`);
  return result;
}

function money(value, field, { required = true } = {}) {
  if (!required && (value === "" || value === null || value === undefined)) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new OperacionContableError(`${field} debe ser un valor mayor o igual a cero`);
  }
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function percent(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new OperacionContableError(`${field} debe estar entre 0 y 100`);
  }
  return number;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["true", "1", "si", "sí", "yes"].includes(text(value).toLowerCase());
}

function date(value, field, { required = true } = {}) {
  const result = text(value, 10);
  if (!result && !required) return null;
  const parsed = new Date(`${result}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== result
  ) {
    throw new OperacionContableError(`${field} no es una fecha válida`);
  }
  return result;
}

function handleError(res, error, action) {
  if (error instanceof OperacionContableError) {
    return res.status(error.statusCode).json({ error: error.message, codigo: error.code });
  }
  if (error?.code === "23505") {
    const duplicateInvoice = String(error.constraint || "").includes("facturas_proveedores");
    return res.status(409).json({
      error: duplicateInvoice
        ? "Ya existe una factura con ese número para el beneficiario"
        : "Ya existe una regla con el mismo concepto, documento y fecha inicial",
      codigo: duplicateInvoice ? "FACTURA_DUPLICADA" : "REGLA_DUPLICADA"
    });
  }
  console.error(`[contabilidad] Error ${action}:`, error);
  return res.status(500).json({ error: `No fue posible completar la operación: ${action}` });
}

function parseMonths(value) {
  const months = text(value, 100)
    .split(",")
    .map(Number)
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 12);
  return [...new Set(months)];
}

async function listarProyecciones(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const conditions = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace("?", `$${params.length}`));
    };
    if (req.query.anio) add("pp.anio = ?", Number(req.query.anio));
    const months = parseMonths(req.query.meses || req.query.mes);
    if (months.length) add("pp.mes = ANY(?::smallint[])", months);
    if ([1, 2].includes(Number(req.query.quincena))) add("pp.quincena = ?", Number(req.query.quincena));
    if (text(req.query.estado)) add("pp.estado = ?", text(req.query.estado, 20));
    if (text(req.query.desde)) add("pp.fecha_pago_programada >= ?::date", date(req.query.desde, "desde"));
    if (text(req.query.hasta)) add("pp.fecha_pago_programada <= ?::date", date(req.query.hasta, "hasta"));
    if (text(req.query.buscar)) {
      params.push(`%${text(req.query.buscar, 120)}%`);
      conditions.push(`EXISTS (
        SELECT 1 FROM proyeccion_pagos_detalle dx
        JOIN personas px ON px.id = dx.persona_id
        WHERE dx.proyeccion_id = pp.id
          AND (px.numero_documento ILIKE $${params.length}
            OR BTRIM(CONCAT_WS(' ', px.nombre, px.apellidos)) ILIKE $${params.length})
      )`);
    }
    const result = await dbPool.query(
      `SELECT pp.public_id::text AS id, pp.anio, pp.mes, pp.quincena,
              pp.fecha_pago_programada, pp.estado, pp.trm_oficial,
              pp.created_at, pp.revisado_at, pp.aprobado_at, pp.pagado_at,
              COUNT(d.id)::int AS total_pagos,
              COALESCE(SUM(d.subtotal), 0)::numeric AS subtotal,
              COALESCE(SUM(d.iva), 0)::numeric AS iva,
              COALESCE(SUM(d.anticipo), 0)::numeric AS anticipos,
              COALESCE(SUM(d.subtotal + d.iva - d.anticipo - d.valor_neto), 0)::numeric AS retenciones,
              COALESCE(SUM(d.valor_neto), 0)::numeric AS total_neto
         FROM proyeccion_pagos pp
         LEFT JOIN proyeccion_pagos_detalle d ON d.proyeccion_id = pp.id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        GROUP BY pp.id
        ORDER BY pp.fecha_pago_programada DESC, pp.id DESC
        LIMIT 120`,
      params
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return handleError(res, error, "consultando las programaciones");
  }
}

async function buscarBeneficiarios(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const buscar = text(req.query.buscar || req.query.documento, 120);
    if (buscar.length < 2) return res.json({ items: [] });
    const result = await dbPool.query(
      `SELECT p.public_id::text AS id, p.numero_documento,
              BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) AS nombre,
              di.titulo AS tipo_documento, di.codigo_bancario AS tipo_documento_bancario,
              b.titulo AS banco, b.codigo_conversor AS codigo_banco,
              tcb.titulo AS tipo_cuenta, tcb.tipo_transaccion,
              p.numero_cuenta, COALESCE(p.correo_electronico, p.correo_silver) AS email,
              p.factura_en_colombia, p.facturador_electronico, p.declarante_renta,
              p.es_gran_contribuyente, p.es_autorretenedor, p.es_regimen_simple,
              p.es_entidad_sin_animo_lucro, p.es_economia_naranja,
              p.ciudad_residencia,
              (p.banco_id IS NOT NULL AND p.tipo_cuenta_id IS NOT NULL
                AND NULLIF(BTRIM(p.numero_cuenta), '') IS NOT NULL) AS datos_bancarios_completos
         FROM personas p
         LEFT JOIN documento_identidad di ON di.id = p.tipo_documento_id
         LEFT JOIN bancos b ON b.id = p.banco_id
         LEFT JOIN tipo_cuenta_bancaria tcb ON tcb.id = p.tipo_cuenta_id
        WHERE p.estado = 'activo'
          AND (p.numero_documento ILIKE $1
            OR BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) ILIKE $1)
        ORDER BY CASE WHEN p.numero_documento = $2 THEN 0 ELSE 1 END,
                 BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos))
        LIMIT 20`,
      [`%${buscar}%`, buscar]
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return handleError(res, error, "buscando beneficiarios");
  }
}

async function actualizarPerfilTributario(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const id = uuid(req.params.id);
    const fields = [
      "factura_en_colombia",
      "facturador_electronico",
      "declarante_renta",
      "es_gran_contribuyente",
      "es_autorretenedor",
      "es_regimen_simple",
      "es_entidad_sin_animo_lucro",
      "es_economia_naranja"
    ];
    const updates = [];
    const params = [];
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        params.push(bool(req.body[field]));
        updates.push(`${field} = $${params.length}`);
      }
    }
    if (!updates.length) throw new OperacionContableError("No se enviaron cambios del perfil tributario");
    params.push(id);
    const result = await dbPool.query(
      `UPDATE personas SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP
        WHERE public_id = $${params.length}
        RETURNING public_id::text AS id, numero_documento, factura_en_colombia,
                  facturador_electronico, declarante_renta, es_gran_contribuyente,
                  es_autorretenedor, es_regimen_simple, es_entidad_sin_animo_lucro,
                  es_economia_naranja, updated_at`,
      params
    );
    if (!result.rows[0]) throw new OperacionContableError("Beneficiario no encontrado", 404);
    return res.json(result.rows[0]);
  } catch (error) {
    return handleError(res, error, "actualizando el perfil tributario");
  }
}

function mapFactura(row) {
  return {
    id: row.id,
    persona_id: row.persona_id,
    documento: row.numero_documento,
    beneficiario: row.beneficiario,
    numero_factura: row.numero_factura,
    fecha_emision: row.fecha_emision,
    fecha_vencimiento: row.fecha_vencimiento,
    fecha_pago_preferida: row.fecha_pago_preferida,
    concepto: row.concepto,
    ciudad_servicio: row.ciudad_servicio,
    subtotal: Number(row.subtotal || 0),
    tiene_iva: row.tiene_iva,
    iva: Number(row.iva || 0),
    anticipo: Number(row.anticipo || 0),
    tipo_gasto: row.tipo_gasto,
    moneda: row.moneda,
    documento_soporte: row.documento_soporte || {},
    estado: row.estado,
    proyeccion_id: row.proyeccion_id,
    fecha_pago: row.fecha_pago,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

const FACTURA_SELECT = `
  SELECT fp.public_id::text AS id, p.public_id::text AS persona_id,
         p.numero_documento, BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) AS beneficiario,
         fp.numero_factura, fp.fecha_emision, fp.fecha_vencimiento, fp.fecha_pago_preferida,
         fp.concepto, fp.ciudad_servicio, fp.subtotal, fp.tiene_iva, fp.iva, fp.anticipo,
         fp.tipo_gasto, fp.moneda, fp.documento_soporte, fp.estado,
         pp.public_id::text AS proyeccion_id, pp.pagado_at AS fecha_pago,
         fp.created_at, fp.updated_at
    FROM facturas_proveedores fp
    JOIN personas p ON p.id = fp.persona_id
    LEFT JOIN proyeccion_pagos pp ON pp.id = fp.proyeccion_pago_id`;

async function listarFacturas(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const params = [];
    const conditions = [];
    if (text(req.query.estado)) {
      params.push(text(req.query.estado, 20));
      conditions.push(`fp.estado = $${params.length}`);
    }
    if (text(req.query.buscar)) {
      params.push(`%${text(req.query.buscar, 120)}%`);
      conditions.push(`(fp.numero_factura ILIKE $${params.length}
        OR p.numero_documento ILIKE $${params.length}
        OR BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) ILIKE $${params.length})`);
    }
    const result = await dbPool.query(
      `${FACTURA_SELECT}
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY fp.fecha_emision DESC, fp.id DESC LIMIT 150`,
      params
    );
    return res.json({ items: result.rows.map(mapFactura) });
  } catch (error) {
    return handleError(res, error, "consultando las facturas");
  }
}

async function resolvePersonaId(client, body) {
  const personaId = text(body.persona_id, 50);
  const documento = text(body.documento || body.numero_documento, 50);
  if (!personaId && !documento) throw new OperacionContableError("Selecciona un beneficiario");
  const result = personaId
    ? await client.query(`SELECT id, public_id::text, factura_en_colombia,
        facturador_electronico, declarante_renta, es_gran_contribuyente,
        es_autorretenedor, es_regimen_simple, es_entidad_sin_animo_lucro,
        es_economia_naranja, ciudad_residencia
        FROM personas WHERE public_id = $1 LIMIT 1`, [uuid(personaId, "persona_id")])
    : await client.query(`SELECT id, public_id::text, factura_en_colombia,
        facturador_electronico, declarante_renta, es_gran_contribuyente,
        es_autorretenedor, es_regimen_simple, es_entidad_sin_animo_lucro,
        es_economia_naranja, ciudad_residencia
        FROM personas WHERE numero_documento = $1 LIMIT 1`, [documento]);
  if (!result.rows[0]) throw new OperacionContableError("Beneficiario no encontrado", 404);
  return result.rows[0];
}

function validarFactura(body = {}) {
  const tipoGasto = text(body.tipo_gasto, 40).toLowerCase();
  if (!CONCEPTOS.has(tipoGasto)) throw new OperacionContableError("El concepto contable no es válido");
  const numeroFactura = text(body.numero_factura, 100);
  if (!numeroFactura) throw new OperacionContableError("El número de factura es obligatorio");
  const concepto = text(body.concepto, 1000);
  if (!concepto) throw new OperacionContableError("El detalle de la factura es obligatorio");
  const subtotal = money(body.subtotal, "subtotal");
  const tieneIva = bool(body.tiene_iva, Number(body.iva || 0) > 0);
  const iva = tieneIva ? (money(body.iva, "iva", { required: false }) || 0) : 0;
  const anticipo = money(body.anticipo ?? 0, "anticipo");
  if (anticipo > subtotal + iva) throw new OperacionContableError("El anticipo supera el total de la factura");
  const soporteUrl = text(body.soporte_url, 1000);
  const soporte = soporteUrl
    ? { url: soporteUrl }
    : (body.documento_soporte && typeof body.documento_soporte === "object"
      ? body.documento_soporte
      : {});
  const fechaEmision = date(body.fecha_emision, "fecha_emision");
  const fechaVencimiento = date(body.fecha_vencimiento, "fecha_vencimiento", { required: false });
  const fechaPagoPreferida = date(body.fecha_pago_preferida, "fecha_pago_preferida", { required: false });
  if (fechaVencimiento && fechaVencimiento < fechaEmision) {
    throw new OperacionContableError("La fecha de vencimiento no puede ser anterior a la emisión");
  }
  if (fechaPagoPreferida && fechaPagoPreferida < fechaEmision) {
    throw new OperacionContableError("La fecha de pago no puede ser anterior a la emisión");
  }
  return {
    numeroFactura,
    fechaEmision,
    fechaVencimiento,
    fechaPagoPreferida,
    concepto,
    ciudadServicio: text(body.ciudad_servicio, 100),
    subtotal,
    tieneIva,
    iva,
    anticipo,
    tipoGasto,
    moneda: text(body.moneda || "COP", 3).toUpperCase(),
    soporte
  };
}

async function calcularIvaFactura(client, factura, persona) {
  const fechaAplicacion = factura.fechaPagoPreferida || factura.fechaEmision;
  const ruleResult = await client.query(
    `SELECT base_minima, porcentaje_fuente_declarante, porcentaje_fuente_no_declarante,
            porcentaje_iva, porcentaje_reteiva, base_reteica, porcentaje_reteica
       FROM contabilidad_reglas_retencion
      WHERE concepto = $1 AND activo = TRUE
        AND tipo_documento_pago IN ('factura_electronica', 'cualquiera')
        AND vigencia_desde <= $2::date
        AND (vigencia_hasta IS NULL OR vigencia_hasta >= $2::date)
      ORDER BY CASE WHEN tipo_documento_pago = 'factura_electronica' THEN 0 ELSE 1 END,
               vigencia_desde DESC, id DESC LIMIT 1`,
    [factura.tipoGasto, fechaAplicacion]
  );
  const calculo = calcularRetenciones({
    subtotal: factura.subtotal,
    tiene_iva: factura.tieneIva,
    anticipo: factura.anticipo,
    tipo_pago: factura.tipoGasto,
    tipo_documento_pago: "factura_electronica",
    ciudad_servicio: factura.ciudadServicio,
    persona,
    regla: ruleResult.rows[0] || {}
  });
  return calculo.iva;
}

async function crearFactura(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  let client;
  try {
    const factura = validarFactura(req.body || {});
    client = await dbPool.connect();
    await client.query("BEGIN");
    const persona = await resolvePersonaId(client, req.body || {});
    factura.iva = await calcularIvaFactura(client, factura, persona);
    if (factura.anticipo > factura.subtotal + factura.iva) {
      throw new OperacionContableError("El anticipo supera el total calculado de la factura");
    }
    const result = await client.query(
      `INSERT INTO facturas_proveedores (
        persona_id, numero_factura, fecha_emision, fecha_vencimiento,
        fecha_pago_preferida, concepto, ciudad_servicio, subtotal, tiene_iva,
        iva, anticipo, tipo_gasto, moneda, documento_soporte, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
      RETURNING public_id::text AS id`,
      [
        persona.id, factura.numeroFactura, factura.fechaEmision, factura.fechaVencimiento,
        factura.fechaPagoPreferida, factura.concepto, factura.ciudadServicio,
        factura.subtotal, factura.tieneIva, factura.iva, factura.anticipo,
        factura.tipoGasto, factura.moneda, JSON.stringify(factura.soporte), req.user.id
      ]
    );
    await client.query("COMMIT");
    return res.status(201).json({ id: result.rows[0].id, estado: "Pendiente" });
  } catch (error) {
    if (client) try { await client.query("ROLLBACK"); } catch (_) { }
    return handleError(res, error, "creando la factura");
  } finally {
    if (client) client.release();
  }
}

async function actualizarFactura(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  let client;
  try {
    const id = uuid(req.params.id);
    const factura = validarFactura(req.body || {});
    client = await dbPool.connect();
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT id, estado FROM facturas_proveedores WHERE public_id = $1 LIMIT 1 FOR UPDATE`,
      [id]
    );
    if (!current.rows[0]) throw new OperacionContableError("Factura no encontrada", 404);
    if (current.rows[0].estado !== "Pendiente") {
      throw new OperacionContableError("Solo se pueden editar facturas pendientes", 409);
    }
    const persona = await resolvePersonaId(client, req.body || {});
    factura.iva = await calcularIvaFactura(client, factura, persona);
    if (factura.anticipo > factura.subtotal + factura.iva) {
      throw new OperacionContableError("El anticipo supera el total calculado de la factura");
    }
    await client.query(
      `UPDATE facturas_proveedores SET persona_id = $1, numero_factura = $2,
        fecha_emision = $3, fecha_vencimiento = $4, fecha_pago_preferida = $5,
        concepto = $6, ciudad_servicio = $7, subtotal = $8, tiene_iva = $9,
        iva = $10, anticipo = $11, tipo_gasto = $12, moneda = $13,
        documento_soporte = $14::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE id = $15`,
      [
        persona.id, factura.numeroFactura, factura.fechaEmision, factura.fechaVencimiento,
        factura.fechaPagoPreferida, factura.concepto, factura.ciudadServicio,
        factura.subtotal, factura.tieneIva, factura.iva, factura.anticipo,
        factura.tipoGasto, factura.moneda, JSON.stringify(factura.soporte), current.rows[0].id
      ]
    );
    await client.query("COMMIT");
    return res.json({ id, estado: "Pendiente" });
  } catch (error) {
    if (client) try { await client.query("ROLLBACK"); } catch (_) { }
    return handleError(res, error, "actualizando la factura");
  } finally {
    if (client) client.release();
  }
}

async function anularFactura(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const id = uuid(req.params.id);
    const result = await dbPool.query(
      `UPDATE facturas_proveedores
          SET estado = 'Anulada', updated_at = CURRENT_TIMESTAMP
        WHERE public_id = $1 AND estado = 'Pendiente'
        RETURNING public_id::text AS id`,
      [id]
    );
    if (!result.rows[0]) throw new OperacionContableError("La factura no existe o ya fue programada", 409);
    return res.json({ id, estado: "Anulada" });
  } catch (error) {
    return handleError(res, error, "anulando la factura");
  }
}

function mapRegla(row) {
  return {
    ...row,
    base_minima: Number(row.base_minima || 0),
    porcentaje_fuente_declarante: Number(row.porcentaje_fuente_declarante || 0),
    porcentaje_fuente_no_declarante: Number(row.porcentaje_fuente_no_declarante || 0),
    porcentaje_iva: Number(row.porcentaje_iva || 0),
    porcentaje_reteiva: Number(row.porcentaje_reteiva || 0),
    base_reteica: Number(row.base_reteica || 0),
    porcentaje_reteica: Number(row.porcentaje_reteica || 0)
  };
}

const REGLA_SELECT = `SELECT public_id::text AS id, concepto, tipo_documento_pago, nombre,
  base_minima, porcentaje_fuente_declarante, porcentaje_fuente_no_declarante,
  porcentaje_iva, porcentaje_reteiva, base_reteica, porcentaje_reteica,
  vigencia_desde, vigencia_hasta, activo, created_at, updated_at
  FROM contabilidad_reglas_retencion`;

async function listarReglas(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const result = await dbPool.query(`${REGLA_SELECT} ORDER BY activo DESC, concepto, vigencia_desde DESC`);
    return res.json({ items: result.rows.map(mapRegla) });
  } catch (error) {
    return handleError(res, error, "consultando las reglas contables");
  }
}

function validarRegla(body = {}) {
  const concepto = text(body.concepto, 40).toLowerCase();
  const tipoDocumento = text(body.tipo_documento_pago || "cualquiera", 30).toLowerCase();
  if (!CONCEPTOS.has(concepto)) throw new OperacionContableError("El concepto no es válido");
  if (!DOCUMENTOS_PAGO.has(tipoDocumento)) throw new OperacionContableError("El tipo de documento de pago no es válido");
  const desde = date(body.vigencia_desde, "vigencia_desde");
  const hasta = date(body.vigencia_hasta, "vigencia_hasta", { required: false });
  if (hasta && hasta < desde) {
    throw new OperacionContableError("La vigencia final no puede ser anterior a la inicial");
  }
  return {
    concepto,
    tipoDocumento,
    nombre: text(body.nombre, 120) || concepto.replaceAll("_", " "),
    baseMinima: money(body.base_minima, "base_minima"),
    fuenteDeclarante: percent(body.porcentaje_fuente_declarante, "porcentaje_fuente_declarante"),
    fuenteNoDeclarante: percent(body.porcentaje_fuente_no_declarante, "porcentaje_fuente_no_declarante"),
    porcentajeIva: percent(body.porcentaje_iva, "porcentaje_iva"),
    porcentajeReteiva: percent(body.porcentaje_reteiva, "porcentaje_reteiva"),
    baseReteica: money(body.base_reteica, "base_reteica"),
    porcentajeReteica: percent(body.porcentaje_reteica, "porcentaje_reteica"),
    desde,
    hasta,
    activo: bool(body.activo, true)
  };
}

async function crearRegla(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const rule = validarRegla(req.body || {});
    const result = await dbPool.query(
      `INSERT INTO contabilidad_reglas_retencion (
        concepto, tipo_documento_pago, nombre, base_minima,
        porcentaje_fuente_declarante, porcentaje_fuente_no_declarante,
        porcentaje_iva, porcentaje_reteiva, base_reteica, porcentaje_reteica,
        vigencia_desde, vigencia_hasta, activo, created_by, updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
      RETURNING public_id::text AS id`,
      [rule.concepto, rule.tipoDocumento, rule.nombre, rule.baseMinima,
        rule.fuenteDeclarante, rule.fuenteNoDeclarante, rule.porcentajeIva,
        rule.porcentajeReteiva, rule.baseReteica, rule.porcentajeReteica,
        rule.desde, rule.hasta, rule.activo, req.user.id]
    );
    return res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    return handleError(res, error, "creando la regla contable");
  }
}

async function actualizarRegla(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const id = uuid(req.params.id);
    const rule = validarRegla(req.body || {});
    const result = await dbPool.query(
      `UPDATE contabilidad_reglas_retencion SET concepto=$1, tipo_documento_pago=$2,
        nombre=$3, base_minima=$4, porcentaje_fuente_declarante=$5,
        porcentaje_fuente_no_declarante=$6, porcentaje_iva=$7, porcentaje_reteiva=$8,
        base_reteica=$9, porcentaje_reteica=$10, vigencia_desde=$11,
        vigencia_hasta=$12, activo=$13, updated_by=$14, updated_at=CURRENT_TIMESTAMP
       WHERE public_id=$15 RETURNING public_id::text AS id`,
      [rule.concepto, rule.tipoDocumento, rule.nombre, rule.baseMinima,
        rule.fuenteDeclarante, rule.fuenteNoDeclarante, rule.porcentajeIva,
        rule.porcentajeReteiva, rule.baseReteica, rule.porcentajeReteica,
        rule.desde, rule.hasta, rule.activo, req.user.id, id]
    );
    if (!result.rows[0]) throw new OperacionContableError("Regla no encontrada", 404);
    return res.json({ id: result.rows[0].id });
  } catch (error) {
    return handleError(res, error, "actualizando la regla contable");
  }
}

async function consultarAuditoria(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const id = uuid(req.params.id);
    const result = await dbPool.query(
      `SELECT a.public_id::text AS id, a.evento, a.estado_anterior, a.estado_nuevo,
              a.datos, a.created_at, u.nombre_usuario AS usuario,
              d.public_id::text AS detalle_id
         FROM proyeccion_pagos_auditoria a
         JOIN proyeccion_pagos pp ON pp.id = a.proyeccion_id
         LEFT JOIN usuarios u ON u.id = a.created_by
         LEFT JOIN proyeccion_pagos_detalle d ON d.id = a.detalle_id
        WHERE pp.public_id = $1
        ORDER BY a.created_at DESC, a.id DESC`,
      [id]
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return handleError(res, error, "consultando la auditoría");
  }
}

function csvCell(value) {
  const result = String(value ?? "").replaceAll('"', '""');
  return `"${result}"`;
}

async function exportarArchivoBancario(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const id = uuid(req.params.id);
    const projection = await dbPool.query(
      `SELECT id, anio, mes, quincena, fecha_pago_programada, estado
         FROM proyeccion_pagos WHERE public_id = $1 LIMIT 1`,
      [id]
    );
    const item = projection.rows[0];
    if (!item) throw new OperacionContableError("Programación no encontrada", 404);
    if (!["Aprobado", "Pagado"].includes(item.estado)) {
      throw new OperacionContableError("El archivo bancario solo está disponible al aprobar la programación", 409);
    }
    const result = await dbPool.query(
      `SELECT d.datos_beneficiario_snapshot AS beneficiario, d.valor_neto,
              CASE WHEN d.origen_tipo = 'factura_proveedor' THEN fp.numero_factura
                   WHEN d.origen_tipo = 'cuenta_cobro' THEN cc.descripcion
                   ELSE CONCAT('Nómina ', np.anio, '-', LPAD(np.mes::text, 2, '0'), ' Q', np.quincena)
              END AS referencia
         FROM proyeccion_pagos_detalle d
         LEFT JOIN facturas_proveedores fp ON d.origen_tipo='factura_proveedor' AND fp.id=d.origen_id
         LEFT JOIN cuenta_cobro cc ON d.origen_tipo='cuenta_cobro' AND cc.id=d.origen_id
         LEFT JOIN nomina_pagos_manual np ON d.origen_tipo='nomina' AND np.id=d.origen_id
        WHERE d.proyeccion_id = $1 ORDER BY d.id`,
      [item.id]
    );
    const required = ["tipo_documento_bancario", "numero_documento", "nombre", "codigo_banco", "tipo_transaccion", "numero_cuenta"];
    const incomplete = result.rows.filter((row) => required.some((field) => !text(row.beneficiario?.[field])));
    if (incomplete.length) {
      throw new OperacionContableError(
        `${incomplete.length} pago(s) no tienen todos los datos bancarios requeridos`,
        422,
        "DATOS_BANCARIOS_INCOMPLETOS"
      );
    }
    const headers = [
      "Tipo Documento Beneficiario", "Nit Beneficiario", "Nombre Beneficiario",
      "Tipo Transaccion", "Código Banco", "No Cuenta Beneficiario", "Email",
      "Documento Autorizado", "Referencia", "OficinaEntrega", "ValorTransaccion",
      "Fecha de aplicación"
    ];
    const rows = result.rows.map((row) => {
      const b = row.beneficiario || {};
      return [
        b.tipo_documento_bancario, b.numero_documento, b.nombre, b.tipo_transaccion,
        b.codigo_banco, b.numero_cuenta, b.email, "", row.referencia, "",
        Number(row.valor_neto || 0).toFixed(2), String(item.fecha_pago_programada).slice(0, 10)
      ];
    });
    const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
    const corte = item.quincena === 1 ? "15" : (item.mes === 2 ? "fin-mes" : "30");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="pagos-${item.anio}-${String(item.mes).padStart(2, "0")}-${corte}.csv"`);
    return res.send(csv);
  } catch (error) {
    return handleError(res, error, "exportando el archivo bancario");
  }
}

module.exports = {
  actualizarFactura,
  actualizarPerfilTributario,
  actualizarRegla,
  anularFactura,
  buscarBeneficiarios,
  consultarAuditoria,
  crearFactura,
  crearRegla,
  exportarArchivoBancario,
  listarFacturas,
  listarProyecciones,
  listarReglas,
  _private: { bool, date, mapFactura, money, parseMonths, validarFactura, validarRegla }
};
