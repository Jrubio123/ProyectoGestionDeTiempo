const { pool } = require("../db");
const {
  RetencionValidationError,
  calcularRetenciones,
  normalizeText,
  roundMoney
} = require("./calculadoraRetenciones.service");
const {
  CalendarioPagosValidationError,
  calcularFechaPago,
  determinarQuincenaCuenta,
  normalizeCiclo,
  validarPeriodo
} = require("./calendarioPagos.service");

const ESTADOS = Object.freeze({
  BORRADOR: "Borrador",
  REVISION: "Revisión",
  APROBADO: "Aprobado",
  PAGADO: "Pagado",
  CANCELADO: "Cancelado"
});

const TRANSICIONES = Object.freeze({
  [ESTADOS.BORRADOR]: new Set([ESTADOS.REVISION, ESTADOS.CANCELADO]),
  [ESTADOS.REVISION]: new Set([ESTADOS.APROBADO, ESTADOS.CANCELADO]),
  [ESTADOS.APROBADO]: new Set([ESTADOS.PAGADO, ESTADOS.CANCELADO]),
  [ESTADOS.PAGADO]: new Set(),
  [ESTADOS.CANCELADO]: new Set()
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETENCION_TYPES = new Map([
  ["retefuente", "ReteFuente"],
  ["retencion en la fuente", "ReteFuente"],
  ["reteiva", "ReteIVA"],
  ["retencion de iva", "ReteIVA"],
  ["reteica", "ReteICA"],
  ["retencion de ica", "ReteICA"]
]);

class ContabilidadError extends Error {
  constructor(message, statusCode = 400, code = "CONTABILIDAD_VALIDATION", data = null) {
    super(message);
    this.name = "ContabilidadError";
    this.statusCode = statusCode;
    this.code = code;
    this.data = data;
  }
}

function assertUuid(value, fieldName = "id") {
  const id = String(value || "").trim();
  if (!UUID_RE.test(id)) throw new ContabilidadError(`${fieldName} no es un UUID válido`);
  return id;
}

function toPositiveMoneyOrNull(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new ContabilidadError(`${fieldName} debe ser un número mayor que cero`);
  }
  return roundMoney(number);
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function personaFromRow(row) {
  return {
    id: row.persona_id,
    public_id: row.persona_public_id,
    factura_en_colombia: row.factura_en_colombia,
    es_gran_contribuyente: row.es_gran_contribuyente,
    es_autorretenedor: row.es_autorretenedor,
    es_regimen_simple: row.es_regimen_simple,
    es_entidad_sin_animo_lucro: row.es_entidad_sin_animo_lucro,
    facturador_electronico: row.facturador_electronico,
    acumulado_facturacion_anual: row.acumulado_facturacion_anual,
    declarante_renta: row.declarante_renta,
    ciudad_residencia: row.ciudad_residencia
  };
}

function mapProyeccion(row) {
  if (!row) return null;
  return {
    id: String(row.public_id || ""),
    mes: Number(row.mes),
    anio: Number(row.anio),
    quincena: Number(row.quincena),
    trm_oficial: row.trm_oficial === null || row.trm_oficial === undefined
      ? null
      : Number(row.trm_oficial),
    estado: row.estado,
    fecha_pago_programada: row.fecha_pago_programada,
    ...(row.revisado_por_id !== undefined ? {
      revisado_por_id: row.revisado_por_id,
      revisado_por: row.revisado_por,
      revisado_at: row.revisado_at
    } : { revisado_at: row.revisado_at || null }),
    ...(row.aprobado_por_id !== undefined ? {
      aprobado_por_id: row.aprobado_por_id,
      aprobado_por: row.aprobado_por,
      aprobado_at: row.aprobado_at
    } : { aprobado_at: row.aprobado_at || null }),
    ...(row.pagado_por_id !== undefined ? {
      pagado_por_id: row.pagado_por_id,
      pagado_por: row.pagado_por,
      pagado_at: row.pagado_at
    } : { pagado_at: row.pagado_at || null }),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function esExterior(persona) {
  return persona?.factura_en_colombia === false ||
    ["false", "0", "no"].includes(normalizeText(persona?.factura_en_colombia));
}

function monedaOrigen(row, persona) {
  const moneda = String(row.moneda_origen || "").trim().toUpperCase();
  if (esExterior(persona) && (!moneda || moneda === "COP")) return "USD";
  return moneda || "COP";
}

function prepararDetalle({
  origenTipo,
  origenId,
  persona,
  tipoPago,
  subtotal,
  iva = 0,
  moneda,
  trmOficial,
  esNomina = false
}) {
  const valorOriginal = roundMoney(Number(subtotal));
  const monedaOriginal = esNomina ? "COP" : monedaOrigen({ moneda_origen: moneda }, persona);
  const requiereTrm = !esNomina && esExterior(persona) && monedaOriginal !== "COP";
  if (requiereTrm && !trmOficial) {
    throw new ContabilidadError(
      "Debe indicar trm_oficial para incluir pagos de Capitalink",
      400,
      "TRM_REQUERIDA"
    );
  }

  const factorConversion = requiereTrm ? trmOficial : 1;
  const subtotalCop = roundMoney(valorOriginal * factorConversion);
  const ivaCop = esExterior(persona) || esNomina ? 0 : roundMoney(Number(iva || 0) * factorConversion);
  const calculo = calcularRetenciones({
    subtotal: subtotalCop,
    iva: ivaCop,
    persona,
    tipo_pago: esNomina ? "nomina" : tipoPago
  });

  return {
    origen_tipo: origenTipo,
    origen_id: origenId,
    persona_id: persona.id,
    tipo_pago: calculo.tipo_pago,
    moneda_origen: monedaOriginal,
    valor_origen: valorOriginal,
    trm_aplicada: requiereTrm ? trmOficial : null,
    subtotal: calculo.subtotal,
    iva: calculo.iva,
    retenciones_aplicadas: calculo.retenciones_aplicadas,
    valor_neto: calculo.valor_neto
  };
}

function validarGeneracion(body = {}) {
  const periodo = validarPeriodo(body.anio, body.mes, body.quincena);
  return {
    ...periodo,
    trm_oficial: toPositiveMoneyOrNull(body.trm_oficial ?? body.trm, "trm_oficial"),
    fecha_pago_programada: calcularFechaPago(periodo.anio, periodo.mes, periodo.quincena)
  };
}

async function insertarDetalle(client, proyeccionId, detalle, userId) {
  const result = await client.query(
    `
    INSERT INTO proyeccion_pagos_detalle (
      proyeccion_id, origen_tipo, origen_id, persona_id, tipo_pago,
      moneda_origen, valor_origen, trm_aplicada, subtotal, iva,
      retenciones_aplicadas, valor_neto, created_by
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11::jsonb, $12, $13
    )
    RETURNING id, public_id
    `,
    [
      proyeccionId,
      detalle.origen_tipo,
      detalle.origen_id,
      detalle.persona_id,
      detalle.tipo_pago,
      detalle.moneda_origen,
      detalle.valor_origen,
      detalle.trm_aplicada,
      detalle.subtotal,
      detalle.iva,
      JSON.stringify(detalle.retenciones_aplicadas),
      detalle.valor_neto,
      userId
    ]
  );
  return result.rows[0];
}

async function consultarCuentasPendientes(client, { bloquear = true } = {}) {
  const result = await client.query(`
    SELECT
      cc.id, cc.public_id::text, cc.descripcion AS referencia,
      cc.total_cuenta_cobro, cc.datos_adjuntos,
      cc.ciclo_proyeccion_asignado,
      p.id AS persona_id, p.public_id::text AS persona_public_id,
      BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) AS tercero,
      p.numero_documento,
      p.factura_en_colombia, p.es_gran_contribuyente, p.es_autorretenedor,
      p.es_regimen_simple, p.es_entidad_sin_animo_lucro, p.facturador_electronico,
      p.acumulado_facturacion_anual, p.declarante_renta, p.ciudad_residencia,
      COALESCE(p.moneda_cobro::text, u.moneda_cobro::text, 'COP') AS moneda_origen
    FROM cuenta_cobro cc
    LEFT JOIN usuarios u ON u.id = cc.created_by
    LEFT JOIN personas p ON p.id = u.persona_id
    WHERE cc.estado::text = 'Aprobado'
      AND cc.proyeccion_pago_id IS NULL
    ORDER BY cc.id
    ${bloquear ? "FOR UPDATE OF cc" : ""}
  `);
  return result.rows;
}

async function consultarFacturasPendientes(client, fechaLimite, { bloquear = true } = {}) {
  const result = await client.query(`
    SELECT
      fp.id, fp.public_id::text, fp.numero_factura AS referencia,
      fp.fecha_emision, fp.concepto, fp.subtotal, fp.iva, fp.tipo_gasto,
      p.id AS persona_id, p.public_id::text AS persona_public_id,
      BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) AS tercero,
      p.numero_documento,
      p.factura_en_colombia, p.es_gran_contribuyente, p.es_autorretenedor,
      p.es_regimen_simple, p.es_entidad_sin_animo_lucro, p.facturador_electronico,
      p.acumulado_facturacion_anual, p.declarante_renta, p.ciudad_residencia,
      COALESCE(p.moneda_cobro::text, 'COP') AS moneda_origen
    FROM facturas_proveedores fp
    JOIN personas p ON p.id = fp.persona_id
    WHERE fp.estado = 'Pendiente'
      AND fp.proyeccion_pago_id IS NULL
      AND fp.fecha_emision <= $1::date
    ORDER BY fp.fecha_emision, fp.id
    ${bloquear ? "FOR UPDATE OF fp" : ""}
  `, [fechaLimite]);
  return result.rows;
}

async function consultarNominaPendiente(client, periodo, { bloquear = true } = {}) {
  const result = await client.query(
    `
    SELECT
      np.id, np.public_id::text, np.valor_neto,
      p.id AS persona_id, p.public_id::text AS persona_public_id,
      BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) AS tercero,
      p.numero_documento,
      p.factura_en_colombia, p.es_gran_contribuyente, p.es_autorretenedor,
      p.es_regimen_simple, p.es_entidad_sin_animo_lucro, p.facturador_electronico,
      p.acumulado_facturacion_anual, p.declarante_renta, p.ciudad_residencia,
      'COP' AS moneda_origen
    FROM nomina_pagos_manual np
    JOIN personas p ON p.id = np.persona_id
    WHERE np.anio = $1 AND np.mes = $2 AND np.quincena = $3
      AND np.estado = 'Pendiente'
      AND np.proyeccion_pago_id IS NULL
    ORDER BY np.id
    ${bloquear ? "FOR UPDATE OF np" : ""}
    `,
    [periodo.anio, periodo.mes, periodo.quincena]
  );
  return result.rows;
}

function construirVistaPrevia({ input, cuentas = [], facturas = [], nominas = [], existente = null }) {
  const pagos = [];
  const cuentasOtraQuincena = [];
  const cuentasLimbo = [];

  for (const cuenta of cuentas) {
    const clasificacion = determinarQuincenaCuenta({
      anio: input.anio,
      mes: input.mes,
      datos_adjuntos: parseJsonObject(cuenta.datos_adjuntos),
      ciclo_proyeccion_asignado: cuenta.ciclo_proyeccion_asignado
    });
    const resumenCuenta = {
      id: cuenta.public_id,
      origen_tipo: "cuenta_cobro",
      tercero: cuenta.tercero || "Persona sin nombre",
      numero_documento: cuenta.numero_documento || null,
      referencia: cuenta.referencia || null,
      valor_origen: Number(cuenta.total_cuenta_cobro || 0),
      moneda_origen: monedaOrigen(cuenta, personaFromRow(cuenta)),
      fecha_ultimo_archivo: clasificacion.fecha_ultimo_archivo,
      ciclo: clasificacion.ciclo,
      motivo: clasificacion.motivo || null,
      cortes: clasificacion.cortes
    };
    if (!clasificacion.quincena) {
      cuentasLimbo.push(resumenCuenta);
    } else if (clasificacion.quincena !== input.quincena) {
      cuentasOtraQuincena.push(resumenCuenta);
    } else {
      pagos.push(resumenCuenta);
    }
  }

  for (const factura of facturas) {
    pagos.push({
      id: factura.public_id,
      origen_tipo: "factura_proveedor",
      tercero: factura.tercero || "Persona sin nombre",
      numero_documento: factura.numero_documento || null,
      referencia: factura.referencia || factura.concepto || null,
      valor_origen: roundMoney(Number(factura.subtotal || 0) + Number(factura.iva || 0)),
      moneda_origen: monedaOrigen(factura, personaFromRow(factura)),
      fecha_emision: factura.fecha_emision || null,
      tipo_pago: factura.tipo_gasto
    });
  }

  for (const nomina of nominas) {
    pagos.push({
      id: nomina.public_id,
      origen_tipo: "nomina",
      tercero: nomina.tercero || "Persona sin nombre",
      numero_documento: nomina.numero_documento || null,
      referencia: `Nómina ${input.anio}-${String(input.mes).padStart(2, "0")} Q${input.quincena}`,
      valor_origen: Number(nomina.valor_neto || 0),
      moneda_origen: "COP"
    });
  }

  const requiereTrm = pagos.some((pago) => pago.moneda_origen !== "COP");
  const trmFaltante = requiereTrm && !input.trm_oficial;
  return {
    periodo: {
      anio: input.anio,
      mes: input.mes,
      quincena: input.quincena,
      fecha_pago_programada: input.fecha_pago_programada,
      trm_oficial: input.trm_oficial
    },
    proyeccion_existente: existente ? mapProyeccion(existente) : null,
    resumen: {
      total_pagos: pagos.length,
      cuentas_cobro: pagos.filter((pago) => pago.origen_tipo === "cuenta_cobro").length,
      facturas_proveedores: facturas.length,
      nomina: nominas.length,
      cuentas_otra_quincena: cuentasOtraQuincena.length,
      cuentas_en_limbo: cuentasLimbo.length,
      cuentas_aprobadas_pendientes: cuentas.length,
      requiere_trm: requiereTrm,
      trm_faltante: trmFaltante,
      puede_generar: pagos.length > 0 && !trmFaltante && !existente
    },
    pagos,
    excluidos: {
      cuentas_otra_quincena: cuentasOtraQuincena,
      cuentas_en_limbo: cuentasLimbo
    }
  };
}

async function previsualizarProyeccion(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const input = validarGeneracion(req.body || {});
    const [existenteResult, cuentas, facturas, nominas] = await Promise.all([
      dbPool.query(
        `SELECT public_id::text, mes, anio, quincena, trm_oficial, estado,
                fecha_pago_programada, created_at, updated_at
         FROM proyeccion_pagos
         WHERE anio = $1 AND mes = $2 AND quincena = $3 AND estado <> 'Cancelado'
         LIMIT 1`,
        [input.anio, input.mes, input.quincena]
      ),
      consultarCuentasPendientes(dbPool, { bloquear: false }),
      consultarFacturasPendientes(dbPool, input.fecha_pago_programada, { bloquear: false }),
      consultarNominaPendiente(dbPool, input, { bloquear: false })
    ]);
    return res.json(construirVistaPrevia({
      input,
      cuentas,
      facturas,
      nominas,
      existente: existenteResult.rows[0] || null
    }));
  } catch (error) {
    return handleError(res, error, "previsualizando la proyección");
  }
}

async function registrarAuditoria(client, {
  proyeccionId,
  detalleId = null,
  evento,
  estadoAnterior = null,
  estadoNuevo = null,
  datos = {},
  userId
}) {
  await client.query(
    `
    INSERT INTO proyeccion_pagos_auditoria (
      proyeccion_id, detalle_id, evento, estado_anterior, estado_nuevo, datos, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `,
    [proyeccionId, detalleId, evento, estadoAnterior, estadoNuevo, JSON.stringify(datos), userId]
  );
}

async function generarProyeccion(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  let client;
  try {
    const input = validarGeneracion(req.body || {});
    client = await dbPool.connect();
    await client.query("BEGIN");
    // Serializa la recolección Q1/Q2 del mismo mes: ambas quincenas comparten
    // las mismas colas de facturas y cuentas aún no asignadas.
    await client.query(
      `SELECT pg_advisory_xact_lock($1, $2)`,
      [20260902, input.anio * 100 + input.mes]
    );

    const loteResult = await client.query(
      `
      INSERT INTO proyeccion_pagos (
        mes, anio, quincena, trm_oficial, estado, fecha_pago_programada, created_by
      ) VALUES ($1, $2, $3, $4, 'Borrador', $5, $6)
      RETURNING id, public_id::text, mes, anio, quincena, trm_oficial,
                estado, fecha_pago_programada, created_at, updated_at
      `,
      [input.mes, input.anio, input.quincena, input.trm_oficial, input.fecha_pago_programada, req.user.id]
    );
    const lote = loteResult.rows[0];
    const cuentas = await consultarCuentasPendientes(client);
    const facturas = await consultarFacturasPendientes(client, input.fecha_pago_programada);
    const nominas = await consultarNominaPendiente(client, input);

    const detalles = [];
    const limbo = [];
    let cuentasOtraQuincena = 0;

    for (const cuenta of cuentas) {
      const clasificacion = determinarQuincenaCuenta({
        anio: input.anio,
        mes: input.mes,
        datos_adjuntos: parseJsonObject(cuenta.datos_adjuntos),
        ciclo_proyeccion_asignado: cuenta.ciclo_proyeccion_asignado
      });
      if (!clasificacion.quincena) {
        limbo.push({
          cuenta_cobro_id: cuenta.public_id,
          motivo: clasificacion.motivo,
          fecha_ultimo_archivo: clasificacion.fecha_ultimo_archivo,
          cortes: clasificacion.cortes
        });
        continue;
      }
      if (clasificacion.quincena !== input.quincena) {
        cuentasOtraQuincena += 1;
        continue;
      }
      if (!cuenta.persona_id) {
        throw new ContabilidadError(
          `La cuenta ${cuenta.public_id} no tiene una persona asociada`,
          422,
          "CUENTA_SIN_PERSONA"
        );
      }
      if (!Number.isFinite(Number(cuenta.total_cuenta_cobro)) || Number(cuenta.total_cuenta_cobro) < 0) {
        throw new ContabilidadError(
          `La cuenta ${cuenta.public_id} no tiene un total válido`,
          422,
          "CUENTA_SIN_TOTAL"
        );
      }
      detalles.push({
        data: prepararDetalle({
          origenTipo: "cuenta_cobro",
          origenId: cuenta.id,
          persona: personaFromRow(cuenta),
          tipoPago: "consultor",
          subtotal: cuenta.total_cuenta_cobro,
          iva: 0,
          moneda: cuenta.moneda_origen,
          trmOficial: input.trm_oficial
        }),
        publicId: cuenta.public_id,
        clasificacion
      });
    }

    for (const factura of facturas) {
      detalles.push({
        data: prepararDetalle({
          origenTipo: "factura_proveedor",
          origenId: factura.id,
          persona: personaFromRow(factura),
          tipoPago: factura.tipo_gasto,
          subtotal: factura.subtotal,
          iva: factura.iva,
          moneda: factura.moneda_origen,
          trmOficial: input.trm_oficial
        }),
        publicId: factura.public_id
      });
    }

    for (const nomina of nominas) {
      detalles.push({
        data: prepararDetalle({
          origenTipo: "nomina",
          origenId: nomina.id,
          persona: personaFromRow(nomina),
          tipoPago: "nomina",
          subtotal: nomina.valor_neto,
          moneda: "COP",
          trmOficial: null,
          esNomina: true
        }),
        publicId: nomina.public_id
      });
    }

    if (detalles.length === 0) {
      throw new ContabilidadError(
        "No hay pagos elegibles para la proyección solicitada",
        422,
        "PROYECCION_SIN_DETALLES",
        { limbo, cuentas_otra_quincena: cuentasOtraQuincena }
      );
    }

    const conteos = { cuenta_cobro: 0, factura_proveedor: 0, nomina: 0 };
    let totalNeto = 0;
    for (const item of detalles) {
      const inserted = await insertarDetalle(client, lote.id, item.data, req.user.id);
      item.detalleId = inserted.id;
      conteos[item.data.origen_tipo] += 1;
      totalNeto = roundMoney(totalNeto + Number(item.data.valor_neto));

      if (item.data.origen_tipo === "cuenta_cobro") {
        await client.query(
          `UPDATE cuenta_cobro
           SET proyeccion_pago_id = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [lote.id, item.data.origen_id]
        );
      } else if (item.data.origen_tipo === "factura_proveedor") {
        await client.query(
          `UPDATE facturas_proveedores
           SET proyeccion_pago_id = $1, estado = 'Proyectada', updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [lote.id, item.data.origen_id]
        );
      } else {
        await client.query(
          `UPDATE nomina_pagos_manual
           SET proyeccion_pago_id = $1, estado = 'Proyectada', updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [lote.id, item.data.origen_id]
        );
      }
    }

    await registrarAuditoria(client, {
      proyeccionId: lote.id,
      evento: "GENERACION",
      estadoNuevo: ESTADOS.BORRADOR,
      datos: { conteos, total_neto: totalNeto, limbo },
      userId: req.user.id
    });
    await client.query("COMMIT");

    return res.status(201).json({
      proyeccion: mapProyeccion(lote),
      resumen: {
        cuentas_cobro: conteos.cuenta_cobro,
        facturas_proveedores: conteos.factura_proveedor,
        nomina: conteos.nomina,
        total_detalles: detalles.length,
        total_neto: totalNeto,
        cuentas_otra_quincena: cuentasOtraQuincena
      },
      limbo
    });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) { }
    }
    return handleError(res, error, "generando la proyección");
  } finally {
    if (client) client.release();
  }
}

async function simularRetenciones(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    let persona = req.body?.persona;
    const personaId = req.body?.persona_id;
    if (personaId) {
      const id = assertUuid(personaId, "persona_id");
      const result = await dbPool.query(
        `
        SELECT public_id::text, factura_en_colombia,
               es_gran_contribuyente, es_autorretenedor,
               es_regimen_simple, es_entidad_sin_animo_lucro,
               facturador_electronico, acumulado_facturacion_anual,
               declarante_renta, ciudad_residencia
        FROM personas WHERE public_id = $1 LIMIT 1
        `,
        [id]
      );
      if (!result.rows[0]) throw new ContabilidadError("Persona no encontrada", 404, "PERSONA_NO_ENCONTRADA");
      persona = { ...result.rows[0], ...(persona || {}) };
    }
    return res.json(calcularRetenciones({
      subtotal: req.body?.subtotal,
      iva: req.body?.iva ?? 0,
      persona: persona || {},
      tipo_pago: req.body?.tipo_pago
    }));
  } catch (error) {
    return handleError(res, error, "simulando las retenciones");
  }
}

function retencionValue(retenciones, tipo) {
  return roundMoney(
    retenciones
      .filter((item) => normalizeText(item?.tipo).replace(/\s+/g, "") === normalizeText(tipo).replace(/\s+/g, ""))
      .reduce((total, item) => total + Number(item?.valor || 0), 0)
  );
}

function mapDetalle(row) {
  const retenciones = parseJsonArray(row.retenciones_aplicadas);
  const subtotal = Number(row.subtotal || 0);
  const iva = Number(row.iva || 0);
  return {
    id: row.public_id,
    origen_tipo: row.origen_tipo,
    origen_id: row.origen_public_id,
    referencia: row.referencia || null,
    persona_id: row.persona_public_id,
    tercero: row.tercero,
    numero_documento: row.numero_documento || null,
    banco: row.banco || null,
    tipo_cuenta: row.tipo_cuenta || null,
    numero_cuenta: row.numero_cuenta || null,
    tipo_pago: row.tipo_pago,
    moneda_origen: row.moneda_origen,
    valor_origen: Number(row.valor_origen || 0),
    trm_aplicada: row.trm_aplicada === null ? null : Number(row.trm_aplicada),
    subtotal,
    iva,
    bruto: roundMoney(subtotal + iva),
    retenciones_aplicadas: retenciones,
    retefuente: retencionValue(retenciones, "ReteFuente"),
    reteiva: retencionValue(retenciones, "ReteIVA"),
    reteica: retencionValue(retenciones, "ReteICA"),
    valor_neto: Number(row.valor_neto || 0),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function getDetallesProyeccion(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  try {
    const id = assertUuid(req.params.id, "id");
    const loteResult = await dbPool.query(
      `
      SELECT pp.public_id::text, pp.mes, pp.anio, pp.quincena, pp.trm_oficial,
             pp.estado, pp.fecha_pago_programada, pp.created_at, pp.updated_at,
             ru.public_id::text AS revisado_por_id, ru.nombre_usuario AS revisado_por,
             pp.revisado_at,
             au.public_id::text AS aprobado_por_id, au.nombre_usuario AS aprobado_por,
             pp.aprobado_at,
             pu.public_id::text AS pagado_por_id, pu.nombre_usuario AS pagado_por,
             pp.pagado_at
      FROM proyeccion_pagos pp
      LEFT JOIN usuarios ru ON ru.id = pp.revisado_por
      LEFT JOIN usuarios au ON au.id = pp.aprobado_por
      LEFT JOIN usuarios pu ON pu.id = pp.pagado_por
      WHERE pp.public_id = $1
      LIMIT 1
      `,
      [id]
    );
    if (!loteResult.rows[0]) throw new ContabilidadError("Proyección no encontrada", 404, "PROYECCION_NO_ENCONTRADA");

    const detallesResult = await dbPool.query(
      `
      SELECT
        d.public_id::text, d.origen_tipo,
        COALESCE(cc.public_id, fp.public_id, np.public_id)::text AS origen_public_id,
        CASE
          WHEN d.origen_tipo = 'cuenta_cobro' THEN cc.descripcion
          WHEN d.origen_tipo = 'factura_proveedor' THEN fp.numero_factura
          WHEN d.origen_tipo = 'nomina' THEN CONCAT('Nómina ', np.anio, '-', LPAD(np.mes::text, 2, '0'), ' Q', np.quincena)
        END AS referencia,
        p.public_id::text AS persona_public_id,
        BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) AS tercero,
        p.numero_documento, b.titulo AS banco, tcb.titulo AS tipo_cuenta,
        p.numero_cuenta, d.tipo_pago, d.moneda_origen, d.valor_origen,
        d.trm_aplicada, d.subtotal, d.iva, d.retenciones_aplicadas,
        d.valor_neto, d.created_at, d.updated_at
      FROM proyeccion_pagos_detalle d
      JOIN personas p ON p.id = d.persona_id
      LEFT JOIN bancos b ON b.id = p.banco_id
      LEFT JOIN tipo_cuenta_bancaria tcb ON tcb.id = p.tipo_cuenta_id
      LEFT JOIN cuenta_cobro cc
        ON d.origen_tipo = 'cuenta_cobro' AND cc.id = d.origen_id
      LEFT JOIN facturas_proveedores fp
        ON d.origen_tipo = 'factura_proveedor' AND fp.id = d.origen_id
      LEFT JOIN nomina_pagos_manual np
        ON d.origen_tipo = 'nomina' AND np.id = d.origen_id
      WHERE d.proyeccion_id = (
        SELECT id FROM proyeccion_pagos WHERE public_id = $1
      )
      ORDER BY d.id
      `,
      [id]
    );
    const detalles = detallesResult.rows.map(mapDetalle);
    return res.json({
      proyeccion: mapProyeccion(loteResult.rows[0]),
      resumen: {
        total_detalles: detalles.length,
        total_bruto: roundMoney(detalles.reduce((total, item) => total + item.bruto, 0)),
        total_retenciones: roundMoney(detalles.reduce(
          (total, item) => total + item.retefuente + item.reteiva + item.reteica,
          0
        )),
        total_neto: roundMoney(detalles.reduce((total, item) => total + item.valor_neto, 0))
      },
      detalles
    });
  } catch (error) {
    return handleError(res, error, "consultando los detalles");
  }
}

function canonicalRetentionType(value) {
  const normalized = normalizeText(value).replace(/\s+/g, " ");
  const compact = normalized.replace(/\s+/g, "");
  return RETENCION_TYPES.get(normalized) || RETENCION_TYPES.get(compact) || null;
}

function validarRetencionesManuales(value, bruto) {
  if (!Array.isArray(value)) throw new ContabilidadError("retenciones_aplicadas debe ser un arreglo");
  if (value.length > 10) throw new ContabilidadError("No se permiten más de 10 retenciones por pago");
  const seen = new Set();
  const retenciones = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ContabilidadError(`La retención ${index + 1} no es válida`);
    }
    const tipo = canonicalRetentionType(item.tipo);
    if (!tipo) throw new ContabilidadError(`El tipo de la retención ${index + 1} no es válido`);
    if (seen.has(tipo)) throw new ContabilidadError(`La retención ${tipo} está repetida`);
    seen.add(tipo);
    const porcentaje = Number(item.porcentaje);
    const base = item.base === undefined || item.base === null || item.base === ""
      ? null
      : Number(item.base);
    const valor = Number(item.valor);
    if (!Number.isFinite(porcentaje) || porcentaje < 0 || porcentaje > 100) {
      throw new ContabilidadError(`El porcentaje de ${tipo} debe estar entre 0 y 100`);
    }
    if (base !== null && (!Number.isFinite(base) || base < 0)) {
      throw new ContabilidadError(`La base de ${tipo} no es válida`);
    }
    if (!Number.isFinite(valor) || valor < 0) {
      throw new ContabilidadError(`El valor de ${tipo} no es válido`);
    }
    return {
      tipo,
      porcentaje,
      ...(base === null ? {} : { base: roundMoney(base) }),
      valor: roundMoney(valor),
      editable: item.editable !== false,
      manual: true
    };
  });
  const total = roundMoney(retenciones.reduce((sum, item) => sum + item.valor, 0));
  if (total > bruto) throw new ContabilidadError("Las retenciones no pueden superar el valor bruto");
  return { retenciones, total };
}

async function actualizarRetencionesDetalle(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  let client;
  try {
    const id = assertUuid(req.params.id_detalle, "id_detalle");
    client = await dbPool.connect();
    await client.query("BEGIN");
    const result = await client.query(
      `
      SELECT d.id, d.public_id::text, d.proyeccion_id, d.subtotal, d.iva,
             d.retenciones_aplicadas, d.valor_neto, pp.estado
      FROM proyeccion_pagos_detalle d
      JOIN proyeccion_pagos pp ON pp.id = d.proyeccion_id
      WHERE d.public_id = $1
      LIMIT 1
      FOR UPDATE OF d, pp
      `,
      [id]
    );
    const detalle = result.rows[0];
    if (!detalle) throw new ContabilidadError("Detalle no encontrado", 404, "DETALLE_NO_ENCONTRADO");
    if (![ESTADOS.BORRADOR, ESTADOS.REVISION].includes(detalle.estado)) {
      throw new ContabilidadError(
        "Solo se pueden editar retenciones en proyecciones en Borrador o Revisión",
        409,
        "PROYECCION_NO_EDITABLE"
      );
    }
    const bruto = roundMoney(Number(detalle.subtotal) + Number(detalle.iva));
    const normalizadas = validarRetencionesManuales(
      req.body?.retenciones_aplicadas ?? req.body?.retenciones,
      bruto
    );
    const valorNeto = roundMoney(bruto - normalizadas.total);
    const updated = await client.query(
      `
      UPDATE proyeccion_pagos_detalle
      SET retenciones_aplicadas = $1::jsonb, valor_neto = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING public_id::text, retenciones_aplicadas, valor_neto, updated_at
      `,
      [JSON.stringify(normalizadas.retenciones), valorNeto, detalle.id]
    );
    await registrarAuditoria(client, {
      proyeccionId: detalle.proyeccion_id,
      detalleId: detalle.id,
      evento: "EDICION_RETENCIONES",
      estadoAnterior: detalle.estado,
      estadoNuevo: detalle.estado,
      datos: {
        retenciones_anteriores: parseJsonArray(detalle.retenciones_aplicadas),
        retenciones_nuevas: normalizadas.retenciones,
        valor_neto_anterior: Number(detalle.valor_neto),
        valor_neto_nuevo: valorNeto,
        motivo: String(req.body?.motivo || "").trim().slice(0, 500) || null
      },
      userId: req.user.id
    });
    await client.query("COMMIT");
    return res.json(updated.rows[0]);
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) { }
    }
    return handleError(res, error, "actualizando las retenciones");
  } finally {
    if (client) client.release();
  }
}

function normalizeEstadoDestino(value) {
  const normalized = normalizeText(value).replace(/\s+/g, " ");
  const estados = new Map([
    ["borrador", ESTADOS.BORRADOR],
    ["revision", ESTADOS.REVISION],
    ["revisado", ESTADOS.REVISION],
    ["revisar", ESTADOS.REVISION],
    ["aprobado", ESTADOS.APROBADO],
    ["aprobar", ESTADOS.APROBADO],
    ["pagado", ESTADOS.PAGADO],
    ["pagar", ESTADOS.PAGADO],
    ["cancelado", ESTADOS.CANCELADO],
    ["cancelar", ESTADOS.CANCELADO]
  ]);
  const estado = estados.get(normalized);
  if (!estado) throw new ContabilidadError("El estado destino no es válido");
  return estado;
}

async function sincronizarFuentesPorTransicion(client, proyeccionId, estadoDestino) {
  if (estadoDestino === ESTADOS.PAGADO) {
    await client.query(
      `UPDATE facturas_proveedores fp
       SET estado = 'Pagada', updated_at = CURRENT_TIMESTAMP
       WHERE fp.proyeccion_pago_id = $1`,
      [proyeccionId]
    );
    await client.query(
      `UPDATE nomina_pagos_manual np
       SET estado = 'Pagada', updated_at = CURRENT_TIMESTAMP
       WHERE np.proyeccion_pago_id = $1`,
      [proyeccionId]
    );
    return;
  }
  if (estadoDestino !== ESTADOS.CANCELADO) return;
  await client.query(
    `UPDATE cuenta_cobro
     SET proyeccion_pago_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE proyeccion_pago_id = $1`,
    [proyeccionId]
  );
  await client.query(
    `UPDATE facturas_proveedores
     SET proyeccion_pago_id = NULL, estado = 'Pendiente', updated_at = CURRENT_TIMESTAMP
     WHERE proyeccion_pago_id = $1 AND estado = 'Proyectada'`,
    [proyeccionId]
  );
  await client.query(
    `UPDATE nomina_pagos_manual
     SET proyeccion_pago_id = NULL, estado = 'Pendiente', updated_at = CURRENT_TIMESTAMP
     WHERE proyeccion_pago_id = $1 AND estado = 'Proyectada'`,
    [proyeccionId]
  );
}

async function transicionarProyeccion(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  let client;
  try {
    const id = assertUuid(req.params.id, "id");
    const destino = normalizeEstadoDestino(
      req.body?.estado ?? req.body?.nuevo_estado ?? req.body?.accion
    );
    client = await dbPool.connect();
    await client.query("BEGIN");
    const currentResult = await client.query(
      `SELECT * FROM proyeccion_pagos WHERE public_id = $1 LIMIT 1 FOR UPDATE`,
      [id]
    );
    const current = currentResult.rows[0];
    if (!current) throw new ContabilidadError("Proyección no encontrada", 404, "PROYECCION_NO_ENCONTRADA");
    if (current.estado === destino) {
      await client.query("COMMIT");
      return res.json({ ...mapProyeccion(current), sin_cambios: true });
    }
    if (!TRANSICIONES[current.estado]?.has(destino)) {
      throw new ContabilidadError(
        `No se permite cambiar de ${current.estado} a ${destino}`,
        409,
        "TRANSICION_NO_PERMITIDA"
      );
    }
    const updatedResult = await client.query(
      `
      UPDATE proyeccion_pagos
      SET estado = $1,
          revisado_por = CASE WHEN $1 = 'Revisión' THEN $2 ELSE revisado_por END,
          revisado_at = CASE WHEN $1 = 'Revisión' THEN CURRENT_TIMESTAMP ELSE revisado_at END,
          aprobado_por = CASE WHEN $1 = 'Aprobado' THEN $2 ELSE aprobado_por END,
          aprobado_at = CASE WHEN $1 = 'Aprobado' THEN CURRENT_TIMESTAMP ELSE aprobado_at END,
          pagado_por = CASE WHEN $1 = 'Pagado' THEN $2 ELSE pagado_por END,
          pagado_at = CASE WHEN $1 = 'Pagado' THEN CURRENT_TIMESTAMP ELSE pagado_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING public_id::text, mes, anio, quincena, trm_oficial, estado,
                fecha_pago_programada, revisado_at, aprobado_at, pagado_at,
                created_at, updated_at
      `,
      [destino, req.user.id, current.id]
    );
    await sincronizarFuentesPorTransicion(client, current.id, destino);
    await registrarAuditoria(client, {
      proyeccionId: current.id,
      evento: destino === ESTADOS.CANCELADO ? "CANCELACION" : "TRANSICION_ESTADO",
      estadoAnterior: current.estado,
      estadoNuevo: destino,
      datos: { comentario: String(req.body?.comentario || "").trim().slice(0, 1000) || null },
      userId: req.user.id
    });
    await client.query("COMMIT");
    return res.json(mapProyeccion(updatedResult.rows[0]));
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) { }
    }
    return handleError(res, error, "cambiando el estado de la proyección");
  } finally {
    if (client) client.release();
  }
}

async function actualizarCicloCuentaCobro(req, res, deps = {}) {
  const dbPool = deps.pool || pool;
  let client;
  try {
    const id = assertUuid(req.params.id, "id");
    const rawCiclo = req.body?.ciclo_proyeccion_asignado ?? req.body?.ciclo;
    if (rawCiclo === undefined) {
      throw new ContabilidadError("Debe indicar ciclo_proyeccion_asignado como Q1, Q2 o null");
    }
    const ciclo = rawCiclo === null || rawCiclo === "" ? null : normalizeCiclo(rawCiclo);
    client = await dbPool.connect();
    await client.query("BEGIN");
    const result = await client.query(
      `
      SELECT
        cc.id, cc.public_id::text, cc.ciclo_proyeccion_asignado,
        cc.proyeccion_pago_id, cc.total_cuenta_cobro,
        p.id AS persona_id, p.public_id::text AS persona_public_id,
        p.factura_en_colombia, p.es_gran_contribuyente, p.es_autorretenedor,
        p.es_regimen_simple, p.es_entidad_sin_animo_lucro, p.facturador_electronico,
        p.acumulado_facturacion_anual, p.declarante_renta, p.ciudad_residencia,
        COALESCE(p.moneda_cobro::text, u.moneda_cobro::text, 'COP') AS moneda_origen
      FROM cuenta_cobro cc
      LEFT JOIN usuarios u ON u.id = cc.created_by
      LEFT JOIN personas p ON p.id = u.persona_id
      WHERE cc.public_id = $1
      LIMIT 1
      FOR UPDATE OF cc
      `,
      [id]
    );
    const cuenta = result.rows[0];
    if (!cuenta) throw new ContabilidadError("Cuenta de cobro no encontrada", 404, "CUENTA_NO_ENCONTRADA");

    let movimiento = "override_actualizado";
    let proyeccionDestino = null;
    if (cuenta.proyeccion_pago_id) {
      if (!ciclo) {
        throw new ContabilidadError(
          "No se puede limpiar el ciclo mientras la cuenta pertenece a una proyección",
          409,
          "CUENTA_YA_PROYECTADA"
        );
      }
      const currentResult = await client.query(
        `SELECT id, public_id::text, anio, mes, quincena, estado, trm_oficial
         FROM proyeccion_pagos WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [cuenta.proyeccion_pago_id]
      );
      const current = currentResult.rows[0];
      if (!current || ![ESTADOS.BORRADOR, ESTADOS.REVISION].includes(current.estado)) {
        throw new ContabilidadError(
          "Solo se pueden mover cuentas de lotes en Borrador o Revisión",
          409,
          "PROYECCION_NO_EDITABLE"
        );
      }
      const quincenaDestino = ciclo === "Q1" ? 1 : 2;
      if (Number(current.quincena) !== quincenaDestino) {
        const detalleResult = await client.query(
          `SELECT id FROM proyeccion_pagos_detalle
           WHERE proyeccion_id = $1 AND origen_tipo = 'cuenta_cobro' AND origen_id = $2
           LIMIT 1 FOR UPDATE`,
          [current.id, cuenta.id]
        );
        const detalle = detalleResult.rows[0];
        if (!detalle) {
          throw new ContabilidadError(
            "La cuenta no tiene un detalle asociado en el lote actual",
            409,
            "DETALLE_CUENTA_INCONSISTENTE"
          );
        }
        const targetResult = await client.query(
          `
          SELECT id, public_id::text, anio, mes, quincena, estado, trm_oficial
          FROM proyeccion_pagos
          WHERE anio = $1 AND mes = $2 AND quincena = $3
            AND estado <> 'Cancelado' AND id <> $4
          LIMIT 1
          FOR UPDATE
          `,
          [current.anio, current.mes, quincenaDestino, current.id]
        );
        const target = targetResult.rows[0] || null;
        if (target && ![ESTADOS.BORRADOR, ESTADOS.REVISION].includes(target.estado)) {
          throw new ContabilidadError(
            `La proyección Q${quincenaDestino} ya está en estado ${target.estado}`,
            409,
            "PROYECCION_DESTINO_NO_EDITABLE"
          );
        }

        if (target) {
          const recalculado = prepararDetalle({
            origenTipo: "cuenta_cobro",
            origenId: cuenta.id,
            persona: personaFromRow(cuenta),
            tipoPago: "consultor",
            subtotal: cuenta.total_cuenta_cobro,
            iva: 0,
            moneda: cuenta.moneda_origen,
            trmOficial: target.trm_oficial === null ? null : Number(target.trm_oficial)
          });
          await client.query(
            `
            UPDATE proyeccion_pagos_detalle
            SET proyeccion_id = $1, tipo_pago = $2, moneda_origen = $3,
                valor_origen = $4, trm_aplicada = $5, subtotal = $6, iva = $7,
                retenciones_aplicadas = $8::jsonb, valor_neto = $9,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $10
            `,
            [
              target.id, recalculado.tipo_pago, recalculado.moneda_origen,
              recalculado.valor_origen, recalculado.trm_aplicada, recalculado.subtotal,
              recalculado.iva, JSON.stringify(recalculado.retenciones_aplicadas),
              recalculado.valor_neto, detalle.id
            ]
          );
          await client.query(
            `UPDATE cuenta_cobro
             SET ciclo_proyeccion_asignado = $1, proyeccion_pago_id = $2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [ciclo, target.id, cuenta.id]
          );
          await registrarAuditoria(client, {
            proyeccionId: current.id,
            detalleId: detalle.id,
            evento: "CAMBIO_QUINCENA_SALIDA",
            estadoAnterior: current.estado,
            estadoNuevo: current.estado,
            datos: { cuenta_cobro_id: cuenta.public_id, ciclo, proyeccion_destino: target.public_id },
            userId: req.user.id
          });
          await registrarAuditoria(client, {
            proyeccionId: target.id,
            detalleId: detalle.id,
            evento: "CAMBIO_QUINCENA_ENTRADA",
            estadoAnterior: target.estado,
            estadoNuevo: target.estado,
            datos: { cuenta_cobro_id: cuenta.public_id, ciclo, proyeccion_origen: current.public_id },
            userId: req.user.id
          });
          movimiento = "movida_a_proyeccion_existente";
          proyeccionDestino = target.public_id;
        } else {
          await registrarAuditoria(client, {
            proyeccionId: current.id,
            detalleId: detalle.id,
            evento: "CAMBIO_QUINCENA_PENDIENTE",
            estadoAnterior: current.estado,
            estadoNuevo: current.estado,
            datos: { cuenta_cobro_id: cuenta.public_id, ciclo },
            userId: req.user.id
          });
          await client.query(`DELETE FROM proyeccion_pagos_detalle WHERE id = $1`, [detalle.id]);
          await client.query(
            `UPDATE cuenta_cobro
             SET ciclo_proyeccion_asignado = $1, proyeccion_pago_id = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [ciclo, cuenta.id]
          );
          movimiento = "retirada_hasta_generar_proyeccion_destino";
        }
      } else {
        await client.query(
          `UPDATE cuenta_cobro
           SET ciclo_proyeccion_asignado = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [ciclo, cuenta.id]
        );
      }
    } else {
      await client.query(
        `UPDATE cuenta_cobro
         SET ciclo_proyeccion_asignado = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [ciclo, cuenta.id]
      );
    }

    const updated = await client.query(
      `SELECT cc.public_id::text, cc.ciclo_proyeccion_asignado, cc.updated_at,
              pp.public_id::text AS proyeccion_id
       FROM cuenta_cobro cc
       LEFT JOIN proyeccion_pagos pp ON pp.id = cc.proyeccion_pago_id
       WHERE cc.id = $1`,
      [cuenta.id]
    );
    await client.query("COMMIT");
    const cuentaActualizada = updated.rows[0];
    return res.json({
      id: cuentaActualizada.public_id,
      ciclo_proyeccion_asignado: cuentaActualizada.ciclo_proyeccion_asignado,
      proyeccion_id: cuentaActualizada.proyeccion_id,
      updated_at: cuentaActualizada.updated_at,
      movimiento,
      proyeccion_destino_id: proyeccionDestino
    });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) { }
    }
    return handleError(res, error, "actualizando el ciclo de la cuenta");
  } finally {
    if (client) client.release();
  }
}

function handleError(res, error, action) {
  if (
    error instanceof ContabilidadError ||
    error instanceof RetencionValidationError ||
    error instanceof CalendarioPagosValidationError
  ) {
    return res.status(error.statusCode || 400).json({
      error: error.message,
      codigo: error.code || error.name,
      ...(error.data ? { datos: error.data } : {})
    });
  }
  if (error?.code === "23505") {
    if (String(error.constraint || "").includes("proyeccion_pagos_detalle")) {
      return res.status(409).json({
        error: "El pago ya se encuentra en la proyección de destino",
        codigo: "PAGO_DUPLICADO_EN_PROYECCION"
      });
    }
    return res.status(409).json({
      error: "Ya existe una proyección activa para el periodo y la quincena indicados",
      codigo: "PROYECCION_DUPLICADA"
    });
  }
  if (error?.code === "22P02") {
    return res.status(400).json({ error: "Uno de los datos enviados no tiene un formato válido" });
  }
  console.error(`[contabilidad] Error ${action}:`, error);
  return res.status(500).json({ error: `No fue posible completar la operación: ${action}` });
}

module.exports = {
  actualizarCicloCuentaCobro,
  actualizarRetencionesDetalle,
  generarProyeccion,
  getDetallesProyeccion,
  previsualizarProyeccion,
  simularRetenciones,
  transicionarProyeccion,
  _private: {
    ContabilidadError,
    ESTADOS,
    TRANSICIONES,
    canonicalRetentionType,
    construirVistaPrevia,
    esExterior,
    mapDetalle,
    mapProyeccion,
    monedaOrigen,
    normalizeEstadoDestino,
    parseJsonArray,
    parseJsonObject,
    personaFromRow,
    prepararDetalle,
    retencionValue,
    validarGeneracion,
    validarRetencionesManuales
  }
};
