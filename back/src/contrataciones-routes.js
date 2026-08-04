const { findCorreoPersonaConflict } = require("./services/persona-identidad.service");
const { upsertPersonaDesdeContratacion } = require("./services/persona-contratacion.service");

module.exports = function registerContratacionesRoutes(deps) {
  const {
    app,
    pool,
    ID_TABLES,
    normalizeValue,
    requireAccess,
    getGraphContext,
    sendEmailSafe,
    buildEmailLayout,
    ensurePersistedAnexoFromProceso,
    resolveTalentoHumanoNotificationRecipients
  } = deps;

  const ESTADOS = Object.freeze({
    pendiente: "Pendiente",
    pendienteCoordinador: "Pendiente Coordinador",
    pendienteComercial: "Pendiente Comercial",
    enProceso: "En Proceso",
    pendienteConfirmacionCliente: "Pendiente Confirmación Cliente",
    pendienteRevisionTh: "Pendiente Revision TH",
    pendienteCorreoSilver: "Pendiente Correo Silver",
    completado: "Completado"
  });

  const TIPO_NUEVO = "Nuevo";
  const TIPO_EXTENSION = "Extension";
  const TIPO_RETIRO = "Retiro";
  const TIPOS_CUENTA = new Set(["Ahorros", "Corriente"]);

  const DESTINOS_MESA = parseEmailList(
    process.env.CONTRATACIONES_DESTINO_MESA ||
      "mesadeayuda@zettatech.com.co,jonathan.martinez@zettatech.com.co,richard.rendon@zettatech.com.co"
  );
  const DESTINOS_TH_FALLBACK =
    process.env.CONTRATACIONES_DESTINO_TH ||
    "catalina.loaiza@silverconsulting.com.co,ana.garcia@silverconsulting.com.co";

  const BASE_SELECT = `
    SELECT
      sc.id,
      sc.public_id,
      sc.tipo_solicitud,
      sc.estado,
      sc.crear_usuario_sistema,
      sc.origen_flujo,
      sc.coordinador_solicitante_id,
      coord.public_id AS coordinador_public_id,
      coord.nombre_usuario AS coordinador_nombre,
      coord.email AS coordinador_email,
      coord_rol.titulo AS coordinador_rol_titulo,
      sc.persona_usuario_id,
      persona.public_id AS persona_public_id,
      persona.nombre_usuario AS persona_nombre,
      persona.email AS persona_email,
      sc.supervisor_id,
      sup.public_id AS supervisor_public_id,
      sup.nombre_usuario AS supervisor_nombre,
      sup.email AS supervisor_email,
      sc.preregistro_id,
      sc.cliente_id,
      c.public_id AS cliente_public_id,
      c.titulo AS cliente_nombre,
      COALESCE(c.requiere_confirmacion_cliente, false) AS cliente_requiere_confirmacion_cliente,
      sc.tipo_documento_id,
      di.public_id AS tipo_documento_public_id,
      di.titulo AS tipo_documento_titulo,
      di.codigo AS tipo_documento_codigo,
      sc.nombre,
      sc.apellidos,
      sc.numero_documento,
      sc.perfil,
      sc.correo_personal,
      sc.correo_empresarial,
      sc.telefono,
      sc.ubicacion,
      sc.grupo_app_tiempos,
      sc.grupo_distribucion,
      sc.vpn_corona,
      sc.necesita_s_user,
      sc.grupo_usuario_otro,
      sc.moneda,
      sc.tarifa_hora,
      sc.tarifa_mes,
      sc.tarifa_medio_tiempo,
      sc.tarifa_capacitacion,
      sc.modalidad_contrato,
      sc.fecha_inicio,
      sc.fecha_fin,
      sc.fecha_extension_desde,
      sc.fecha_extension_hasta,
      sc.fecha_retiro,
      sc.necesidad_ti,
      sc.observaciones,
      sc.datos_extra,
      COALESCE(sc.requiere_confirmacion_cliente, false) AS requiere_confirmacion_cliente,
      COALESCE(sc.correo_enviado_mesa, false) AS correo_enviado_mesa,
      COALESCE(sc.correo_enviado_th, false) AS correo_enviado_th,
      COALESCE(sc.correo_confirmacion_coordinador, false) AS correo_confirmacion_coordinador,
      sc.revisado_th_por,
      rev_th.public_id AS revisado_th_por_public_id,
      rev_th.nombre_usuario AS revisado_th_por_nombre,
      sc.fecha_revision_th,
      sc.observaciones_th,
      sc.created_at,
      sc.updated_at
    FROM solicitudes_contratacion sc
    LEFT JOIN usuarios coord ON coord.id = sc.coordinador_solicitante_id
    LEFT JOIN roles coord_rol ON coord_rol.id = coord.rol_usuario_id
    LEFT JOIN usuarios persona ON persona.id = sc.persona_usuario_id
    LEFT JOIN usuarios sup ON sup.id = sc.supervisor_id
    LEFT JOIN clientes c ON c.id = sc.cliente_id
    LEFT JOIN documento_identidad di ON di.id = sc.tipo_documento_id
    LEFT JOIN usuarios rev_th ON rev_th.id = sc.revisado_th_por
  `;

  function parseEmailList(value) {
    return String(value || "")
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async function getDestinosTalentoHumano() {
    if (typeof resolveTalentoHumanoNotificationRecipients === "function") {
      return resolveTalentoHumanoNotificationRecipients({ fallback: DESTINOS_TH_FALLBACK });
    }
    return parseEmailList(DESTINOS_TH_FALLBACK);
  }

  function normalizeKey(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/gi, "")
      .toLowerCase()
      .trim();
  }

  function normalizeTipoSolicitud(value) {
    const key = normalizeKey(value);
    if (["nuevo", "nuevocontrato", "crear", "crearsolicitud", "contratacion"].includes(key)) {
      return TIPO_NUEVO;
    }
    if (["extension", "extencion", "modificacion", "modificar", "ampliacion"].includes(key)) {
      return TIPO_EXTENSION;
    }
    if (["retiro", "cancelacion", "retirar", "finalizar"].includes(key)) {
      return TIPO_RETIRO;
    }
    return null;
  }

  function normalizeMoneda(value) {
    const raw = String(value || "").trim().toUpperCase();
    if (!raw) return null;
    if (raw === "COP" || raw === "USD" || raw === "EUR") return raw;
    return null;
  }

  function normalizeModalidad(value) {
    const key = normalizeKey(value);
    if (!key) return null;
    if (["fulltime", "tiempocompleto", "completo"].includes(key)) return "Full time";
    if (["mediotiempo", "parttime", "part", "medio"].includes(key)) return "Medio tiempo";
    if (["porhoras", "horas", "hourly"].includes(key)) return "Por horas";
    return null;
  }

  function normalizeDateOnly(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (direct?.[1]) return direct[1];
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
  }

  function toNullableString(value) {
    const raw = String(value || "").trim();
    return raw || null;
  }

  function toNullableNumber(value) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeFacturaEnColombiaInput(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "boolean") return value;
    const raw = String(value).trim().toLowerCase();
    if (["true", "1", "si", "sí", "yes", "on"].includes(raw)) return true;
    if (["false", "0", "no", "off"].includes(raw)) return false;
    return null;
  }

  function normalizeBooleanFlag(value, fallback = true) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    const raw = String(value).trim().toLowerCase();
    if (["true", "1", "si", "sí", "yes", "on"].includes(raw)) return true;
    if (["false", "0", "no", "off"].includes(raw)) return false;
    return null;
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(value || "").trim()
    );
  }

  async function resolveBancoInternalId(db, bancoValue) {
    if (bancoValue === undefined || bancoValue === null || bancoValue === "") return null;

    const numeric = toNullableNumber(bancoValue);
    if (numeric && Number.isInteger(numeric) && numeric > 0) {
      const exists = await db.query(`SELECT id FROM bancos WHERE id = $1 LIMIT 1`, [numeric]);
      return exists.rows.length ? numeric : null;
    }

    const raw = String(bancoValue || "").trim();
    if (isUuid(raw)) {
      const resolved = await db.query(`SELECT id FROM bancos WHERE public_id = $1 LIMIT 1`, [raw]);
      return resolved.rows[0]?.id || null;
    }

    return null;
  }

  async function resolveBancoPublicId(db, bancoInternalId) {
    if (!bancoInternalId) return null;
    const result = await db.query(`SELECT public_id FROM bancos WHERE id = $1 LIMIT 1`, [bancoInternalId]);
    return result.rows[0]?.public_id || null;
  }

  async function fetchPersonaLegalContext(db, { personaUsuarioId = null, numeroDocumento = null } = {}) {
    if (!personaUsuarioId && !numeroDocumento) return null;

    const result = await db.query(
      `
      WITH usuario_base AS (
        SELECT u.*
        FROM usuarios u
        WHERE
          ($1::int IS NOT NULL AND u.id = $1)
          OR ($2::text IS NOT NULL AND COALESCE(u.cedula, '') = $2)
        ORDER BY
          CASE WHEN $1::int IS NOT NULL AND u.id = $1 THEN 0 ELSE 1 END,
          u.id DESC
        LIMIT 1
      ),
      persona_base AS (
        SELECT p.*
        FROM personas p
        LEFT JOIN usuario_base u ON TRUE
        WHERE
          (u.persona_id IS NOT NULL AND p.id = u.persona_id)
          OR ($2::text IS NOT NULL AND COALESCE(p.numero_documento, '') = $2)
          OR (u.cedula IS NOT NULL AND COALESCE(p.numero_documento, '') = u.cedula)
        ORDER BY
          CASE WHEN p.id = (SELECT persona_id FROM usuario_base LIMIT 1) THEN 0 ELSE 1 END,
          p.updated_at DESC NULLS LAST,
          p.id DESC
        LIMIT 1
      )
      SELECT
        COALESCE(p.direccion_residencia, u.direccion) AS direccion,
        COALESCE(p.tipo_persona::text, u.tipo_persona::text) AS tipo_persona,
        COALESCE(p.factura_en_colombia, u.factura_en_colombia) AS factura_en_colombia,
        COALESCE(bp.public_id, bu.public_id) AS banco_id,
        COALESCE(bp.titulo, bu.titulo) AS banco_nombre,
        COALESCE(tcp.titulo, tcu.titulo) AS tipo_cuenta,
        COALESCE(p.numero_cuenta, u.nro_cuenta_bancaria) AS numero_cuenta,
        p.razon_social,
        p.nit_empresa,
        p.representante_legal,
        p.tipo_documento_representante,
        p.numero_documento_representante
      FROM usuario_base u
      FULL JOIN persona_base p ON TRUE
      LEFT JOIN bancos bp ON bp.id = p.banco_id
      LEFT JOIN bancos bu ON bu.id = u.banco_id
      LEFT JOIN tipo_cuenta_bancaria tcp ON tcp.id = p.tipo_cuenta_id
      LEFT JOIN tipo_cuenta_bancaria tcu ON tcu.id = u.tipo_cuenta_id
      LIMIT 1
      `,
      [personaUsuarioId || null, numeroDocumento || null]
    );

    return result.rows[0] || null;
  }

  function mergeLegalContextIntoDatosExtra(datosExtra, legalContext) {
    if (!legalContext) return datosExtra;

    const next = datosExtra || {};
    const tipoPersona = normalizeTipoPersonaForForm(legalContext.tipo_persona);
    if (!next.direccion && legalContext.direccion) next.direccion = legalContext.direccion;
    if (!next.tipo_persona && tipoPersona) next.tipo_persona = tipoPersona;
    if (next.factura_en_colombia === undefined || next.factura_en_colombia === null) {
      if (legalContext.factura_en_colombia !== undefined && legalContext.factura_en_colombia !== null) {
        next.factura_en_colombia = Boolean(legalContext.factura_en_colombia);
      }
    }
    if (!next.banco_id && legalContext.banco_id) next.banco_id = legalContext.banco_id;
    if (!next.banco_nombre && legalContext.banco_nombre) next.banco_nombre = legalContext.banco_nombre;
    if (!next.tipo_cuenta && legalContext.tipo_cuenta) next.tipo_cuenta = legalContext.tipo_cuenta;
    if (!next.numero_cuenta && legalContext.numero_cuenta) next.numero_cuenta = legalContext.numero_cuenta;
    if (!next.razon_social && legalContext.razon_social) next.razon_social = legalContext.razon_social;
    if (!next.nit_empresa && legalContext.nit_empresa) next.nit_empresa = legalContext.nit_empresa;
    if (!next.representante_legal && legalContext.representante_legal) next.representante_legal = legalContext.representante_legal;
    if (!next.tipo_documento_representante && legalContext.tipo_documento_representante) {
      next.tipo_documento_representante = legalContext.tipo_documento_representante;
    }
    if (!next.numero_documento_representante && legalContext.numero_documento_representante) {
      next.numero_documento_representante = legalContext.numero_documento_representante;
    }
    return next;
  }

  function normalizeTipoPersonaForForm(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const ascii = raw
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    if (ascii.includes("jur")) return "Juridica";
    if (ascii === "natural") return "Natural";
    return null;
  }

  function isValidSilverEmail(value) {
    return /^[^\s@]+@silverconsulting\.com\.co$/i.test(String(value || "").trim());
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  function normalizeTipoPersonaForUsuarios(value) {
    const raw = normalizeValue(value);
    if (raw === "natural") return "Natural";
    if (raw === "juridica") return "Jurídica";
    return null;
  }

  function normalizeTipoPersonaForPreregistro(value) {
    const raw = normalizeValue(value);
    if (raw === "natural") return "Natural";
    if (raw === "juridica") return "Jurídica";
    return null;
  }

  function toObjectOrEmpty(value) {
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch (_) {}
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
    return {};
  }

  async function resolveModuloInternalId(db, value) {
    if (!value) return null;
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric > 0) {
      const result = await db.query(`SELECT id FROM modulo WHERE id = $1 LIMIT 1`, [numeric]);
      return result.rows[0]?.id || null;
    }
    if (!isUuid(value)) return null;
    const result = await db.query(
      `SELECT id FROM modulo WHERE public_id::text = $1::text LIMIT 1`,
      [String(value).trim()]
    );
    return result.rows[0]?.id || null;
  }

  async function materializePersonaDesdeSolicitud(db, solicitudRow, actorUserId = null) {
    const datosExtra = toObjectOrEmpty(solicitudRow.datos_extra);
    const tipoCuenta = toNullableString(datosExtra.tipo_cuenta);
    const [bancoId, moduloId, tipoCuentaResult] = await Promise.all([
      resolveBancoInternalId(db, datosExtra.banco_id),
      resolveModuloInternalId(db, datosExtra.modulo_id),
      db.query(
        `SELECT id FROM tipo_cuenta_bancaria WHERE LOWER(titulo) LIKE LOWER($1) LIMIT 1`,
        [`${tipoCuenta || ""}%`]
      )
    ]);
    const facturaEnColombia =
      datosExtra.factura_en_colombia === true || datosExtra.factura_en_colombia === "true"
        ? true
        : datosExtra.factura_en_colombia === false || datosExtra.factura_en_colombia === "false"
          ? false
          : null;

    return upsertPersonaDesdeContratacion(db, {
      numero_documento: solicitudRow.numero_documento,
      tipo_documento_id: solicitudRow.tipo_documento_id,
      nombre: solicitudRow.nombre,
      apellidos: solicitudRow.apellidos,
      numero_contacto: solicitudRow.telefono,
      correo_electronico: solicitudRow.correo_personal,
      direccion_residencia: toNullableString(datosExtra.direccion),
      ciudad_residencia: solicitudRow.ubicacion,
      tipo_persona: normalizeTipoPersonaForUsuarios(datosExtra.tipo_persona),
      factura_en_colombia: facturaEnColombia,
      banco_id: bancoId,
      tipo_cuenta_id: tipoCuentaResult.rows[0]?.id || null,
      numero_cuenta: toNullableString(datosExtra.numero_cuenta),
      modulo_id: moduloId,
      modulo_otro: moduloId
        ? null
        : toNullableString(
            datosExtra.modulo_nombre || datosExtra.modulo_otro || datosExtra.modulo || solicitudRow.perfil
          ),
      cliente_id: solicitudRow.cliente_id || null,
      cliente_otro: solicitudRow.cliente_id ? null : toNullableString(datosExtra.cliente_nombre),
      razon_social: toNullableString(datosExtra.razon_social),
      nit_empresa: toNullableString(datosExtra.nit_empresa),
      representante_legal: toNullableString(datosExtra.representante_legal),
      tipo_documento_representante: toNullableString(datosExtra.tipo_documento_representante),
      numero_documento_representante: toNullableString(datosExtra.numero_documento_representante),
      preregistro_id: solicitudRow.preregistro_id || null,
      created_by: actorUserId
    });
  }

  function isSolicitudRrhh(row) {
    return String(row?.origen_flujo || "").trim().toLowerCase() === "rrhh";
  }

  function mapSolicitudEstadoToPreregistroEstado(estado) {
    const raw = String(estado || "").trim();
    if (!raw) return null;
    if (raw === ESTADOS.pendiente || raw === ESTADOS.pendienteCoordinador) return ESTADOS.pendienteCoordinador;
    if (raw === ESTADOS.pendienteComercial) return ESTADOS.pendienteComercial;
    if (raw === ESTADOS.pendienteRevisionTh) return ESTADOS.pendienteRevisionTh;
    if (raw === ESTADOS.pendienteCorreoSilver) return ESTADOS.pendienteCorreoSilver;
    if (raw === ESTADOS.completado) return ESTADOS.completado;
    if (raw === "Cancelado") return "Anulado";
    return null;
  }

  async function syncLinkedPreregistroFromSolicitud(
    db,
    solicitudRow,
    { actorUserId = null, markCoordinadorCompletion = false, markThCompletion = false, markApproval = false } = {}
  ) {
    if (!solicitudRow?.preregistro_id || !isSolicitudRrhh(solicitudRow)) return null;

    const datosExtra = toObjectOrEmpty(solicitudRow.datos_extra);
    const nextEstado = mapSolicitudEstadoToPreregistroEstado(solicitudRow.estado);
    const direccion = toNullableString(datosExtra.direccion);
    const tipoPersona = normalizeTipoPersonaForPreregistro(datosExtra.tipo_persona);
    const tipoCuenta = toNullableString(datosExtra.tipo_cuenta);
    const numeroCuenta = toNullableString(datosExtra.numero_cuenta);
    const correoSilver = toNullableString(solicitudRow.correo_empresarial);
    const bancoId = await resolveBancoInternalId(db, datosExtra.banco_id);

    const sets = [];
    const values = [];
    let idx = 1;

    if (nextEstado) {
      sets.push(`estado = $${idx++}`);
      values.push(nextEstado);
    }

    if (direccion !== null) {
      sets.push(`direccion = COALESCE($${idx++}, direccion)`);
      values.push(direccion);
    }
    if (tipoPersona !== null) {
      sets.push(`tipo_persona = COALESCE($${idx++}, tipo_persona)`);
      values.push(tipoPersona);
    }
    if (bancoId) {
      sets.push(`banco_id = COALESCE($${idx++}, banco_id)`);
      values.push(bancoId);
    }
    if (tipoCuenta !== null) {
      sets.push(`tipo_cuenta = COALESCE($${idx++}, tipo_cuenta)`);
      values.push(tipoCuenta);
    }
    if (numeroCuenta !== null) {
      sets.push(`numero_cuenta = COALESCE($${idx++}, numero_cuenta)`);
      values.push(numeroCuenta);
    }
    if (correoSilver !== null) {
      sets.push(`correo_silver = COALESCE($${idx++}, correo_silver)`);
      values.push(correoSilver);
    }
    sets.push(`crear_usuario_sistema = $${idx++}`);
    values.push(solicitudRow.crear_usuario_sistema !== false);

    if (Object.prototype.hasOwnProperty.call(datosExtra, "vpn_corona")) {
      sets.push(`vpn_corona = $${idx++}`);
      values.push(Boolean(datosExtra.vpn_corona));
    }
    if (Object.prototype.hasOwnProperty.call(datosExtra, "necesita_s_user")) {
      sets.push(`necesita_s_user = $${idx++}`);
      values.push(Boolean(datosExtra.necesita_s_user));
    }
    if (solicitudRow.grupo_usuario_otro !== undefined && solicitudRow.grupo_usuario_otro !== null) {
      sets.push(`grupo_usuario_otro = $${idx++}`);
      values.push(solicitudRow.grupo_usuario_otro);
    }

    const VALID_GRUPO_USUARIO = ["ADMIN", "COORDINADOR", "CONSULTOR", "CONTABILIDAD", "COMERCIAL", "Otro"];
    const grupoUsuario = toNullableString(datosExtra.grupo_usuario || solicitudRow.grupo_app_tiempos);
    if (grupoUsuario && VALID_GRUPO_USUARIO.includes(grupoUsuario)) {
      sets.push(`grupo_usuario = $${idx++}`);
      values.push(grupoUsuario);
    }

    const VALID_GRUPO_DISTRIBUCION = ["Todos Silver", "Vinculados", "Responsable"];
    const grupoDistribucion = toNullableString(datosExtra.grupo_distribucion || solicitudRow.grupo_distribucion);
    if (grupoDistribucion && VALID_GRUPO_DISTRIBUCION.includes(grupoDistribucion)) {
      sets.push(`grupo_distribucion = $${idx++}`);
      values.push(grupoDistribucion);
    }

    if (solicitudRow.ubicacion) {
      sets.push(`pais_ubicacion = COALESCE($${idx++}, pais_ubicacion)`);
      values.push(solicitudRow.ubicacion);
    }

    if (markCoordinadorCompletion && actorUserId) {
      sets.push(`completado_coordinador_por = COALESCE(completado_coordinador_por, $${idx++})`);
      values.push(actorUserId);
      sets.push(`fecha_completado_coordinador = COALESCE(fecha_completado_coordinador, NOW())`);
    }

    if (markThCompletion && actorUserId) {
      sets.push(`completado_th_por = $${idx++}`);
      values.push(actorUserId);
      sets.push(`fecha_completado_th = NOW()`);
    }

    if (markApproval) {
      if (actorUserId) {
        sets.push(`aprobado_por = $${idx++}`);
        values.push(actorUserId);
      }
      sets.push(`id_usuario_creado = COALESCE($${idx++}, id_usuario_creado)`);
      values.push(solicitudRow.persona_usuario_id || null);
      sets.push(`fecha_aprobacion = COALESCE(fecha_aprobacion, NOW())`);
    }

    if (!sets.length) return null;

    sets.push(`updated_at = NOW()`);
    values.push(solicitudRow.preregistro_id);

    const result = await db.query(
      `
      UPDATE preregistro_personas
      SET ${sets.join(", ")}
      WHERE id = $${idx}
      RETURNING id
      `,
      values
    );

    return result.rows[0] || null;
  }

  function formatDateForEmail(value) {
    const raw = String(value || "").trim();
    if (!raw) return "N/A";

    const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) {
      const year = Number(ymd[1]);
      const month = Number(ymd[2]);
      const day = Number(ymd[3]);
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
        const utcDate = new Date(Date.UTC(year, month - 1, day));
        return utcDate.toLocaleDateString("es-CO", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "UTC"
        });
      }
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleDateString("es-CO", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC"
    });
  }

  function normalizeAnexoTipo(value) {
    const key = normalizeKey(value);
    if (!key) return null;
    if (["fulltime", "tiempocompleto", "completo"].includes(key)) return "full_time";
    if (["mediotiempo", "parttime", "part", "medio"].includes(key)) return "medio_tiempo";
    if (["horas", "porhoras", "hourly"].includes(key)) return "horas";
    if (["capacitacion", "training"].includes(key)) return "capacitacion";
    if (["proyecto", "project"].includes(key)) return "proyecto";
    return null;
  }

  function anexoTipoLabel(value) {
    const tipo = normalizeAnexoTipo(value);
    return (
      {
        full_time: "Full time",
        medio_tiempo: "Medio tiempo",
        horas: "Horas",
        capacitacion: "Capacitacion",
        proyecto: "Proyecto"
      }[tipo] || null
    );
  }

  function extensionTipoRequiereFechas(value) {
    const tipo = normalizeAnexoTipo(value);
    return tipo === "full_time" || tipo === "medio_tiempo" || tipo === "proyecto";
  }

  function anexoTipoToModalidad(value) {
    const tipo = normalizeAnexoTipo(value);
    if (tipo === "medio_tiempo") return "Medio tiempo";
    if (tipo === "horas" || tipo === "capacitacion") return "Por horas";
    if (tipo === "full_time") return "Full time";
    return null;
  }

  function mapTarifaFieldsByTipo(tipo, valor) {
    const amount = toNullableNumber(valor);
    const normalized = normalizeAnexoTipo(tipo);
    return {
      tarifa_hora: normalized === "horas" && amount !== null ? amount : null,
      tarifa_mes: (normalized === "full_time" || normalized === "proyecto") && amount !== null ? amount : null,
      tarifa_medio_tiempo: normalized === "medio_tiempo" && amount !== null ? amount : null,
      tarifa_capacitacion: normalized === "capacitacion" && amount !== null ? amount : null
    };
  }

  function formatMoneyInline(value, moneda = "COP") {
    const amount = toNullableNumber(value);
    const currency = normalizeMoneda(moneda) || "COP";
    if (amount === null) return null;
    try {
      return new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency,
        maximumFractionDigits: 2
      }).format(amount);
    } catch (_) {
      return `${currency} ${amount}`;
    }
  }

  function pickFirst(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  }

  async function resolveUsuarioMeta(internalId) {
    if (!internalId) return null;
    const result = await pool.query(
      `
      SELECT id, public_id, nombre_usuario, email
      FROM usuarios
      WHERE id = $1
      LIMIT 1
      `,
      [internalId]
    );
    return result.rows[0] || null;
  }

  async function findPersonaBaseUser({ userInternalId = null, numeroDocumento = null, correoEmpresarial = null } = {}) {
    if (!userInternalId && !numeroDocumento && !correoEmpresarial) return null;
    const result = await pool.query(
      `
      SELECT
        u.id,
        u.public_id,
        u.nombre_usuario,
        u.email,
        u.cedula,
        u.telefono,
        u.moneda_cobro,
        di.public_id AS tipo_documento_public_id,
        di.titulo AS tipo_documento_titulo,
        di.codigo AS tipo_documento_codigo
      FROM usuarios u
      LEFT JOIN documento_identidad di ON di.id = u.tipo_documento_id
      WHERE u.activo = true
        AND (
          ($1::int IS NOT NULL AND u.id = $1)
          OR ($2::text IS NOT NULL AND u.cedula = $2)
          OR ($3::text IS NOT NULL AND LOWER(COALESCE(u.email, '')) = LOWER($3))
        )
      ORDER BY
        CASE WHEN u.id = $1 THEN 0 ELSE 1 END,
        u.nombre_usuario ASC
      LIMIT 1
      `,
      [userInternalId || null, numeroDocumento || null, correoEmpresarial || null]
    );
    return result.rows[0] || null;
  }

  async function findActiveAnexoForPersona({
    userInternalId = null,
    numeroDocumento = null,
    correoPersonal = null,
    correoEmpresarial = null
  } = {}) {
    if (!userInternalId && !numeroDocumento && !correoPersonal && !correoEmpresarial) return null;
    const result = await pool.query(
      `
      SELECT
        ati.id,
        ati.public_id,
        ati.usuario_id,
        ati.tipo_asignacion,
        ati.correo_personal,
        ati.cliente_id,
        c.public_id AS cliente_public_id,
        COALESCE(c.titulo, ati.cliente_nombre) AS cliente_nombre,
        ati.modulo_id,
        m.public_id AS modulo_public_id,
        ati.modulo_nombre,
        COALESCE(m.titulo, ati.modulo_nombre) AS modulo_titulo,
        ati.moneda,
        ati.valor_tarifa,
        ati.fecha_inicio,
        ati.fecha_fin,
        ati.fecha_fin_calculada,
        ati.estado_firma
      FROM anexo_tecnico_items ati
      LEFT JOIN clientes c ON c.id = ati.cliente_id
      LEFT JOIN modulo m ON m.id = ati.modulo_id
      WHERE ati.estado = 'activo'
        AND (
          ($1::int IS NOT NULL AND ati.usuario_id = $1)
          OR ($2::text IS NOT NULL AND ati.numero_documento = $2)
          OR ($3::text IS NOT NULL AND LOWER(COALESCE(ati.correo_personal, '')) = LOWER($3))
          OR ($4::text IS NOT NULL AND LOWER(COALESCE(ati.correo_personal, '')) = LOWER($4))
        )
      ORDER BY
        CASE WHEN ati.usuario_id = $1 THEN 0 ELSE 1 END,
        ati.fecha_inicio DESC NULLS LAST,
        ati.updated_at DESC NULLS LAST,
        ati.created_at DESC
      LIMIT 1
      `,
      [userInternalId || null, numeroDocumento || null, correoPersonal || null, correoEmpresarial || null]
    );
    return result.rows[0] || null;
  }

  async function findAllActiveAnexosForPersona({
    userInternalId = null,
    numeroDocumento = null,
    correoPersonal = null,
    correoEmpresarial = null
  } = {}) {
    if (!userInternalId && !numeroDocumento && !correoPersonal && !correoEmpresarial) return [];
    const result = await pool.query(
      `
      SELECT
        ati.id,
        ati.public_id,
        ati.usuario_id,
        ati.tipo_asignacion,
        ati.correo_personal,
        ati.cliente_id,
        c.public_id AS cliente_public_id,
        COALESCE(c.titulo, ati.cliente_nombre) AS cliente_nombre,
        ati.modulo_id,
        m.public_id AS modulo_public_id,
        ati.modulo_nombre,
        COALESCE(m.titulo, ati.modulo_nombre) AS modulo_titulo,
        ati.moneda,
        ati.valor_tarifa,
        ati.fecha_inicio,
        ati.fecha_fin,
        ati.fecha_fin_calculada,
        ati.estado_firma
      FROM anexo_tecnico_items ati
      LEFT JOIN clientes c ON c.id = ati.cliente_id
      LEFT JOIN modulo m ON m.id = ati.modulo_id
      WHERE ati.estado = 'activo'
        AND (
          ($1::int IS NOT NULL AND ati.usuario_id = $1)
          OR ($2::text IS NOT NULL AND ati.numero_documento = $2)
          OR ($3::text IS NOT NULL AND LOWER(COALESCE(ati.correo_personal, '')) = LOWER($3))
          OR ($4::text IS NOT NULL AND LOWER(COALESCE(ati.correo_personal, '')) = LOWER($4))
        )
      ORDER BY
        CASE WHEN ati.usuario_id = $1 THEN 0 ELSE 1 END,
        ati.fecha_inicio DESC NULLS LAST,
        ati.updated_at DESC NULLS LAST,
        ati.created_at DESC
      `,
      [userInternalId || null, numeroDocumento || null, correoPersonal || null, correoEmpresarial || null]
    );
    return result.rows;
  }

  async function findLatestSolicitudForPersona({ userInternalId = null, numeroDocumento = null, correoEmpresarial = null } = {}) {
    if (!userInternalId && !numeroDocumento && !correoEmpresarial) return null;
    const result = await pool.query(
      `
      SELECT
        sc.id,
        sc.public_id,
        sc.tipo_solicitud,
        sc.perfil,
        sc.correo_personal,
        sc.correo_empresarial,
        sc.moneda,
        sc.tarifa_hora,
        sc.tarifa_mes,
        sc.tarifa_medio_tiempo,
        sc.tarifa_capacitacion,
        sc.modalidad_contrato,
        sc.fecha_inicio,
        sc.fecha_fin,
        sc.fecha_extension_desde,
        sc.fecha_extension_hasta,
        sc.datos_extra,
        sc.supervisor_id,
        sup.public_id AS supervisor_public_id,
        sup.nombre_usuario AS supervisor_nombre,
        sup.email AS supervisor_email,
        sc.cliente_id,
        c.public_id AS cliente_public_id,
        c.titulo AS cliente_nombre
      FROM solicitudes_contratacion sc
      LEFT JOIN usuarios sup ON sup.id = sc.supervisor_id
      LEFT JOIN clientes c ON c.id = sc.cliente_id
      WHERE sc.tipo_solicitud <> $4
        AND (
          ($1::int IS NOT NULL AND sc.persona_usuario_id = $1)
          OR ($2::text IS NOT NULL AND sc.numero_documento = $2)
          OR ($3::text IS NOT NULL AND LOWER(COALESCE(sc.correo_empresarial, '')) = LOWER($3))
        )
      ORDER BY sc.updated_at DESC NULLS LAST, sc.created_at DESC
      LIMIT 1
      `,
      [userInternalId || null, numeroDocumento || null, correoEmpresarial || null, TIPO_RETIRO]
    );
    return result.rows[0] || null;
  }

  async function findLatestPreregistroForPersona({ userInternalId = null, numeroDocumento = null, correoPersonal = null } = {}) {
    if (!userInternalId && !numeroDocumento && !correoPersonal) return null;
    const result = await pool.query(
      `
      SELECT
        pp.id,
        pp.public_id,
        pp.correo_personal,
        pp.moneda,
        pp.tarifa_hora,
        pp.tarifa_mes,
        pp.tarifa_medio_tiempo,
        pp.tarifa_capacitacion,
        pp.fecha_fin,
        sr.modulo_id,
        m.public_id AS modulo_public_id,
        m.titulo AS modulo_titulo,
        sr.cliente_id,
        c.public_id AS cliente_public_id,
        c.titulo AS cliente_nombre
      FROM preregistro_personas pp
      LEFT JOIN solicitudes_rrhh sr ON sr.id = pp.id_solicitud_rrhh
      LEFT JOIN modulo m ON m.id = sr.modulo_id
      LEFT JOIN clientes c ON c.id = sr.cliente_id
      WHERE (
          ($1::int IS NOT NULL AND pp.id_usuario_creado = $1)
          OR ($2::text IS NOT NULL AND pp.numero_documento = $2)
          OR ($3::text IS NOT NULL AND LOWER(COALESCE(pp.correo_personal, '')) = LOWER($3))
        )
      ORDER BY pp.updated_at DESC NULLS LAST, pp.created_at DESC
      LIMIT 1
      `,
      [userInternalId || null, numeroDocumento || null, correoPersonal || null]
    );
    return result.rows[0] || null;
  }

  async function buildPersonaExtensionContext({
    userInternalId = null,
    numeroDocumento = null,
    correoPersonal = null,
    correoEmpresarial = null,
    baseUserRow = null,
    preferAnexoItemId = null
  } = {}) {
    const baseUser =
      baseUserRow ||
      (await findPersonaBaseUser({
        userInternalId,
        numeroDocumento,
        correoEmpresarial
      }));
    const resolvedUserId = baseUser?.id || userInternalId || null;
    const resolvedDocumento = numeroDocumento || baseUser?.cedula || null;

    const [todosAnexosActivos, solicitudActual, preregistroActual] = await Promise.all([
      findAllActiveAnexosForPersona({
        userInternalId: resolvedUserId,
        numeroDocumento: resolvedDocumento,
        correoPersonal,
        correoEmpresarial: correoEmpresarial || baseUser?.email || null
      }),
      findLatestSolicitudForPersona({
        userInternalId: resolvedUserId,
        numeroDocumento: resolvedDocumento,
        correoEmpresarial: correoEmpresarial || baseUser?.email || null
      }),
      findLatestPreregistroForPersona({
        userInternalId: resolvedUserId,
        numeroDocumento: resolvedDocumento,
        correoPersonal
      })
    ]);
    const anexoActivo = (preferAnexoItemId
      ? todosAnexosActivos.find((a) => String(a.public_id) === String(preferAnexoItemId))
      : null) || todosAnexosActivos[0] || null;

    const tipoAsignacion =
      normalizeAnexoTipo(anexoActivo?.tipo_asignacion) ||
      normalizeAnexoTipo(toObjectOrEmpty(solicitudActual?.datos_extra)?.tipo_asignacion) ||
      normalizeAnexoTipo(solicitudActual?.modalidad_contrato);
    const tarifasAnexo = mapTarifaFieldsByTipo(tipoAsignacion, anexoActivo?.valor_tarifa);

    return {
      user: baseUser
        ? {
            id: baseUser.public_id,
            internal_id: baseUser.id,
            nombre: baseUser.nombre_usuario,
            email: baseUser.email || null,
            numero_documento: baseUser.cedula || resolvedDocumento || null,
            telefono: baseUser.telefono || null,
            moneda: baseUser.moneda_cobro || null,
            tipo_documento_id: baseUser.tipo_documento_public_id || null,
            tipo_documento_titulo: baseUser.tipo_documento_titulo || null,
            tipo_documento_codigo: baseUser.tipo_documento_codigo || null
          }
        : null,
      correo_personal: pickFirst(anexoActivo?.correo_personal, solicitudActual?.correo_personal, preregistroActual?.correo_personal, correoPersonal),
      correo_empresarial: pickFirst(baseUser?.email, solicitudActual?.correo_empresarial, correoEmpresarial),
      cliente_id: pickFirst(anexoActivo?.cliente_public_id, solicitudActual?.cliente_public_id, preregistroActual?.cliente_public_id),
      cliente_nombre: pickFirst(anexoActivo?.cliente_nombre, solicitudActual?.cliente_nombre, preregistroActual?.cliente_nombre),
      supervisor_id: solicitudActual?.supervisor_public_id || null,
      supervisor_nombre: solicitudActual?.supervisor_nombre || null,
      supervisor_email: solicitudActual?.supervisor_email || null,
      perfil: pickFirst(anexoActivo?.modulo_titulo, solicitudActual?.perfil, preregistroActual?.modulo_titulo),
      modulo_id: pickFirst(anexoActivo?.modulo_public_id, preregistroActual?.modulo_public_id),
      modulo_nombre: pickFirst(anexoActivo?.modulo_titulo, preregistroActual?.modulo_titulo, solicitudActual?.perfil),
      moneda: pickFirst(anexoActivo?.moneda, solicitudActual?.moneda, preregistroActual?.moneda, baseUser?.moneda_cobro),
      modalidad_contrato: pickFirst(solicitudActual?.modalidad_contrato, anexoTipoToModalidad(tipoAsignacion)),
      tipo_asignacion: tipoAsignacion,
      tipo_asignacion_label: anexoTipoLabel(tipoAsignacion),
      extension_requiere_fechas: extensionTipoRequiereFechas(tipoAsignacion),
      fecha_inicio_actual: pickFirst(anexoActivo?.fecha_inicio, solicitudActual?.fecha_inicio),
      fecha_fin_actual: pickFirst(anexoActivo?.fecha_fin, solicitudActual?.fecha_fin, preregistroActual?.fecha_fin),
      tarifa_hora: pickFirst(tarifasAnexo.tarifa_hora, toNullableNumber(solicitudActual?.tarifa_hora), toNullableNumber(preregistroActual?.tarifa_hora)),
      tarifa_mes: pickFirst(tarifasAnexo.tarifa_mes, toNullableNumber(solicitudActual?.tarifa_mes), toNullableNumber(preregistroActual?.tarifa_mes)),
      tarifa_medio_tiempo: pickFirst(
        tarifasAnexo.tarifa_medio_tiempo,
        toNullableNumber(solicitudActual?.tarifa_medio_tiempo),
        toNullableNumber(preregistroActual?.tarifa_medio_tiempo)
      ),
      tarifa_capacitacion: pickFirst(
        tarifasAnexo.tarifa_capacitacion,
        toNullableNumber(solicitudActual?.tarifa_capacitacion),
        toNullableNumber(preregistroActual?.tarifa_capacitacion)
      ),
      anexo_activo: anexoActivo
        ? {
            id: anexoActivo.public_id,
            tipo_asignacion: anexoActivo.tipo_asignacion,
            tipo_asignacion_label: anexoTipoLabel(anexoActivo.tipo_asignacion),
            cliente_id: anexoActivo.cliente_public_id || null,
            cliente_nombre: anexoActivo.cliente_nombre || null,
            modulo_id: anexoActivo.modulo_public_id || null,
            modulo_nombre: anexoActivo.modulo_titulo || null,
            moneda: anexoActivo.moneda || null,
            valor_tarifa: anexoActivo.valor_tarifa === null ? null : Number(anexoActivo.valor_tarifa),
            fecha_inicio: anexoActivo.fecha_inicio || null,
            fecha_fin: anexoActivo.fecha_fin || null,
            fecha_fin_calculada: Boolean(anexoActivo.fecha_fin_calculada),
            estado_firma: anexoActivo.estado_firma || "pendiente"
          }
        : null,
      anexos_activos: todosAnexosActivos.map((a) => ({
        id: a.public_id,
        tipo_asignacion: a.tipo_asignacion,
        tipo_asignacion_label: anexoTipoLabel(a.tipo_asignacion),
        cliente_id: a.cliente_public_id || null,
        cliente_nombre: a.cliente_nombre || null,
        modulo_id: a.modulo_public_id || null,
        modulo_nombre: a.modulo_titulo || null,
        moneda: a.moneda || null,
        valor_tarifa: a.valor_tarifa === null ? null : Number(a.valor_tarifa),
        fecha_inicio: a.fecha_inicio || null,
        fecha_fin: a.fecha_fin || null,
        fecha_fin_calculada: Boolean(a.fecha_fin_calculada),
        estado_firma: a.estado_firma || "pendiente"
      }))
    };
  }

  function buildExtensionExtraContext(currentContext, requestedValues) {
    const requestedTipoAsignacion =
      normalizeAnexoTipo(requestedValues?.tipo_asignacion) ||
      normalizeAnexoTipo(requestedValues?.modalidad_contrato);
    const base = currentContext
      ? {
          tipo_asignacion: currentContext.tipo_asignacion || null,
          tipo_asignacion_label: currentContext.tipo_asignacion_label || null,
          cliente_id: currentContext.cliente_id || null,
          cliente_nombre: currentContext.cliente_nombre || null,
          supervisor_id: currentContext.supervisor_id || null,
          supervisor_nombre: currentContext.supervisor_nombre || null,
          perfil: currentContext.perfil || null,
          modulo_id: currentContext.modulo_id || null,
          modulo_nombre: currentContext.modulo_nombre || null,
          moneda: currentContext.moneda || null,
          fecha_inicio: currentContext.fecha_inicio_actual || null,
          fecha_fin: currentContext.fecha_fin_actual || null,
          tarifa_hora: currentContext.tarifa_hora ?? null,
          tarifa_mes: currentContext.tarifa_mes ?? null,
          tarifa_medio_tiempo: currentContext.tarifa_medio_tiempo ?? null,
          tarifa_capacitacion: currentContext.tarifa_capacitacion ?? null
        }
      : null;

    const changes = [];
    const requestedFrom = requestedValues?.fecha_extension_desde || null;
    const requestedTo = requestedValues?.fecha_extension_hasta || null;
    const baseFrom = currentContext?.fecha_inicio_actual || null;
    const baseTo = currentContext?.fecha_fin_actual || null;
    if ((requestedFrom || requestedTo) && (requestedFrom !== baseFrom || requestedTo !== baseTo)) {
      changes.push(
        `Extension: ${formatDateForEmail(requestedFrom) || "N/A"} -> ${formatDateForEmail(requestedTo) || "N/A"}`
      );
    }
    if (
      requestedValues?.cliente_id &&
      requestedValues.cliente_id !== currentContext?.cliente_id &&
      requestedValues?.cliente_nombre
    ) {
      changes.push(`Cliente: ${currentContext?.cliente_nombre || "Sin cliente"} -> ${requestedValues.cliente_nombre}`);
    }
    if (
      requestedValues?.supervisor_id &&
      requestedValues.supervisor_id !== currentContext?.supervisor_id &&
      requestedValues?.supervisor_nombre
    ) {
      changes.push(
        `Responsable: ${currentContext?.supervisor_nombre || "Sin responsable"} -> ${requestedValues.supervisor_nombre}`
      );
    }
    if (requestedValues?.perfil && requestedValues.perfil !== currentContext?.perfil) {
      changes.push(`Perfil: ${currentContext?.perfil || "Sin perfil"} -> ${requestedValues.perfil}`);
    }
    if (requestedValues?.moneda && requestedValues.moneda !== currentContext?.moneda) {
      changes.push(`Moneda: ${currentContext?.moneda || "N/A"} -> ${requestedValues.moneda}`);
    }

    const tarifas = [
      ["Tarifa hora", currentContext?.tarifa_hora, requestedValues?.tarifa_hora, requestedValues?.moneda || currentContext?.moneda],
      ["Tarifa mes", currentContext?.tarifa_mes, requestedValues?.tarifa_mes, requestedValues?.moneda || currentContext?.moneda],
      [
        "Tarifa medio tiempo",
        currentContext?.tarifa_medio_tiempo,
        requestedValues?.tarifa_medio_tiempo,
        requestedValues?.moneda || currentContext?.moneda
      ],
      [
        "Tarifa capacitacion",
        currentContext?.tarifa_capacitacion,
        requestedValues?.tarifa_capacitacion,
        requestedValues?.moneda || currentContext?.moneda
      ]
    ];
    tarifas.forEach(([label, oldValue, newValue, moneda]) => {
      const next = toNullableNumber(newValue);
      if (next === null) return;
      const prev = toNullableNumber(oldValue);
      if (prev === next) return;
      changes.push(`${label}: ${formatMoneyInline(prev, moneda) || "N/A"} -> ${formatMoneyInline(next, moneda)}`);
    });

    return {
      tipo_asignacion: requestedTipoAsignacion || currentContext?.tipo_asignacion || null,
      extension_base: base,
      extension_cambios: changes
    };
  }

  function summarizeExtensionBase(base) {
    if (!base || typeof base !== "object") return null;
    const parts = [
      base.tipo_asignacion_label || null,
      base.cliente_nombre || null,
      base.perfil || base.modulo_nombre || null,
      base.moneda || null,
      formatDateForEmail(base.fecha_inicio),
      formatDateForEmail(base.fecha_fin)
    ].filter(Boolean);
    return parts.join(" | ") || null;
  }

  function buildExtensionSummaryBlocks(solicitud) {
    const extra = toObjectOrEmpty(solicitud?.datos_extra);
    const blocks = [];
    const emailObjetivo = [solicitud?.correo_personal, solicitud?.correo_empresarial].filter(Boolean).join(" / ");
    if (emailObjetivo) {
      blocks.push({ label: "Email persona a modificar", value: emailObjetivo });
    }
    if (extra.extension_base) {
      blocks.push({
        label: "Contrato actual detectado",
        value: summarizeExtensionBase(extra.extension_base) || "Sin contexto previo"
      });
    }
    if (Array.isArray(extra.extension_cambios) && extra.extension_cambios.length) {
      blocks.push({
        label: "Cambios solicitados",
        value: extra.extension_cambios.filter(Boolean).join(" | ")
      });
    }
    return blocks;
  }

  function formatRow(row) {
    if (!row) return null;
    const datosExtra = toObjectOrEmpty(row.datos_extra);
    return {
      id: row.public_id,
      tipo_solicitud: row.tipo_solicitud,
      estado: row.estado,
      crear_usuario_sistema: row.crear_usuario_sistema !== false,
      origen_flujo: row.origen_flujo || "coordinacion",
      coordinador: row.coordinador_public_id
        ? {
            id: row.coordinador_public_id,
            nombre: row.coordinador_nombre,
            email: row.coordinador_email || null,
            rol: row.coordinador_rol_titulo || null
          }
        : null,
      persona: row.persona_public_id
        ? {
            id: row.persona_public_id,
            nombre: row.persona_nombre,
            email: row.persona_email || null
          }
        : null,
      preregistro_id: row.preregistro_id || null,
      supervisor: row.supervisor_public_id
        ? {
            id: row.supervisor_public_id,
            nombre: row.supervisor_nombre,
            email: row.supervisor_email || null
          }
        : null,
      cliente: row.cliente_public_id
        ? {
            id: row.cliente_public_id,
            nombre: row.cliente_nombre,
            requiere_confirmacion_cliente: Boolean(row.cliente_requiere_confirmacion_cliente)
          }
        : null,
      tipo_documento: row.tipo_documento_public_id
        ? {
            id: row.tipo_documento_public_id,
            titulo: row.tipo_documento_titulo,
            codigo: row.tipo_documento_codigo || null
          }
        : null,
      nombre: row.nombre,
      apellidos: row.apellidos,
      numero_documento: row.numero_documento || null,
      perfil: row.perfil || null,
      correo_personal: row.correo_personal || null,
      correo_empresarial: row.correo_empresarial || null,
      telefono: row.telefono || null,
      ubicacion: row.ubicacion || null,
      grupo_app_tiempos: datosExtra.grupo_usuario || row.grupo_app_tiempos || null,
      grupo_distribucion: datosExtra.grupo_distribucion || row.grupo_distribucion || null,
      vpn_corona: Object.prototype.hasOwnProperty.call(datosExtra, "vpn_corona")
        ? Boolean(datosExtra.vpn_corona)
        : Boolean(row.vpn_corona),
      necesita_s_user: Object.prototype.hasOwnProperty.call(datosExtra, "necesita_s_user")
        ? Boolean(datosExtra.necesita_s_user)
        : Boolean(row.necesita_s_user),
      grupo_usuario_otro: row.grupo_usuario_otro || null,
      moneda: row.moneda || null,
      tarifa_hora: row.tarifa_hora === null ? null : Number(row.tarifa_hora),
      tarifa_mes: row.tarifa_mes === null ? null : Number(row.tarifa_mes),
      tarifa_medio_tiempo: row.tarifa_medio_tiempo === null ? null : Number(row.tarifa_medio_tiempo),
      tarifa_capacitacion: row.tarifa_capacitacion === null ? null : Number(row.tarifa_capacitacion),
      modalidad_contrato: row.modalidad_contrato || null,
      fecha_inicio: row.fecha_inicio || null,
      fecha_fin: row.fecha_fin || null,
      fecha_extension_desde: row.fecha_extension_desde || null,
      fecha_extension_hasta: row.fecha_extension_hasta || null,
      fecha_retiro: row.fecha_retiro || null,
      necesidad_ti: row.necesidad_ti || null,
      observaciones: row.observaciones || null,
      datos_extra: datosExtra,
      requiere_confirmacion_cliente: Boolean(row.requiere_confirmacion_cliente),
      correo_enviado_mesa: Boolean(row.correo_enviado_mesa),
      correo_enviado_th: Boolean(row.correo_enviado_th),
      correo_confirmacion_coordinador: Boolean(row.correo_confirmacion_coordinador),
      revisado_th_por: row.revisado_th_por_public_id
        ? { id: row.revisado_th_por_public_id, nombre: row.revisado_th_por_nombre }
        : null,
      fecha_revision_th: row.fecha_revision_th || null,
      observaciones_th: row.observaciones_th || null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  async function getByInternalId(db, internalId) {
    const result = await db.query(`${BASE_SELECT} WHERE sc.id = $1 LIMIT 1`, [internalId]);
    return result.rows[0] || null;
  }

  async function getByPublicId(db, publicId) {
    const result = await db.query(`${BASE_SELECT} WHERE sc.public_id = $1 LIMIT 1`, [publicId]);
    return result.rows[0] || null;
  }

  async function resolvePersonaMoneda(db, personaUsuarioId) {
    if (!personaUsuarioId) return null;
    const r = await db.query(
      `SELECT moneda_cobro
       FROM usuarios
       WHERE id = $1
       LIMIT 1`,
      [personaUsuarioId]
    );
    return normalizeMoneda(r.rows[0]?.moneda_cobro || null);
  }

  async function syncPersonaSnapshotDesdeExtension(db, solicitudRow) {
    if (
      !solicitudRow ||
      solicitudRow.tipo_solicitud !== TIPO_EXTENSION ||
      solicitudRow.estado !== ESTADOS.completado
    ) return null;
    const datosExtra = toObjectOrEmpty(solicitudRow.datos_extra);
    const moduloRef = toNullableString(datosExtra.modulo_id);
    let moduloId = null;
    if (moduloRef && (isUuid(moduloRef) || /^\d+$/.test(moduloRef))) {
      const moduloResult = await db.query(
        isUuid(moduloRef)
          ? "SELECT id FROM modulo WHERE public_id = $1 LIMIT 1"
          : "SELECT id FROM modulo WHERE id = $1::int LIMIT 1",
        [moduloRef]
      );
      moduloId = moduloResult.rows[0]?.id || null;
    }

    const clienteOtro = solicitudRow.cliente_id
      ? null
      : toNullableString(datosExtra.cliente_nombre);
    const moduloOtro = moduloId
      ? null
      : toNullableString(
          datosExtra.modulo_nombre ||
          datosExtra.modulo_otro ||
          datosExtra.modulo ||
          solicitudRow.perfil
        );
    const modalidad = normalizeModalidad(solicitudRow.modalidad_contrato);
    const tipoContrato = modalidad === "Por horas" ? "Por horas" : (modalidad ? "Full time" : null);

    const result = await db.query(
      `
      UPDATE personas p
      SET
        cliente_id = CASE
          WHEN $2::text IS NOT NULL THEN NULL
          ELSE COALESCE($1, p.cliente_id)
        END,
        cliente_otro = CASE
          WHEN $1::int IS NOT NULL THEN NULL
          ELSE COALESCE($2, p.cliente_otro)
        END,
        modulo_id = CASE
          WHEN $4::text IS NOT NULL THEN NULL
          ELSE COALESCE($3, p.modulo_id)
        END,
        modulo_otro = CASE
          WHEN $3::int IS NOT NULL THEN NULL
          ELSE COALESCE($4, p.modulo_otro)
        END,
        modalidad = COALESCE($5, p.modalidad),
        tipo_contrato = CASE
          WHEN p.tipo_contrato = 'Vinculado'::tipo_contrato THEN p.tipo_contrato
          ELSE COALESCE($6::tipo_contrato, p.tipo_contrato)
        END,
        estado = 'activo',
        updated_at = NOW()
      WHERE p.id = COALESCE(
        (SELECT u.persona_id FROM usuarios u WHERE u.id = $7 AND u.persona_id IS NOT NULL LIMIT 1),
        (SELECT px.id FROM personas px WHERE NULLIF(BTRIM(px.numero_documento), '') = $8 LIMIT 1)
      )
      RETURNING p.id
      `,
      [
        solicitudRow.cliente_id || null,
        clienteOtro,
        moduloId,
        moduloOtro,
        modalidad,
        tipoContrato,
        solicitudRow.persona_usuario_id || null,
        toNullableString(solicitudRow.numero_documento)
      ]
    );
    return result.rows[0] || null;
  }

  async function revocarAccesoInternoPorRetiroTotal(db, solicitudRow) {
    if (!solicitudRow) return { usuarioDesactivado: false, personaDesactivada: false };
    const personaObjetivo = await db.query(
      `
      SELECT COALESCE(
        (SELECT u.persona_id FROM usuarios u WHERE u.id = $1 AND u.persona_id IS NOT NULL LIMIT 1),
        (SELECT p.id FROM personas p WHERE NULLIF(BTRIM(p.numero_documento), '') = $2 LIMIT 1)
      ) AS id
      `,
      [solicitudRow.persona_usuario_id || null, toNullableString(solicitudRow.numero_documento)]
    );
    const personaId = personaObjetivo.rows[0]?.id || null;
    const usuarioResult = await db.query(
      `
      UPDATE usuarios u
      SET activo = false, updated_at = NOW()
      FROM roles r
      WHERE (u.id = $1 OR ($2::int IS NOT NULL AND u.persona_id = $2))
        AND r.id = u.rol_usuario_id
        AND LOWER(r.titulo) LIKE 'consultor%'
      RETURNING u.id, u.persona_id
      `,
      [solicitudRow.persona_usuario_id || null, personaId]
    );
    const personaResult = await db.query(
      `
      UPDATE personas p
      SET estado = 'inactivo', updated_at = NOW()
      WHERE p.id = $1
      RETURNING p.id
      `,
      [personaId]
    );
    return {
      usuarioDesactivado: usuarioResult.rowCount > 0,
      personaDesactivada: Boolean(personaResult.rows[0]?.id)
    };
  }

  async function syncAnexoDesdeSolicitud(internalId, userId = null) {
    const row = await getByInternalId(pool, internalId);
    if (!row) return row;

    if (row.tipo_solicitud === TIPO_RETIRO) {
      // La finalización del anexo ya ocurrió en dispatchAndFinalizeSolicitud
      return row;
    }

    try {
      await ensurePersistedAnexoFromProceso({
        solicitudId: internalId,
        preregistroId: row.preregistro_id || null,
        createdBy: userId || null,
        strict: false
      });
    } catch (err) {
      console.warn("No se pudo persistir anexo tecnico desde solicitud:", err?.message || err);
    }
    if (row.tipo_solicitud === TIPO_EXTENSION) {
      try {
        await syncPersonaSnapshotDesdeExtension(pool, row);
      } catch (err) {
        console.warn("No se pudo sincronizar la ficha de persona desde la extension:", err?.message || err);
      }
    }
    return row;
  }

  function requireOwnerIfCoordinator(req, row) {
    const role = normalizeValue(req.user?.rol);
    if (role !== "coordinador" && role !== "comercial") return true;
    return String(req.user?.id || "") === String(row?.coordinador_solicitante_id || "");
  }

  function baseBlocks(solicitud) {
    return [
      { label: "Tipo", value: solicitud.tipo_solicitud },
      { label: "Nombre", value: `${solicitud.nombre || ""} ${solicitud.apellidos || ""}`.trim() || "N/A" },
      { label: "Documento", value: solicitud.numero_documento || "N/A" },
      { label: "Perfil", value: solicitud.perfil || "N/A" },
      { label: "Correo personal", value: solicitud.correo_personal || "N/A" },
      { label: "Correo empresarial", value: solicitud.correo_empresarial || "N/A" },
      { label: "Telefono", value: solicitud.telefono || "N/A" },
      { label: "Ubicacion", value: solicitud.ubicacion || "N/A" },
      { label: "Cliente", value: solicitud?.cliente?.nombre || "N/A" },
      { label: "Supervisor", value: solicitud?.supervisor?.nombre || "N/A" },
      { label: "Moneda", value: solicitud.moneda || "N/A" },
      { label: "Tarifa Hora", value: solicitud.tarifa_hora ?? "N/A" },
      { label: "Tarifa Mes", value: solicitud.tarifa_mes ?? "N/A" },
      { label: "Tarifa Medio Tiempo", value: solicitud.tarifa_medio_tiempo ?? "N/A" },
      { label: "Tarifa Capacitacion", value: solicitud.tarifa_capacitacion ?? "N/A" },
      { label: "Modalidad", value: solicitud.modalidad_contrato || "N/A" },
      { label: "Fecha inicio", value: formatDateForEmail(solicitud.fecha_inicio) },
      { label: "Fecha fin", value: formatDateForEmail(solicitud.fecha_fin) },
      { label: "Fecha extension desde", value: formatDateForEmail(solicitud.fecha_extension_desde) },
      { label: "Fecha extension hasta", value: formatDateForEmail(solicitud.fecha_extension_hasta) },
      { label: "Fecha retiro", value: formatDateForEmail(solicitud.fecha_retiro) },
      { label: "Grupo APP tiempos", value: solicitud.grupo_app_tiempos || "N/A" },
      { label: "Grupo distribucion", value: solicitud.grupo_distribucion || "N/A" },
      { label: "Necesidad TI", value: solicitud.necesidad_ti || "N/A" },
      { label: "Observaciones", value: solicitud.observaciones || "N/A" },
      { label: "Solicitado por", value: solicitud?.coordinador?.nombre || solicitud?.coordinador?.email || "N/A" }
    ];
  }

  function buildMailMesaNuevo(solicitud) {
    const blocks = baseBlocks(solicitud);
    return {
      subject: `Crear usuario y accesos - ${solicitud.nombre || ""} ${solicitud.apellidos || ""}`.trim(),
      text:
        "Por favor crear informacion, asignar licencia y crear S user para el consultor.\n\n" +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Solicitud TI - Nuevo contrato",
        intro: "Por favor crear informacion, asignar licencia y crear S user para el consultor.",
        blocks
      })
    };
  }

  function buildMailThNuevo(solicitud) {
    const blocks = baseBlocks(solicitud);
    return {
      subject: "Administrativos: Crear contrato",
      text:
        "Proceder con la creacion del contrato para:\n\n" +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Administrativos: Crear contrato",
        intro: "Proceder con la creacion del contrato con la siguiente informacion.",
        blocks
      })
    };
  }

  function buildMailCoordinadorParcialHolcim(solicitud) {
    const blocks = baseBlocks(solicitud);
    return {
      subject: "Solicitud HOLCIM - Envio parcial completado",
      text:
        "Se completo parcialmente la gestión de la solicitud.\n" +
        "TI fue notificado para creacion de usuario.\n" +
        "El contrato queda pendiente de confirmacion con el cliente.\n\n" +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Solicitud HOLCIM enviada parcialmente",
        intro:
          "TI ya fue notificado para creacion de usuario. El contrato queda pendiente de confirmacion del cliente antes de notificar a Talento Humano.",
        blocks
      })
    };
  }

  function buildMailCoordinadorCompletoNuevo(solicitud) {
    const blocks = baseBlocks(solicitud);
    return {
      subject: "Confirmacion: Solicitud de creacion de contrato",
      text:
        "La gestion de la solicitud de creacion de contrato se completo exitosamente.\n" +
        "Area Administrativa y TI fueron notificadas.\n\n" +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Solicitud de contrato completada",
        intro: "Se notifico a Area Administrativa y TI con los datos registrados.",
        blocks
      })
    };
  }

  function buildMailThExtension(solicitud) {
    const blocks = [...baseBlocks(solicitud), ...buildExtensionSummaryBlocks(solicitud)];
    return {
      subject: "Administrativos: Modificar contrato",
      text:
        "Proceder con la modificacion del contrato para:\n\n" +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Administrativos: Modificar contrato",
        intro: "Se solicita modificacion de contrato (extension, tarifas o reasignacion).",
        blocks
      })
    };
  }

  function buildMailMesaRetiro(solicitud, { selectedAnexo = null, remainingCount = 0 } = {}) {
    const blocks = baseBlocks(solicitud);
    if (selectedAnexo) {
      blocks.push({ label: "Contrato finalizado", value: `${selectedAnexo.tipo_asignacion_label || selectedAnexo.tipo_asignacion} - ${selectedAnexo.cliente_nombre || "Sin cliente"}` });
      if (selectedAnexo.fecha_inicio || selectedAnexo.fecha_fin) {
        blocks.push({ label: "Vigencia del contrato", value: `${formatDateForEmail(selectedAnexo.fecha_inicio)} - ${formatDateForEmail(selectedAnexo.fecha_fin)}` });
      }
    }
    const introRetiro = remainingCount === 0
      ? "Favor bloquear TODOS los accesos (Microsoft, VPN, licencias, S-user). Esta persona no tendra contratos activos despues de este retiro."
      : `Favor retirar accesos asociados al contrato seleccionado. La persona conservara ${remainingCount} contrato(s) activo(s).`;
    return {
      subject: "Retirar usuarios, licencias y VPN",
      text:
        `${introRetiro}\n\n` +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Retiro - Acciones TI",
        intro: introRetiro,
        blocks
      })
    };
  }

  function buildMailThRetiro(solicitud, { selectedAnexo = null, remainingCount = 0 } = {}) {
    const blocks = baseBlocks(solicitud);
    if (selectedAnexo) {
      blocks.push({ label: "Contrato a retirar", value: `${selectedAnexo.tipo_asignacion_label || selectedAnexo.tipo_asignacion} - ${selectedAnexo.cliente_nombre || "Sin cliente"}` });
      if (selectedAnexo.perfil) blocks.push({ label: "Perfil del contrato", value: selectedAnexo.perfil });
      if (selectedAnexo.fecha_inicio || selectedAnexo.fecha_fin) {
        blocks.push({ label: "Vigencia del contrato", value: `${formatDateForEmail(selectedAnexo.fecha_inicio)} - ${formatDateForEmail(selectedAnexo.fecha_fin)}` });
      }
    }
    const introTh = remainingCount === 0
      ? "Proceder con el retiro total del contrato. Esta persona NO tendra contratos activos despues de este retiro. Revisar proceso de desvinculacion segun politica interna."
      : `Proceder con el retiro del contrato seleccionado. La persona conservara ${remainingCount} contrato(s) activo(s).`;
    return {
      subject: "Administrativos: Retirar contrato",
      text:
        `${introTh}\n\n` +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Administrativos: Retiro de contrato",
        intro: introTh,
        blocks
      })
    };
  }

  function buildMailCoordinadorRetiro(solicitud) {
    const blocks = baseBlocks(solicitud);
    return {
      subject: "Confirmacion: Solicitud de retiro completada",
      text:
        "La solicitud de retiro fue procesada y se notifico a TI y Administrativos.\n\n" +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Solicitud de retiro completada",
        intro: "Se notifico a TI para bloqueo de accesos y a Administrativos para retiro del contrato.",
        blocks
      })
    };
  }

  function buildMailCoordinadorDevolucionTh(solicitud, observaciones) {
    const blocks = [
      { label: "Tipo", value: solicitud?.tipo_solicitud || "Nuevo" },
      { label: "Nombre", value: `${solicitud?.nombre || ""} ${solicitud?.apellidos || ""}`.trim() || "N/A" },
      { label: "Cliente", value: solicitud?.cliente?.nombre || "N/A" },
      { label: "Perfil", value: solicitud?.perfil || "N/A" },
      { label: "Observaciones TH", value: observaciones || "Sin detalle" }
    ];

    return {
      subject: "Contratacion devuelta por Talento Humano",
      text:
        "Talento Humano devolvio la solicitud para ajustes.\n\n" +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Contratacion devuelta por TH",
        intro: "La solicitud requiere ajustes por parte del coordinador antes de continuar con la revision.",
        blocks
      })
    };
  }

  async function sendMail(graphContext, recipients, content) {
    const to = Array.isArray(recipients) ? recipients.join(",") : String(recipients || "").trim();
    if (!to) return { ok: false, skipped: true };
    return sendEmailSafe({
      ...graphContext,
      to,
      subject: content.subject,
      text: content.text,
      html: content.html
    });
  }

  function computeFinalStateOnCreate({ tipoSolicitud, requiereConfirmacionCliente, mailResults }) {
    if (tipoSolicitud === TIPO_NUEVO && requiereConfirmacionCliente) {
      return mailResults.mesa ? ESTADOS.pendienteConfirmacionCliente : ESTADOS.enProceso;
    }

    const requiredByType = {
      [TIPO_NUEVO]: ["mesa", "th"],
      [TIPO_EXTENSION]: ["th"],
      [TIPO_RETIRO]: ["mesa", "th"]
    };
    const required = requiredByType[tipoSolicitud] || [];
    const allOk = required.every((key) => Boolean(mailResults[key]));

    if (!allOk) return ESTADOS.enProceso;

    // Para TIPO_NUEVO los correos se enviaron, pero TH debe confirmar datos bancarios
    // antes de marcar como Completado
    if (tipoSolicitud === TIPO_NUEVO) return ESTADOS.pendienteRevisionTh;

    return ESTADOS.completado;
  }

  async function dispatchAndFinalizeSolicitud({ internalId, req }) {
    const rawSolicitud = await getByInternalId(pool, internalId);
    if (!rawSolicitud) {
      throw new Error("No se pudo recuperar la solicitud para enviar correos");
    }

    const solicitud = formatRow(rawSolicitud);
    const graphContext = getGraphContext(req);
    const destinosTh = await getDestinosTalentoHumano();
    const coordinadorEmail = toNullableString(rawSolicitud.coordinador_email || req.user?.email);
    const requiereConfirmacionCliente = Boolean(rawSolicitud.requiere_confirmacion_cliente);

    const mailResults = {
      mesa: false,
      th: false,
      coordinador: false
    };
    let retiroTotalPendienteRevocacion = false;

    if (solicitud.tipo_solicitud === TIPO_NUEVO) {
      const mesaResult = await sendMail(graphContext, DESTINOS_MESA, buildMailMesaNuevo(solicitud));
      mailResults.mesa = Boolean(mesaResult.ok);

      if (requiereConfirmacionCliente) {
        const coordResult = await sendMail(
          graphContext,
          coordinadorEmail,
          buildMailCoordinadorParcialHolcim(solicitud)
        );
        mailResults.coordinador = Boolean(coordResult.ok);
      } else {
        const thResult = await sendMail(graphContext, destinosTh, buildMailThNuevo(solicitud));
        mailResults.th = Boolean(thResult.ok);
        const coordResult = await sendMail(
          graphContext,
          coordinadorEmail,
          buildMailCoordinadorCompletoNuevo(solicitud)
        );
        mailResults.coordinador = Boolean(coordResult.ok);
      }
    }

    if (solicitud.tipo_solicitud === TIPO_EXTENSION) {
      const thResult = await sendMail(graphContext, destinosTh, buildMailThExtension(solicitud));
      mailResults.th = Boolean(thResult.ok);
    }

    if (solicitud.tipo_solicitud === TIPO_RETIRO) {
      const datosExtraRetiro = toObjectOrEmpty(rawSolicitud.datos_extra);
      const anexoRetiroPublicId = toNullableString(datosExtraRetiro?.anexo_item_id);
      let selectedAnexo = null;
      let remainingCount = 0;
      if (anexoRetiroPublicId) {
        // Validar pertenencia y obtener datos del anexo antes de finalizar
        const anexoRes = await pool.query(
          `SELECT ati.id, ati.tipo_asignacion, c.titulo AS cliente_nombre, m.titulo AS perfil,
                  ati.moneda, ati.valor_tarifa, ati.fecha_inicio, ati.fecha_fin
           FROM anexo_tecnico_items ati
           LEFT JOIN clientes c ON c.id = ati.cliente_id
           LEFT JOIN modulo m ON m.id = ati.modulo_id
           WHERE ati.public_id::text = $1
             AND ati.estado = 'activo'
             AND (
               ($2::int IS NOT NULL AND ati.usuario_id = $2)
               OR ($3::text IS NOT NULL AND ati.numero_documento = $3)
             )
           LIMIT 1`,
          [anexoRetiroPublicId, rawSolicitud.persona_usuario_id || null, rawSolicitud.numero_documento || null]
        );
        if (anexoRes.rows[0]) {
          selectedAnexo = {
            ...anexoRes.rows[0],
            tipo_asignacion_label: anexoTipoLabel(anexoRes.rows[0].tipo_asignacion)
          };
          // Finalizar el item respetando constraint check2 por tipo de asignación
          const tipoAnexoRetiro = selectedAnexo.tipo_asignacion || '';
          const isCorteAnual = tipoAnexoRetiro === 'horas' || tipoAnexoRetiro === 'capacitacion';
          const fechaRetiroStr = rawSolicitud.fecha_retiro ? normalizeDateOnly(String(rawSolicitud.fecha_retiro)) : null;
          const fechaInicioAnexoStr = selectedAnexo.fecha_inicio ? normalizeDateOnly(String(selectedAnexo.fecha_inicio)) : null;
          const retiroAntesDeInicio = fechaRetiroStr && fechaInicioAnexoStr && fechaRetiroStr < fechaInicioAnexoStr;
          const estadoRetiro = retiroAntesDeInicio ? 'cancelado' : 'finalizado';
          // horas/capacitacion: fecha_fin debe ser 31-dic por constraint; no se modifica.
          // Otros tipos: solo actualizar fecha_fin si retiro >= inicio del item.
          const nuevaFechaFinRetiro = (!isCorteAnual && !retiroAntesDeInicio && fechaRetiroStr) ? fechaRetiroStr : null;
          await pool.query(
            `UPDATE anexo_tecnico_items
             SET estado = $2,
                 fecha_fin = COALESCE($3, fecha_fin),
                 updated_by = $4,
                 updated_at = NOW()
             WHERE id = $1`,
            [selectedAnexo.id, estadoRetiro, nuevaFechaFinRetiro, req.user?.id || null]
          );
          // Contar restantes excluyendo el recién finalizado (Fix 4)
          const countRes = await pool.query(
            `SELECT COUNT(*)::int AS count FROM anexo_tecnico_items
             WHERE estado = 'activo'
               AND public_id::text <> $1::text
               AND (
                 ($2::int IS NOT NULL AND usuario_id = $2)
                 OR ($3::text IS NOT NULL AND numero_documento = $3)
               )`,
            [anexoRetiroPublicId, rawSolicitud.persona_usuario_id || null, rawSolicitud.numero_documento || null]
          );
          remainingCount = countRes.rows[0]?.count || 0;
          if (remainingCount === 0) {
            retiroTotalPendienteRevocacion = true;
          }
        }
      }
      const retiroCtx = { selectedAnexo, remainingCount };
      const mesaResult = await sendMail(graphContext, DESTINOS_MESA, buildMailMesaRetiro(solicitud, retiroCtx));
      mailResults.mesa = Boolean(mesaResult.ok);
      const thResult = await sendMail(graphContext, destinosTh, buildMailThRetiro(solicitud, retiroCtx));
      mailResults.th = Boolean(thResult.ok);
      const coordResult = await sendMail(graphContext, coordinadorEmail, buildMailCoordinadorRetiro(solicitud));
      mailResults.coordinador = Boolean(coordResult.ok);
    }

    const estadoFinal = computeFinalStateOnCreate({
      tipoSolicitud: solicitud.tipo_solicitud,
      requiereConfirmacionCliente,
      mailResults
    });

    if (retiroTotalPendienteRevocacion && estadoFinal === ESTADOS.completado) {
      await revocarAccesoInternoPorRetiroTotal(pool, rawSolicitud);
    }

    await pool.query(
      `
      UPDATE solicitudes_contratacion
      SET
        estado = $1,
        correo_enviado_mesa = $2,
        correo_enviado_th = $3,
        correo_confirmacion_coordinador = $4
      WHERE id = $5
      `,
      [estadoFinal, mailResults.mesa, mailResults.th, mailResults.coordinador, internalId]
    );

    return getByInternalId(pool, internalId);
  }

  async function redispatchReturnedSolicitudToTh({ internalId, req }) {
    const rawSolicitud = await getByInternalId(pool, internalId);
    if (!rawSolicitud) {
      throw new Error("No se pudo recuperar la solicitud devuelta para reenviar a TH");
    }

    const solicitud = formatRow(rawSolicitud);
    const destinosTh = await getDestinosTalentoHumano();
    const thResult = await sendMail(getGraphContext(req), destinosTh, buildMailThNuevo(solicitud));
    const thOk = Boolean(thResult.ok);

    await pool.query(
      `
      UPDATE solicitudes_contratacion
      SET
        estado = $1,
        correo_enviado_th = $2
      WHERE id = $3
      `,
      [thOk ? ESTADOS.pendienteRevisionTh : ESTADOS.enProceso, thOk, internalId]
    );

    return getByInternalId(pool, internalId);
  }

  app.get(
    "/contrataciones/personas",
    requireAccess({ roles: ["Administrador", "Coordinador", "Comercial", "Talento Humano"] }),
    async (req, res) => {
      try {
        const search = String(req.query?.search || "").trim();
        const limit = Math.min(Math.max(Number(req.query?.limit || 10), 1), 25);
        if (search.length < 2) return res.json([]);

        const result = await pool.query(
          `
          SELECT
            u.id AS internal_id,
            u.public_id AS id,
            u.nombre_usuario,
            u.email AS correo_empresarial,
            u.cedula AS numero_documento,
            u.telefono,
            u.moneda_cobro AS moneda,
            di.public_id AS tipo_documento_id,
            di.titulo AS tipo_documento,
            di.codigo AS tipo_documento_codigo
          FROM usuarios u
          LEFT JOIN documento_identidad di ON di.id = u.tipo_documento_id
          WHERE (
            u.nombre_usuario ILIKE $1
            OR u.email ILIKE $1
            OR COALESCE(u.cedula, '') ILIKE $1
          )
          ORDER BY
            CASE WHEN COALESCE(u.activo, true) THEN 0 ELSE 1 END,
            u.nombre_usuario ASC
          LIMIT $2
          `,
          [`%${search}%`, limit]
        );
        const enriched = await Promise.all(
          (result.rows || []).map(async (row) => {
            const context = await buildPersonaExtensionContext({
              userInternalId: row.internal_id,
              numeroDocumento: row.numero_documento || null,
              correoEmpresarial: row.correo_empresarial || null,
              baseUserRow: {
                id: row.internal_id,
                public_id: row.id,
                nombre_usuario: row.nombre_usuario,
                email: row.correo_empresarial,
                cedula: row.numero_documento,
                telefono: row.telefono,
                moneda_cobro: row.moneda,
                tipo_documento_public_id: row.tipo_documento_id,
                tipo_documento_titulo: row.tipo_documento,
                tipo_documento_codigo: row.tipo_documento_codigo
              }
            });

            return {
              id: row.id,
              nombre_usuario: row.nombre_usuario,
              correo_empresarial: context?.correo_empresarial || row.correo_empresarial || null,
              correo_personal: context?.correo_personal || null,
              numero_documento: row.numero_documento || null,
              telefono: row.telefono || null,
              moneda: context?.moneda || row.moneda || null,
              tipo_documento_id: row.tipo_documento_id || null,
              tipo_documento: row.tipo_documento || null,
              tipo_documento_codigo: row.tipo_documento_codigo || null,
              cliente_id: context?.cliente_id || null,
              cliente_nombre: context?.cliente_nombre || null,
              supervisor_id: context?.supervisor_id || null,
              supervisor_nombre: context?.supervisor_nombre || null,
              supervisor_email: context?.supervisor_email || null,
              perfil: context?.perfil || null,
              modulo_id: context?.modulo_id || null,
              modulo_nombre: context?.modulo_nombre || null,
              modalidad_contrato: context?.modalidad_contrato || null,
              tipo_asignacion: context?.tipo_asignacion || null,
              tipo_asignacion_label: context?.tipo_asignacion_label || null,
              extension_requiere_fechas: Boolean(context?.extension_requiere_fechas),
              fecha_inicio_actual: context?.fecha_inicio_actual || null,
              fecha_fin_actual: context?.fecha_fin_actual || null,
              tarifa_hora: context?.tarifa_hora ?? null,
              tarifa_mes: context?.tarifa_mes ?? null,
              tarifa_medio_tiempo: context?.tarifa_medio_tiempo ?? null,
              tarifa_capacitacion: context?.tarifa_capacitacion ?? null,
              anexo_activo: context?.anexo_activo || null,
              anexos_activos: context?.anexos_activos || []
            };
          })
        );
        return res.json(enriched);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Error buscando personas" });
      }
    }
  );

  app.get(
    "/contrataciones/solicitudes",
    requireAccess({ roles: ["Administrador", "Coordinador", "Comercial", "Talento Humano"] }),
    async (req, res) => {
      try {
        const role = normalizeValue(req.user?.rol);
        const where = [];
        const values = [];
        let idx = 1;

        if (role === "coordinador" || role === "comercial") {
          where.push(`sc.coordinador_solicitante_id = $${idx++}`);
          values.push(req.user?.id);
        }

        const tipoSolicitud = normalizeTipoSolicitud(req.query?.tipo_solicitud);
        if (tipoSolicitud) {
          where.push(`sc.tipo_solicitud = $${idx++}`);
          values.push(tipoSolicitud);
        }

        const estado = toNullableString(req.query?.estado);
        if (estado) {
          where.push(`sc.estado = $${idx++}`);
          values.push(estado);
        }

        const search = toNullableString(req.query?.search);
        if (search) {
          where.push(
            `(sc.nombre ILIKE $${idx} OR sc.apellidos ILIKE $${idx} OR COALESCE(sc.numero_documento, '') ILIKE $${idx} OR COALESCE(sc.correo_personal, '') ILIKE $${idx} OR COALESCE(sc.correo_empresarial, '') ILIKE $${idx})`
          );
          values.push(`%${search}%`);
          idx += 1;
        }

        const clienteInput = toNullableString(req.query?.cliente_id);
        if (clienteInput) {
          const clienteRes = await pool.query("SELECT id FROM clientes WHERE public_id = $1", [clienteInput]);
          if (!clienteRes.rows.length) return res.json([]);
          where.push(`sc.cliente_id = $${idx++}`);
          values.push(clienteRes.rows[0].id);
        }

        const limit = Math.min(Math.max(Number(req.query?.limit || 100), 1), 300);
        const offset = Math.max(Number(req.query?.offset || 0), 0);
        values.push(limit);
        values.push(offset);

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const result = await pool.query(
          `
          ${BASE_SELECT}
          ${whereSql}
          ORDER BY sc.created_at DESC
          LIMIT $${idx++}
          OFFSET $${idx}
          `,
          values
        );
        return res.json((result.rows || []).map(formatRow));
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Error listando solicitudes de contratacion" });
      }
    }
  );

  app.get(
    "/contrataciones/solicitudes/:id",
    requireAccess({ roles: ["Administrador", "Coordinador", "Comercial", "Talento Humano"] }),
    async (req, res) => {
      try {
        const row = await getByPublicId(pool, req.params.id);
        if (!row) return res.status(404).json({ error: "Solicitud no encontrada" });
        if (!requireOwnerIfCoordinator(req, row)) {
          return res.status(403).json({ error: "No puedes ver solicitudes de otro coordinador" });
        }
        return res.json(formatRow(row));
      } catch (err) {
        if (err?.code === "PUBLIC_ID_NOT_FOUND") {
          return res.status(404).json({ error: "Solicitud no encontrada" });
        }
        console.error(err);
        return res.status(500).json({ error: "Error consultando solicitud" });
      }
    }
  );

  app.post(
    "/contrataciones/solicitudes",
    requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }),
    async (req, res) => {
      const payload = req.body || {};
      const tipoSolicitud = normalizeTipoSolicitud(payload.tipo_solicitud);
      if (!tipoSolicitud) {
        return res.status(400).json({ error: "tipo_solicitud invalido. Usa Nuevo, Extension o Retiro" });
      }

      const nombre = toNullableString(payload.nombre);
      const apellidos = toNullableString(payload.apellidos);
      const numeroDocumento = toNullableString(payload.numero_documento);
      const perfil = toNullableString(payload.perfil);
      const correoPersonal = toNullableString(payload.correo_personal);
      const correoEmpresarial = toNullableString(payload.correo_empresarial);
      const telefono = toNullableString(payload.telefono);
      const ubicacion = toNullableString(payload.ubicacion);
      const grupoAppTiempos = toNullableString(payload.grupo_app_tiempos);
      const grupoDistribucion = toNullableString(payload.grupo_distribucion);
      const vpnCorona = payload.vpn_corona === true || payload.vpn_corona === "true" || payload.vpn_corona === 1;
      const necesitaSUser = payload.necesita_s_user === true || payload.necesita_s_user === "true" || payload.necesita_s_user === 1;
      const grupoUsuarioOtro = toNullableString(payload.grupo_usuario_otro);
      const necesidadTi = toNullableString(payload.necesidad_ti);
      const observaciones = toNullableString(payload.observaciones);
      const enviarCorreos = payload.enviar_correos !== false;
      const crearUsuarioSistema = normalizeBooleanFlag(payload.crear_usuario_sistema, true);

      if (crearUsuarioSistema === null) {
        return res.status(400).json({ error: "crear_usuario_sistema debe ser booleano" });
      }

      if (!nombre || !apellidos) {
        return res.status(400).json({ error: "nombre y apellidos son obligatorios" });
      }
      if (enviarCorreos && tipoSolicitud === TIPO_RETIRO && !necesidadTi) {
        return res.status(400).json({ error: "necesidad_ti es obligatoria para retiros" });
      }
      if (enviarCorreos && tipoSolicitud === TIPO_RETIRO && !payload.fecha_retiro) {
        return res.status(400).json({ error: "fecha_retiro es obligatoria para solicitudes de retiro" });
      }

      const moneda = payload.moneda === undefined ? null : normalizeMoneda(payload.moneda);
      if (payload.moneda !== undefined && !moneda) {
        return res.status(400).json({ error: "moneda invalida. Usa COP, USD o EUR" });
      }
      const modalidadContrato =
        payload.modalidad_contrato === undefined ? null : normalizeModalidad(payload.modalidad_contrato);
      if (payload.modalidad_contrato !== undefined && !modalidadContrato) {
        return res
          .status(400)
          .json({ error: "modalidad_contrato invalida. Usa Full time, Medio tiempo o Por horas" });
      }

      const fechaInicio = payload.fecha_inicio ? normalizeDateOnly(payload.fecha_inicio) : null;
      const fechaFin = payload.fecha_fin ? normalizeDateOnly(payload.fecha_fin) : null;
      const fechaExtensionDesde = payload.fecha_extension_desde
        ? normalizeDateOnly(payload.fecha_extension_desde)
        : null;
      const fechaExtensionHasta = payload.fecha_extension_hasta
        ? normalizeDateOnly(payload.fecha_extension_hasta)
        : null;
      const fechaRetiro = payload.fecha_retiro ? normalizeDateOnly(payload.fecha_retiro) : null;
      if (payload.fecha_inicio && !fechaInicio) {
        return res.status(400).json({ error: "fecha_inicio invalida" });
      }
      if (payload.fecha_fin && !fechaFin) {
        return res.status(400).json({ error: "fecha_fin invalida" });
      }
      if (payload.fecha_extension_desde && !fechaExtensionDesde) {
        return res.status(400).json({ error: "fecha_extension_desde invalida" });
      }
      if (payload.fecha_extension_hasta && !fechaExtensionHasta) {
        return res.status(400).json({ error: "fecha_extension_hasta invalida" });
      }
      if (payload.fecha_retiro && !fechaRetiro) {
        return res.status(400).json({ error: "fecha_retiro invalida" });
      }

      if (correoPersonal && !isValidEmail(correoPersonal)) {
        return res.status(400).json({ error: "correo_personal no tiene un formato valido" });
      }
      if (correoEmpresarial && !isValidEmail(correoEmpresarial)) {
        return res.status(400).json({ error: "correo_empresarial no tiene un formato valido" });
      }
      if (enviarCorreos && tipoSolicitud === TIPO_NUEVO) {
        const missing = [];
        const factura = normalizeFacturaEnColombiaInput(payload.factura_en_colombia);
        const tieneTarifa = [
          payload.tarifa_hora,
          payload.tarifa_mes,
          payload.tarifa_medio_tiempo,
          payload.tarifa_capacitacion
        ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
        if (!numeroDocumento) missing.push("numero_documento");
        if (!payload.tipo_documento_id) missing.push("tipo_documento_id");
        if (!correoPersonal) missing.push("correo_personal");
        if (!perfil && !payload.modulo_id) missing.push("perfil o modulo_id");
        if (!fechaInicio) missing.push("fecha_inicio");
        if (!moneda) missing.push("moneda");
        if (factura === null) missing.push("factura_en_colombia");
        if (!tieneTarifa) missing.push("tarifa");
        if (crearUsuarioSistema && !grupoAppTiempos) missing.push("grupo_app_tiempos");
        if (!grupoDistribucion) missing.push("grupo_distribucion");
        if (missing.length) {
          return res.status(422).json({
            error: `Faltan datos obligatorios para contratar: ${missing.join(", ")}`,
            missing
          });
        }
      }

      try {
        const refsRes = await pool.query(
          `
          SELECT
            (SELECT id FROM usuarios WHERE public_id::text = $1::text) AS persona_usuario_id,
            (SELECT id FROM usuarios WHERE public_id::text = $2::text) AS supervisor_id,
            (SELECT id FROM documento_identidad WHERE public_id::text = $3::text) AS tipo_documento_id,
            (SELECT id FROM clientes WHERE public_id::text = $4::text) AS cliente_id
          `,
          [payload.persona_usuario_id || null, payload.supervisor_id || null, payload.tipo_documento_id || null, payload.cliente_id || null]
        );
        const refs = refsRes.rows[0];
        
        if (payload.persona_usuario_id && !refs.persona_usuario_id) throw { code: "PUBLIC_ID_NOT_FOUND" };
        if (payload.supervisor_id && !refs.supervisor_id) throw { code: "PUBLIC_ID_NOT_FOUND" };
        if (payload.tipo_documento_id && !refs.tipo_documento_id) throw { code: "PUBLIC_ID_NOT_FOUND" };
        const clienteNombreProspecto = toNullableString(payload.datos_extra?.cliente_nombre);
        if (tipoSolicitud === TIPO_NUEVO && !refs.cliente_id && !clienteNombreProspecto) {
           return res.status(400).json({ error: "Selecciona un cliente o escribe el nombre del prospecto" });
        }
        if (payload.cliente_id && !refs.cliente_id) throw { code: "PUBLIC_ID_NOT_FOUND" };

        const personaUsuarioId = refs.persona_usuario_id || null;
        const supervisorId = refs.supervisor_id || req.user?.id || null;
        const tipoDocumentoId = refs.tipo_documento_id || null;
        const clienteId = refs.cliente_id || null;
        const monedaFinal = moneda || await resolvePersonaMoneda(pool, personaUsuarioId);

        if (tipoSolicitud === TIPO_EXTENSION && !numeroDocumento && !personaUsuarioId) {
          return res.status(400).json({
            error: "Para Extension debes seleccionar una persona existente o indicar numero_documento"
          });
        }
        if (tipoSolicitud === TIPO_EXTENSION && !correoPersonal && !correoEmpresarial) {
          return res.status(400).json({
            error: "Para Extension se requiere al menos un correo de referencia de la persona a modificar"
          });
        }

        // Validar que correo_personal no este registrado para otra persona (diferente documento)
        if (tipoSolicitud === TIPO_NUEVO && correoPersonal) {
          const dupCheck = await findCorreoPersonaConflict(pool, {
            correo: correoPersonal,
            numeroDocumento
          });
          if (dupCheck) {
            return res.status(422).json({
              error: "El correo personal ya está registrado para otra persona en el sistema. Cada persona debe tener un correo personal único."
            });
          }
        }

        let clienteNombre = null;
        let requiereConfirmacionCliente = false;
        if (clienteId) {
          const clienteRes = await pool.query(
            `
            SELECT titulo, COALESCE(requiere_confirmacion_cliente, false) AS requiere_confirmacion_cliente
            FROM clientes
            WHERE id = $1
            LIMIT 1
            `,
            [clienteId]
          );
          const cliente = clienteRes.rows[0];
          if (!cliente) {
            return res.status(400).json({ error: "Cliente no encontrado" });
          }
          clienteNombre = cliente.titulo || null;
          requiereConfirmacionCliente = Boolean(cliente.requiere_confirmacion_cliente) && tipoSolicitud === TIPO_NUEVO;
        }

        const estadoInicial = enviarCorreos
          ? tipoSolicitud === TIPO_NUEVO && requiereConfirmacionCliente
            ? ESTADOS.pendienteConfirmacionCliente
            : ESTADOS.enProceso
          : ESTADOS.pendiente;

        const datosExtra =
          payload.datos_extra && typeof payload.datos_extra === "object" && !Array.isArray(payload.datos_extra)
            ? payload.datos_extra
            : {};

        if (payload.modulo_id && isUuid(payload.modulo_id) && !datosExtra.modulo_id) datosExtra.modulo_id = payload.modulo_id;
        if (payload.modulo && !datosExtra.modulo) datosExtra.modulo = payload.modulo;
        if (perfil && !datosExtra.modulo) datosExtra.modulo = perfil;
        if (clienteNombre && !datosExtra.cliente_nombre) datosExtra.cliente_nombre = clienteNombre;
        // Guardar perfil libre como modulo_otro cuando no se seleccionó un módulo del catálogo
        if (!datosExtra.modulo_id && perfil && !datosExtra.modulo_otro) datosExtra.modulo_otro = perfil;
        if (payload.factura_en_colombia !== undefined) {
          datosExtra.factura_en_colombia = normalizeFacturaEnColombiaInput(payload.factura_en_colombia);
        }
        if (payload.vpn_corona !== undefined) datosExtra.vpn_corona = vpnCorona;
        if (payload.necesita_s_user !== undefined) datosExtra.necesita_s_user = necesitaSUser;
        if (payload.grupo_app_tiempos !== undefined) datosExtra.grupo_usuario = grupoAppTiempos;
        if (payload.grupo_distribucion !== undefined) datosExtra.grupo_distribucion = grupoDistribucion;

        if (tipoSolicitud === TIPO_NUEVO && (personaUsuarioId || numeroDocumento)) {
          const legalContext = await fetchPersonaLegalContext(pool, { personaUsuarioId, numeroDocumento });
          mergeLegalContextIntoDatosExtra(datosExtra, legalContext);
        }

        // Validar pertenencia del anexo seleccionado antes del INSERT para evitar solicitudes huérfanas
        if (tipoSolicitud === TIPO_RETIRO && datosExtra?.anexo_item_id) {
          const anexoCheck = await pool.query(
            `SELECT 1 FROM anexo_tecnico_items
             WHERE public_id::text = $1::text
               AND estado = 'activo'
               AND (
                 ($2::int IS NOT NULL AND usuario_id = $2)
                 OR ($3::text IS NOT NULL AND numero_documento = $3)
               )
             LIMIT 1`,
            [datosExtra.anexo_item_id, personaUsuarioId || null, numeroDocumento || null]
          );
          if (!anexoCheck.rows.length) {
            return res.status(422).json({ error: "El contrato seleccionado no existe, ya fue retirado o no pertenece a esta persona" });
          }
        }

        if (tipoSolicitud === TIPO_EXTENSION) {
          const [extensionContext, supervisorMeta] = await Promise.all([
            buildPersonaExtensionContext({
              userInternalId: personaUsuarioId,
              numeroDocumento,
              correoPersonal,
              correoEmpresarial,
              preferAnexoItemId: toNullableString(datosExtra?.anexo_item_id)
            }),
            resolveUsuarioMeta(supervisorId)
          ]);
          const extensionExtra = buildExtensionExtraContext(extensionContext, {
            cliente_id: payload.cliente_id || null,
            cliente_nombre: clienteNombre || extensionContext?.cliente_nombre || null,
            supervisor_id: supervisorMeta?.public_id || payload.supervisor_id || null,
            supervisor_nombre: supervisorMeta?.nombre_usuario || extensionContext?.supervisor_nombre || null,
            perfil,
            moneda: monedaFinal,
            modalidad_contrato: modalidadContrato,
            fecha_extension_desde: fechaExtensionDesde,
            fecha_extension_hasta: fechaExtensionHasta,
            tarifa_hora: payload.tarifa_hora,
            tarifa_mes: payload.tarifa_mes,
            tarifa_medio_tiempo: payload.tarifa_medio_tiempo,
            tarifa_capacitacion: payload.tarifa_capacitacion
          });
          if (extensionExtra?.tipo_asignacion && !datosExtra.tipo_asignacion) {
            datosExtra.tipo_asignacion = extensionExtra.tipo_asignacion;
          }
          if (extensionExtra?.extension_base) {
            datosExtra.extension_base = extensionExtra.extension_base;
          }
          if (Array.isArray(extensionExtra?.extension_cambios) && extensionExtra.extension_cambios.length) {
            datosExtra.extension_cambios = extensionExtra.extension_cambios;
          }
        }

        const inserted = await pool.query(
          `
          INSERT INTO solicitudes_contratacion (
            tipo_solicitud,
            estado,
            coordinador_solicitante_id,
            persona_usuario_id,
            supervisor_id,
            preregistro_id,
            cliente_id,
            tipo_documento_id,
            origen_flujo,
            nombre,
            apellidos,
            numero_documento,
            perfil,
            correo_personal,
            correo_empresarial,
            telefono,
            ubicacion,
            grupo_app_tiempos,
            grupo_distribucion,
            vpn_corona,
            necesita_s_user,
            grupo_usuario_otro,
            moneda,
            tarifa_hora,
            tarifa_mes,
            tarifa_medio_tiempo,
            tarifa_capacitacion,
            modalidad_contrato,
            fecha_inicio,
            fecha_fin,
            fecha_extension_desde,
            fecha_extension_hasta,
            fecha_retiro,
            necesidad_ti,
            observaciones,
            datos_extra,
            crear_usuario_sistema,
            requiere_confirmacion_cliente,
            correo_enviado_mesa,
            correo_enviado_th,
            correo_confirmacion_coordinador
          )
          VALUES (
            $1,  $2,  $3,  $4,  $5,  $6,  $7,  $8,  $9,  $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
            $31, $32, $33, $34, $35, $36, $37, $38, false, false, false
          )
          RETURNING id
          `,
          [
            tipoSolicitud,
            estadoInicial,
            req.user?.id,
            personaUsuarioId,
            supervisorId,
            null,
            clienteId,
            tipoDocumentoId,
            "coordinacion",
            nombre,
            apellidos,
            numeroDocumento,
            perfil,
            correoPersonal,
            correoEmpresarial,
            telefono,
            ubicacion,
            grupoAppTiempos,
            grupoDistribucion,
            vpnCorona,
            necesitaSUser,
            grupoUsuarioOtro,
            monedaFinal,
            toNullableNumber(payload.tarifa_hora),
            toNullableNumber(payload.tarifa_mes),
            toNullableNumber(payload.tarifa_medio_tiempo),
            toNullableNumber(payload.tarifa_capacitacion),
            modalidadContrato,
            fechaInicio,
            fechaFin,
            fechaExtensionDesde,
            fechaExtensionHasta,
            fechaRetiro,
            necesidadTi,
            observaciones,
            JSON.stringify(datosExtra),
            crearUsuarioSistema,
            requiereConfirmacionCliente
          ]
        );

        const createdId = inserted.rows[0]?.id;
        if (!createdId) {
          return res.status(500).json({ error: "No se pudo recuperar la solicitud creada" });
        }

        if (!enviarCorreos) {
          const created = await syncAnexoDesdeSolicitud(createdId, req.user?.id);
          return res.status(201).json(formatRow(created));
        }

        await dispatchAndFinalizeSolicitud({ internalId: createdId, req });
        const updated = await syncAnexoDesdeSolicitud(createdId, req.user?.id);
        return res.status(201).json(formatRow(updated));
      } catch (err) {
        if (err?.code === "PUBLIC_ID_NOT_FOUND") {
          return res.status(400).json({ error: "Cliente, supervisor, persona o tipo documento no valido" });
        }
        console.error(err);
        return res.status(500).json({ error: "Error creando solicitud de contratacion" });
      }
    }
  );

  app.post(
    "/contrataciones/solicitudes/:id/completar",
    requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }),
    async (req, res) => {
      const payload = req.body || {};
      try {
        const current = await getByPublicId(pool, req.params.id);
        if (!current) return res.status(404).json({ error: "Solicitud no encontrada" });
        const internalId = current.id;

        if (!requireOwnerIfCoordinator(req, current)) {
          return res.status(403).json({ error: "No puedes operar solicitudes de otro coordinador" });
        }
        if (current.estado === ESTADOS.completado) {
          return res.status(422).json({ error: "La solicitud ya esta completada" });
        }

        const tipoSolicitud = current.tipo_solicitud;
        const tipoSolicitudInput = payload.tipo_solicitud ? normalizeTipoSolicitud(payload.tipo_solicitud) : tipoSolicitud;
        if (!tipoSolicitudInput || tipoSolicitudInput !== tipoSolicitud) {
          return res.status(400).json({ error: "No se puede cambiar tipo_solicitud en esta operacion" });
        }

        const nombre = payload.nombre !== undefined ? toNullableString(payload.nombre) : current.nombre;
        const apellidos = payload.apellidos !== undefined ? toNullableString(payload.apellidos) : current.apellidos;
        const numeroDocumento =
          payload.numero_documento !== undefined ? toNullableString(payload.numero_documento) : current.numero_documento;
        const perfil = payload.perfil !== undefined ? toNullableString(payload.perfil) : current.perfil;
        const correoPersonal =
          payload.correo_personal !== undefined ? toNullableString(payload.correo_personal) : current.correo_personal;
        const correoEmpresarial =
          payload.correo_empresarial !== undefined ? toNullableString(payload.correo_empresarial) : current.correo_empresarial;
        const telefono = payload.telefono !== undefined ? toNullableString(payload.telefono) : current.telefono;
        const ubicacion = payload.ubicacion !== undefined ? toNullableString(payload.ubicacion) : current.ubicacion;
        const grupoAppTiempos =
          payload.grupo_app_tiempos !== undefined ? toNullableString(payload.grupo_app_tiempos) : current.grupo_app_tiempos;
        const grupoDistribucion =
          payload.grupo_distribucion !== undefined ? toNullableString(payload.grupo_distribucion) : current.grupo_distribucion;
        const vpnCorona =
          payload.vpn_corona !== undefined
            ? (payload.vpn_corona === true || payload.vpn_corona === "true" || payload.vpn_corona === 1)
            : Boolean(current.vpn_corona);
        const necesitaSUser =
          payload.necesita_s_user !== undefined
            ? (payload.necesita_s_user === true || payload.necesita_s_user === "true" || payload.necesita_s_user === 1)
            : Boolean(current.necesita_s_user);
        const grupoUsuarioOtro =
          payload.grupo_usuario_otro !== undefined ? toNullableString(payload.grupo_usuario_otro) : current.grupo_usuario_otro;
        const necesidadTi =
          payload.necesidad_ti !== undefined ? toNullableString(payload.necesidad_ti) : current.necesidad_ti;
        const observaciones = payload.observaciones !== undefined ? toNullableString(payload.observaciones) : current.observaciones;
        const crearUsuarioSistema = payload.crear_usuario_sistema !== undefined
          ? normalizeBooleanFlag(payload.crear_usuario_sistema, true)
          : current.crear_usuario_sistema !== false;

        if (crearUsuarioSistema === null) {
          return res.status(400).json({ error: "crear_usuario_sistema debe ser booleano" });
        }

        if (!nombre || !apellidos) {
          return res.status(400).json({ error: "nombre y apellidos son obligatorios" });
        }
        if (tipoSolicitud === TIPO_RETIRO && !necesidadTi) {
          return res.status(400).json({ error: "necesidad_ti es obligatoria para retiros" });
        }

        const monedaInput = payload.moneda !== undefined ? payload.moneda : current.moneda;
        let moneda = monedaInput ? normalizeMoneda(monedaInput) : null;
        if (monedaInput && !moneda) {
          return res.status(400).json({ error: "moneda invalida. Usa COP, USD o EUR" });
        }

        const modalidadInput = payload.modalidad_contrato !== undefined ? payload.modalidad_contrato : current.modalidad_contrato;
        const modalidadContrato = modalidadInput ? normalizeModalidad(modalidadInput) : null;
        if (modalidadInput && !modalidadContrato) {
          return res
            .status(400)
            .json({ error: "modalidad_contrato invalida. Usa Full time, Medio tiempo o Por horas" });
        }

        const fechaInicio = payload.fecha_inicio !== undefined
          ? (payload.fecha_inicio ? normalizeDateOnly(payload.fecha_inicio) : null)
          : current.fecha_inicio;
        const fechaFin = payload.fecha_fin !== undefined
          ? (payload.fecha_fin ? normalizeDateOnly(payload.fecha_fin) : null)
          : current.fecha_fin;
        const fechaExtensionDesde = payload.fecha_extension_desde !== undefined
          ? (payload.fecha_extension_desde ? normalizeDateOnly(payload.fecha_extension_desde) : null)
          : current.fecha_extension_desde;
        const fechaExtensionHasta = payload.fecha_extension_hasta !== undefined
          ? (payload.fecha_extension_hasta ? normalizeDateOnly(payload.fecha_extension_hasta) : null)
          : current.fecha_extension_hasta;
        const fechaRetiro = payload.fecha_retiro !== undefined
          ? (payload.fecha_retiro ? normalizeDateOnly(payload.fecha_retiro) : null)
          : current.fecha_retiro;

        if (payload.fecha_inicio !== undefined && payload.fecha_inicio && !fechaInicio) {
          return res.status(400).json({ error: "fecha_inicio invalida" });
        }
        if (payload.fecha_fin !== undefined && payload.fecha_fin && !fechaFin) {
          return res.status(400).json({ error: "fecha_fin invalida" });
        }
        if (payload.fecha_extension_desde !== undefined && payload.fecha_extension_desde && !fechaExtensionDesde) {
          return res.status(400).json({ error: "fecha_extension_desde invalida" });
        }
        if (payload.fecha_extension_hasta !== undefined && payload.fecha_extension_hasta && !fechaExtensionHasta) {
          return res.status(400).json({ error: "fecha_extension_hasta invalida" });
        }
        if (payload.fecha_retiro !== undefined && payload.fecha_retiro && !fechaRetiro) {
          return res.status(400).json({ error: "fecha_retiro invalida" });
        }

        if (correoPersonal && !isValidEmail(correoPersonal)) {
          return res.status(400).json({ error: "correo_personal no tiene un formato valido" });
        }
        if (correoEmpresarial && !isValidEmail(correoEmpresarial)) {
          return res.status(400).json({ error: "correo_empresarial no tiene un formato valido" });
        }
        if (tipoSolicitud === TIPO_NUEVO) {
          const currentExtra = toObjectOrEmpty(current.datos_extra);
          const incomingExtra = toObjectOrEmpty(payload.datos_extra);
          const factura = normalizeFacturaEnColombiaInput(
            payload.factura_en_colombia ?? incomingExtra.factura_en_colombia ?? currentExtra.factura_en_colombia
          );
          const tieneTarifa = [
            payload.tarifa_hora !== undefined ? payload.tarifa_hora : current.tarifa_hora,
            payload.tarifa_mes !== undefined ? payload.tarifa_mes : current.tarifa_mes,
            payload.tarifa_medio_tiempo !== undefined ? payload.tarifa_medio_tiempo : current.tarifa_medio_tiempo,
            payload.tarifa_capacitacion !== undefined ? payload.tarifa_capacitacion : current.tarifa_capacitacion
          ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
          const moduloRef = payload.modulo_id || incomingExtra.modulo_id || currentExtra.modulo_id;
          const missing = [];
          if (!numeroDocumento) missing.push("numero_documento");
          if (!(payload.tipo_documento_id || current.tipo_documento_public_id)) missing.push("tipo_documento_id");
          if (!correoPersonal) missing.push("correo_personal");
          if (!perfil && !moduloRef) missing.push("perfil o modulo_id");
          if (!fechaInicio) missing.push("fecha_inicio");
          if (!moneda) missing.push("moneda");
          if (factura === null) missing.push("factura_en_colombia");
          if (!tieneTarifa) missing.push("tarifa");
          if (crearUsuarioSistema && !grupoAppTiempos) missing.push("grupo_app_tiempos");
          if (!grupoDistribucion) missing.push("grupo_distribucion");
          if (missing.length) {
            return res.status(422).json({
              error: `Faltan datos obligatorios para contratar: ${missing.join(", ")}`,
              missing
            });
          }
        }

        const personaPublicId =
          payload.persona_usuario_id !== undefined ? toNullableString(payload.persona_usuario_id) : current.persona_public_id;
        const supervisorPublicId =
          payload.supervisor_id !== undefined ? toNullableString(payload.supervisor_id) : current.supervisor_public_id;
        const tipoDocumentoPublicId =
          payload.tipo_documento_id !== undefined ? toNullableString(payload.tipo_documento_id) : current.tipo_documento_public_id;
        const clientePublicId =
          payload.cliente_id !== undefined ? toNullableString(payload.cliente_id) : current.cliente_public_id;

        const refsRes = await pool.query(
          `
          SELECT
            (SELECT id FROM usuarios WHERE public_id::text = $1::text) AS persona_usuario_id,
            (SELECT id FROM usuarios WHERE public_id::text = $2::text) AS supervisor_id,
            (SELECT id FROM documento_identidad WHERE public_id::text = $3::text) AS tipo_documento_id,
            (SELECT id FROM clientes WHERE public_id::text = $4::text) AS cliente_id
          `,
          [personaPublicId || null, supervisorPublicId || null, tipoDocumentoPublicId || null, clientePublicId || null]
        );
        const refs = refsRes.rows[0];

        if (personaPublicId && !refs.persona_usuario_id) throw { code: "PUBLIC_ID_NOT_FOUND" };
        if (supervisorPublicId && !refs.supervisor_id) throw { code: "PUBLIC_ID_NOT_FOUND" };
        if (tipoDocumentoPublicId && !refs.tipo_documento_id) throw { code: "PUBLIC_ID_NOT_FOUND" };
        if (clientePublicId && !refs.cliente_id) throw { code: "PUBLIC_ID_NOT_FOUND" };

        const personaUsuarioId = refs.persona_usuario_id || null;
        const supervisorId = refs.supervisor_id || null;
        const tipoDocumentoId = refs.tipo_documento_id || null;
        const clienteId = refs.cliente_id || null;
        if (!moneda) {
          moneda = await resolvePersonaMoneda(pool, personaUsuarioId);
        }

        if (tipoSolicitud === TIPO_EXTENSION && !numeroDocumento && !personaUsuarioId) {
          return res.status(400).json({
            error: "Para Extension debes seleccionar una persona existente o indicar numero_documento"
          });
        }
        if (tipoSolicitud === TIPO_EXTENSION && !correoPersonal && !correoEmpresarial) {
          return res.status(400).json({
            error: "Para Extension se requiere al menos un correo de referencia de la persona a modificar"
          });
        }

        if (tipoSolicitud === TIPO_NUEVO && correoPersonal) {
          const correoConflict = await findCorreoPersonaConflict(pool, {
            correo: correoPersonal,
            numeroDocumento,
            excludeSolicitudId: internalId,
            excludePreregistroId: current.preregistro_id || null
          });
          if (correoConflict) {
            return res.status(422).json({
              error: "El correo personal ya pertenece a otra persona. Verifica el documento antes de continuar."
            });
          }
        }

        const clienteNombreProspectoCompletar = toNullableString(
          (payload.datos_extra && !Array.isArray(payload.datos_extra) ? payload.datos_extra : {})?.cliente_nombre
          || (current.datos_extra && !Array.isArray(current.datos_extra) ? current.datos_extra : {})?.cliente_nombre
        );
        if (tipoSolicitud === TIPO_NUEVO && !clienteId && !clienteNombreProspectoCompletar) {
          return res.status(400).json({ error: "Selecciona un cliente o escribe el nombre del prospecto" });
        }
        if (tipoSolicitud === TIPO_RETIRO && !fechaRetiro) {
          return res.status(400).json({ error: "fecha_retiro es obligatoria para solicitudes de retiro" });
        }

        let clienteNombre = null;
        let requiereConfirmacionCliente = false;
        if (clienteId) {
          const clienteRes = await pool.query(
            `
            SELECT titulo, COALESCE(requiere_confirmacion_cliente, false) AS requiere_confirmacion_cliente
            FROM clientes
            WHERE id = $1
            LIMIT 1
            `,
            [clienteId]
          );
          const cliente = clienteRes.rows[0];
          if (!cliente) {
            return res.status(400).json({ error: "Cliente no encontrado" });
          }
          clienteNombre = cliente.titulo || null;
          requiereConfirmacionCliente = Boolean(cliente.requiere_confirmacion_cliente) && tipoSolicitud === TIPO_NUEVO;
        }

        const existingDatosExtra =
          current.datos_extra && typeof current.datos_extra === "object" && !Array.isArray(current.datos_extra)
            ? current.datos_extra
            : {};
        const incomingDatosExtra =
          payload.datos_extra && typeof payload.datos_extra === "object" && !Array.isArray(payload.datos_extra)
            ? payload.datos_extra
            : {};
        const datosExtra = { ...existingDatosExtra, ...incomingDatosExtra };
        if (payload.modulo_id && isUuid(payload.modulo_id) && !datosExtra.modulo_id) datosExtra.modulo_id = payload.modulo_id;
        if (payload.modulo && !datosExtra.modulo) datosExtra.modulo = payload.modulo;
        if (perfil && !datosExtra.modulo) datosExtra.modulo = perfil;
        if (clienteNombre && !datosExtra.cliente_nombre) datosExtra.cliente_nombre = clienteNombre;
        if (!datosExtra.modulo_id && perfil && !datosExtra.modulo_otro) datosExtra.modulo_otro = perfil;
        if (payload.factura_en_colombia !== undefined) {
          datosExtra.factura_en_colombia = normalizeFacturaEnColombiaInput(payload.factura_en_colombia);
        }
        if (payload.vpn_corona !== undefined) datosExtra.vpn_corona = vpnCorona;
        if (payload.necesita_s_user !== undefined) datosExtra.necesita_s_user = necesitaSUser;
        if (payload.grupo_app_tiempos !== undefined) datosExtra.grupo_usuario = grupoAppTiempos;
        if (payload.grupo_distribucion !== undefined) datosExtra.grupo_distribucion = grupoDistribucion;

        if (tipoSolicitud === TIPO_NUEVO && (personaUsuarioId || numeroDocumento)) {
          const legalContext = await fetchPersonaLegalContext(pool, { personaUsuarioId, numeroDocumento });
          mergeLegalContextIntoDatosExtra(datosExtra, legalContext);
        }

        if (tipoSolicitud === TIPO_EXTENSION) {
          const [extensionContext, supervisorMeta] = await Promise.all([
            buildPersonaExtensionContext({
              userInternalId: personaUsuarioId,
              numeroDocumento,
              correoPersonal,
              correoEmpresarial,
              preferAnexoItemId: toNullableString(datosExtra?.anexo_item_id)
            }),
            resolveUsuarioMeta(supervisorId)
          ]);
          const extensionExtra = buildExtensionExtraContext(extensionContext, {
            cliente_id: clientePublicId || null,
            cliente_nombre: clienteNombre || extensionContext?.cliente_nombre || null,
            supervisor_id: supervisorMeta?.public_id || supervisorPublicId || null,
            supervisor_nombre: supervisorMeta?.nombre_usuario || extensionContext?.supervisor_nombre || null,
            perfil,
            moneda,
            modalidad_contrato: modalidadContrato,
            fecha_extension_desde: fechaExtensionDesde,
            fecha_extension_hasta: fechaExtensionHasta,
            tarifa_hora: payload.tarifa_hora !== undefined ? payload.tarifa_hora : current.tarifa_hora,
            tarifa_mes: payload.tarifa_mes !== undefined ? payload.tarifa_mes : current.tarifa_mes,
            tarifa_medio_tiempo:
              payload.tarifa_medio_tiempo !== undefined ? payload.tarifa_medio_tiempo : current.tarifa_medio_tiempo,
            tarifa_capacitacion:
              payload.tarifa_capacitacion !== undefined ? payload.tarifa_capacitacion : current.tarifa_capacitacion
          });
          if (extensionExtra?.tipo_asignacion && !datosExtra.tipo_asignacion) {
            datosExtra.tipo_asignacion = extensionExtra.tipo_asignacion;
          }
          if (extensionExtra?.extension_base) {
            datosExtra.extension_base = extensionExtra.extension_base;
          }
          if (Array.isArray(extensionExtra?.extension_cambios) && extensionExtra.extension_cambios.length) {
            datosExtra.extension_cambios = extensionExtra.extension_cambios;
          }
        }

        await pool.query(
          `
          UPDATE solicitudes_contratacion
          SET
            estado = $1,
            persona_usuario_id = $2,
            supervisor_id = $3,
            cliente_id = $4,
            tipo_documento_id = $5,
            nombre = $6,
            apellidos = $7,
            numero_documento = $8,
            perfil = $9,
            correo_personal = $10,
            correo_empresarial = $11,
            telefono = $12,
            ubicacion = $13,
            grupo_app_tiempos = $14,
            grupo_distribucion = $15,
            vpn_corona = $16,
            necesita_s_user = $17,
            grupo_usuario_otro = $18,
            moneda = $19,
            tarifa_hora = $20,
            tarifa_mes = $21,
            tarifa_medio_tiempo = $22,
            tarifa_capacitacion = $23,
            modalidad_contrato = $24,
            fecha_inicio = $25,
            fecha_fin = $26,
            fecha_extension_desde = $27,
            fecha_extension_hasta = $28,
            fecha_retiro = $29,
            necesidad_ti = $30,
            observaciones = $31,
            datos_extra = $32::jsonb,
            crear_usuario_sistema = $33,
            requiere_confirmacion_cliente = $34,
            correo_enviado_mesa = false,
            correo_enviado_th = false,
            correo_confirmacion_coordinador = false,
            revisado_th_por = NULL,
            fecha_revision_th = NULL,
            observaciones_th = NULL
          WHERE id = $35
          `,
          [
            ESTADOS.enProceso,
            personaUsuarioId,
            supervisorId,
            clienteId,
            tipoDocumentoId,
            nombre,
            apellidos,
            numeroDocumento,
            perfil,
            correoPersonal,
            correoEmpresarial,
            telefono,
            ubicacion,
            grupoAppTiempos,
            grupoDistribucion,
            vpnCorona,
            necesitaSUser,
            grupoUsuarioOtro,
            moneda,
            toNullableNumber(payload.tarifa_hora !== undefined ? payload.tarifa_hora : current.tarifa_hora),
            toNullableNumber(payload.tarifa_mes !== undefined ? payload.tarifa_mes : current.tarifa_mes),
            toNullableNumber(
              payload.tarifa_medio_tiempo !== undefined ? payload.tarifa_medio_tiempo : current.tarifa_medio_tiempo
            ),
            toNullableNumber(
              payload.tarifa_capacitacion !== undefined ? payload.tarifa_capacitacion : current.tarifa_capacitacion
            ),
            modalidadContrato,
            fechaInicio,
            fechaFin,
            fechaExtensionDesde,
            fechaExtensionHasta,
            fechaRetiro,
            necesidadTi,
            observaciones,
            JSON.stringify(datosExtra),
            crearUsuarioSistema,
            requiereConfirmacionCliente,
            internalId
          ]
        );

        const shouldRedispatchOnlyTh =
          tipoSolicitud === TIPO_NUEVO &&
          current.estado === ESTADOS.pendienteCoordinador &&
          (Boolean(current.correo_enviado_mesa) || Boolean(current.correo_enviado_th) || Boolean(current.fecha_revision_th));

        if (shouldRedispatchOnlyTh) {
          await pool.query(
            `
            UPDATE solicitudes_contratacion
            SET correo_enviado_mesa = $1
            WHERE id = $2
            `,
            [Boolean(current.correo_enviado_mesa), internalId]
          );
          await redispatchReturnedSolicitudToTh({ internalId, req });
        } else {
          await dispatchAndFinalizeSolicitud({ internalId, req });
        }

        const afterDispatch = await getByInternalId(pool, internalId);
        await syncLinkedPreregistroFromSolicitud(pool, afterDispatch, {
          actorUserId: req.user?.id || null,
          markCoordinadorCompletion: true
        });

        const updated = await syncAnexoDesdeSolicitud(internalId, req.user?.id);
        return res.json(formatRow(updated));
      } catch (err) {
        if (err?.code === "PUBLIC_ID_NOT_FOUND") {
          return res.status(400).json({ error: "Cliente, supervisor, persona o tipo documento no valido" });
        }
        console.error(err);
        return res.status(500).json({ error: "Error completando solicitud de contratacion" });
      }
    }
  );

  app.patch(
    "/contrataciones/solicitudes/:id/devolver-coordinador",
    requireAccess({ roles: ["Administrador", "Talento Humano"] }),
    async (req, res) => {
      try {
        const row = await getByPublicId(pool, req.params.id);
        if (!row) return res.status(404).json({ error: "Solicitud no encontrada" });
        const internalId = row.id;

        if (row.tipo_solicitud !== TIPO_NUEVO) {
          return res.status(422).json({ error: "Solo aplica para solicitudes tipo Nuevo" });
        }
        if (![ESTADOS.pendienteRevisionTh, ESTADOS.pendienteCorreoSilver].includes(row.estado)) {
          return res.status(422).json({
            error: `La solicitud debe estar en '${ESTADOS.pendienteRevisionTh}' o '${ESTADOS.pendienteCorreoSilver}' para devolverse a coordinador`
          });
        }

        const observaciones = toNullableString(req.body?.observaciones_th);
        if (!observaciones || observaciones.length < 10) {
          return res.status(400).json({ error: "Las observaciones de devolucion deben tener al menos 10 caracteres" });
        }

        await pool.query(
          `
          UPDATE solicitudes_contratacion
          SET
            estado = $1,
            revisado_th_por = $2,
            fecha_revision_th = NOW(),
            observaciones_th = $3,
            correo_enviado_th = false,
            updated_at = NOW()
          WHERE id = $4
          `,
          [ESTADOS.pendienteCoordinador, req.user?.id || null, observaciones, internalId]
        );

        const updatedSolicitud = await getByInternalId(pool, internalId);
        await syncLinkedPreregistroFromSolicitud(pool, updatedSolicitud, {
          actorUserId: req.user?.id || null
        });

        if (row.coordinador_email) {
          sendMail(
            getGraphContext(req),
            row.coordinador_email,
            buildMailCoordinadorDevolucionTh(formatRow(updatedSolicitud), observaciones)
          ).catch((mailErr) => {
            console.error("Error notificando devolucion a coordinador:", mailErr?.message || mailErr);
          });
        }

        const updated = await syncAnexoDesdeSolicitud(internalId, req.user?.id);
        return res.json(formatRow(updated));
      } catch (err) {
        if (err?.code === "PUBLIC_ID_NOT_FOUND") {
          return res.status(404).json({ error: "Solicitud no encontrada" });
        }
        console.error(err);
        return res.status(500).json({ error: "Error devolviendo solicitud a coordinador" });
      }
    }
  );

  app.patch(
    "/contrataciones/solicitudes/:id/seccion-3",
    requireAccess({ roles: ["Administrador", "Talento Humano"] }),
    async (req, res) => {
      const client = await pool.connect();
      let transactionStarted = false;
      try {
        const row = await getByPublicId(client, req.params.id);
        if (!row) return res.status(404).json({ error: "Solicitud no encontrada" });
        const internalId = row.id;

        if (![ESTADOS.pendienteRevisionTh, ESTADOS.pendienteCorreoSilver].includes(row.estado)) {
          return res.status(422).json({
            error: `Solo se puede editar la sección 3 en estado '${ESTADOS.pendienteRevisionTh}' o '${ESTADOS.pendienteCorreoSilver}'`
          });
        }

        const bancoId     = await resolveBancoInternalId(client, req.body?.banco_id);
        const tipoCuenta  = toNullableString(req.body?.tipo_cuenta);
        const numeroCuenta = toNullableString(req.body?.numero_cuenta);
        const direccion   = toNullableString(req.body?.direccion);
        const tipoPersona = normalizeTipoPersonaForForm(req.body?.tipo_persona);
        const correoSilver = toNullableString(req.body?.correo_silver);
        const razonSocial = toNullableString(req.body?.razon_social);
        const nitEmpresa = toNullableString(req.body?.nit_empresa);
        const representanteLegal = toNullableString(req.body?.representante_legal);
        const tipoDocumentoRepresentante = toNullableString(req.body?.tipo_documento_representante);
        const numeroDocumentoRepresentante = toNullableString(req.body?.numero_documento_representante);

        if (!bancoId) {
          return res.status(400).json({ error: "Banco no válido" });
        }
        if (!direccion || !tipoPersona || !TIPOS_CUENTA.has(tipoCuenta) || !numeroCuenta) {
          return res.status(400).json({
            error: "Completa direccion, tipo de persona, tipo de cuenta y numero de cuenta"
          });
        }
        if (
          tipoPersona === "Juridica" &&
          (!razonSocial || !nitEmpresa || !representanteLegal ||
            !tipoDocumentoRepresentante || !numeroDocumentoRepresentante)
        ) {
          return res.status(400).json({
            error: "Para persona juridica son obligatorios razon social, NIT y datos del representante legal"
          });
        }
        if (correoSilver && !isValidSilverEmail(correoSilver)) {
          return res.status(400).json({
            error: "El correo Silver debe pertenecer al dominio @silverconsulting.com.co"
          });
        }

        const bancoPublicId = await resolveBancoPublicId(client, bancoId);
        const debeCrearUsuario = row.crear_usuario_sistema !== false;
        const nextEstado = correoSilver || !debeCrearUsuario
          ? ESTADOS.pendienteRevisionTh
          : ESTADOS.pendienteCorreoSilver;

        // Guarda datos bancarios en datos_extra y correo silver en correo_empresarial
        await client.query("BEGIN");
        transactionStarted = true;
        await client.query(
          `
          UPDATE solicitudes_contratacion
          SET
            correo_empresarial = COALESCE($1, correo_empresarial),
            datos_extra        = datos_extra || $2::jsonb,
            estado             = $3,
            updated_at         = NOW()
          WHERE id = $4
          `,
          [
            correoSilver,
            JSON.stringify({
              banco_id:      bancoPublicId || bancoId,
              tipo_cuenta:   tipoCuenta,
              numero_cuenta: numeroCuenta,
              direccion:     direccion,
              tipo_persona:  tipoPersona,
              razon_social: razonSocial,
              nit_empresa: nitEmpresa,
              representante_legal: representanteLegal,
              tipo_documento_representante: tipoDocumentoRepresentante,
              numero_documento_representante: numeroDocumentoRepresentante
            }),
            nextEstado,
            internalId
          ]
        );

        const rowAfterSection3 = await getByInternalId(client, internalId);
        await materializePersonaDesdeSolicitud(client, rowAfterSection3, req.user?.id || null);
        await syncLinkedPreregistroFromSolicitud(client, rowAfterSection3, {
          actorUserId: req.user?.id || null,
          markThCompletion: true
        });
        await client.query("COMMIT");
        transactionStarted = false;
        const updated = await syncAnexoDesdeSolicitud(internalId, req.user?.id);
        return res.json(formatRow(updated));
      } catch (err) {
        if (transactionStarted) {
          try {
            await client.query("ROLLBACK");
          } catch (_) {}
        }
        if (err?.code === "PERSONA_DOCUMENTO_REQUIRED") {
          return res.status(err.statusCode || 422).json({ error: err.message });
        }
        console.error(err);
        return res.status(500).json({ error: "Error guardando sección 3 de contratación" });
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/contrataciones/solicitudes/:id/revision-th",
    requireAccess({ roles: ["Administrador", "Talento Humano"] }),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const row = await getByPublicId(client, req.params.id);
        if (!row) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Solicitud no encontrada" });
        }
        const internalId = row.id;

        if (row.tipo_solicitud !== TIPO_NUEVO) {
          await client.query("ROLLBACK");
          return res.status(422).json({ error: "La revision TH solo aplica para solicitudes tipo Nuevo" });
        }
        if (![ESTADOS.pendienteRevisionTh, ESTADOS.pendienteCorreoSilver].includes(row.estado)) {
          await client.query("ROLLBACK");
          return res.status(422).json({
            error: `La solicitud debe estar en '${ESTADOS.pendienteRevisionTh}' o '${ESTADOS.pendienteCorreoSilver}' para ser revisada por TH`
          });
        }
        const debeCrearUsuario = row.crear_usuario_sistema !== false;
        const correoSilver = String(row.correo_empresarial || "").trim().toLowerCase();
        if (debeCrearUsuario) {
          if (!correoSilver) {
            await client.query("ROLLBACK");
            return res.status(422).json({ error: "Se requiere el correo Silver antes de completar la revisión TH" });
          }
          if (!isValidSilverEmail(correoSilver)) {
            await client.query("ROLLBACK");
            return res.status(422).json({ error: "El correo Silver debe pertenecer al dominio @silverconsulting.com.co" });
          }
        }
        const correoEmpresarialFinal = debeCrearUsuario ? correoSilver : toNullableString(row.correo_empresarial);

        const datosExtra = toObjectOrEmpty(row.datos_extra);
        const direccion = toNullableString(datosExtra.direccion);
        const bancoId = await resolveBancoInternalId(client, datosExtra.banco_id);
        const tipoCuenta = toNullableString(datosExtra.tipo_cuenta);
        const numeroCuenta = toNullableString(datosExtra.numero_cuenta);
        const tipoPersona = normalizeTipoPersonaForUsuarios(datosExtra.tipo_persona);
        const clienteOtroContrat = row.cliente_id ? null : toNullableString(datosExtra.cliente_nombre);
        const facturaEnColombia =
          datosExtra.factura_en_colombia === true || datosExtra.factura_en_colombia === "true"
            ? true
            : datosExtra.factura_en_colombia === false || datosExtra.factura_en_colombia === "false"
              ? false
              : null;
        const razonSocialContrat = toNullableString(datosExtra.razon_social);
        const nitEmpresaContrat = toNullableString(datosExtra.nit_empresa);
        const repLegalContrat = toNullableString(datosExtra.representante_legal);
        const tipoDocRepContrat = toNullableString(datosExtra.tipo_documento_representante);
        const numDocRepContrat = toNullableString(datosExtra.numero_documento_representante);

        if (!direccion || !bancoId || !tipoCuenta || !numeroCuenta || !tipoPersona) {
          await client.query("ROLLBACK");
          return res.status(422).json({
            error:
              "Faltan datos de la sección 3. Completa dirección, tipo persona, banco, tipo de cuenta y número de cuenta."
          });
        }
        if (
          tipoPersona === "Juridica" &&
          (!razonSocialContrat || !nitEmpresaContrat || !repLegalContrat || !tipoDocRepContrat || !numDocRepContrat)
        ) {
          await client.query("ROLLBACK");
          return res.status(422).json({
            error: "Para persona juridica son obligatorios razon social, NIT y datos del representante legal"
          });
        }

        let personaUsuarioId = debeCrearUsuario ? row.persona_usuario_id || null : null;
        let usuarioCreado = null;

        // ── UPSERT en tabla personas (núcleo de datos personales) ─────────────
        const moduloUuidContrat = datosExtra.modulo_id || null;
        let moduloInternoIdContrat = null;
        if (moduloUuidContrat) {
          const modRes = await client.query(`SELECT id FROM modulo WHERE public_id::text = $1::text LIMIT 1`, [moduloUuidContrat]);
          moduloInternoIdContrat = modRes.rows[0]?.id || null;
        }
        const moduloOtroContrat = !moduloInternoIdContrat
          ? (datosExtra.modulo_nombre || datosExtra.modulo_otro || datosExtra.modulo || row.perfil || null)
          : null;

        const tipoCuentaResPersona = await client.query(
          `SELECT id FROM tipo_cuenta_bancaria WHERE LOWER(titulo) LIKE LOWER($1) LIMIT 1`,
          [`${tipoCuenta}%`]
        );

        const personaResContrat = await client.query(
          `INSERT INTO personas (
            numero_documento, tipo_documento_id, nombre, apellidos,
            numero_contacto, correo_electronico, direccion_residencia, ciudad_residencia,
            tipo_persona, factura_en_colombia,
            banco_id, tipo_cuenta_id, numero_cuenta,
            modulo_id, modulo_otro, cliente_id, cliente_otro,
            razon_social, nit_empresa, representante_legal,
            tipo_documento_representante, numero_documento_representante,
            created_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::tipo_persona, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
          ON CONFLICT (numero_documento) DO UPDATE SET
            nombre                         = COALESCE(EXCLUDED.nombre, personas.nombre),
            apellidos                      = COALESCE(EXCLUDED.apellidos, personas.apellidos),
            numero_contacto                = COALESCE(EXCLUDED.numero_contacto, personas.numero_contacto),
            correo_electronico             = COALESCE(EXCLUDED.correo_electronico, personas.correo_electronico),
            direccion_residencia           = COALESCE(EXCLUDED.direccion_residencia, personas.direccion_residencia),
            ciudad_residencia              = COALESCE(EXCLUDED.ciudad_residencia, personas.ciudad_residencia),
            tipo_persona                   = COALESCE(EXCLUDED.tipo_persona, personas.tipo_persona),
            factura_en_colombia            = COALESCE(EXCLUDED.factura_en_colombia, personas.factura_en_colombia),
            banco_id                       = COALESCE(EXCLUDED.banco_id, personas.banco_id),
            tipo_cuenta_id                 = COALESCE(EXCLUDED.tipo_cuenta_id, personas.tipo_cuenta_id),
            numero_cuenta                  = COALESCE(EXCLUDED.numero_cuenta, personas.numero_cuenta),
            modulo_id                      = COALESCE(EXCLUDED.modulo_id, personas.modulo_id),
            modulo_otro                    = COALESCE(EXCLUDED.modulo_otro, personas.modulo_otro),
            cliente_id                     = COALESCE(EXCLUDED.cliente_id, personas.cliente_id),
            cliente_otro                   = COALESCE(EXCLUDED.cliente_otro, personas.cliente_otro),
            razon_social                   = COALESCE(EXCLUDED.razon_social, personas.razon_social),
            nit_empresa                    = COALESCE(EXCLUDED.nit_empresa, personas.nit_empresa),
            representante_legal            = COALESCE(EXCLUDED.representante_legal, personas.representante_legal),
            tipo_documento_representante   = COALESCE(EXCLUDED.tipo_documento_representante, personas.tipo_documento_representante),
            numero_documento_representante = COALESCE(EXCLUDED.numero_documento_representante, personas.numero_documento_representante),
            updated_at                     = NOW()
          RETURNING id`,
          [
            row.numero_documento || null,
            row.tipo_documento_id || null,
            row.nombre || null,
            row.apellidos || null,
            row.telefono || null,
            row.correo_personal || null,
            direccion,
            row.ubicacion || null,
            tipoPersona,
            facturaEnColombia,
            bancoId,
            tipoCuentaResPersona.rows[0]?.id || null,
            numeroCuenta,
            moduloInternoIdContrat,
            moduloOtroContrat,
            row.cliente_id || null,
            clienteOtroContrat,
            razonSocialContrat,
            nitEmpresaContrat,
            repLegalContrat,
            tipoDocRepContrat,
            numDocRepContrat,
            req.user?.id || null
          ]
        );
        const personaIdContrat = personaResContrat.rows[0]?.id || null;
        // ────────────────────────────────────────────────────────────────────

        if (debeCrearUsuario) {
          if (!personaUsuarioId) {
          const dup = await client.query(`SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1`, [correoSilver]);
          if (dup.rows.length > 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "Ya existe un usuario con ese correo Silver" });
          }

          const [rolRes, tipoCuentaRes] = await Promise.all([
            client.query(`SELECT id FROM roles WHERE LOWER(titulo) = LOWER('Consultor') LIMIT 1`),
            client.query(`SELECT id FROM tipo_cuenta_bancaria WHERE LOWER(titulo) LIKE LOWER($1) LIMIT 1`, [`${tipoCuenta}%`])
          ]);
          const rolId = rolRes.rows[0]?.id || null;
          if (!rolId) {
            await client.query("ROLLBACK");
            return res.status(500).json({ error: "No existe el rol Consultor" });
          }

          const nombreCompleto = `${row.nombre || ""} ${row.apellidos || ""}`.trim();
          const moneda = normalizeMoneda(row.moneda) || "COP";
          const usuarioRes = await client.query(
            `INSERT INTO usuarios
              (nombre_usuario, email, rol_usuario_id, activo, nro_cuenta_bancaria, banco_id, tipo_cuenta_id, tipo_documento_id, cedula, direccion, telefono, ciudad, tipo_persona, moneda_cobro, factura_en_colombia, persona_id, created_by, azure_oid)
             VALUES
              ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12::tipo_persona, $13::tipo_moneda, $14, $15, 'contratacion_th', NULL)
             RETURNING id, public_id, nombre_usuario, email`,
            [
              nombreCompleto || correoSilver,
              correoSilver,
              rolId,
              numeroCuenta,
              bancoId,
              tipoCuentaRes.rows[0]?.id || null,
              row.tipo_documento_id || null,
              row.numero_documento || null,
              direccion,
              row.telefono || null,
              row.ubicacion || null,
              tipoPersona,
              moneda,
              facturaEnColombia,
              personaIdContrat
            ]
          );

          personaUsuarioId = usuarioRes.rows[0]?.id || null;
          usuarioCreado = usuarioRes.rows[0] || null;
        } else {
          // Persona ya tenía usuario: vincular persona_id si aún no está seteado
          if (personaIdContrat) {
            await client.query(
              `UPDATE usuarios SET persona_id = $1, updated_at = NOW() WHERE id = $2 AND persona_id IS NULL`,
              [personaIdContrat, personaUsuarioId]
            );
          }
          }
        }

        const observaciones = toNullableString(req.body?.observaciones_th);

        await client.query(
          `
          UPDATE solicitudes_contratacion
          SET
            estado                = $1,
            persona_usuario_id    = COALESCE($2, persona_usuario_id),
            correo_empresarial    = $3,
            revisado_th_por       = $4,
            fecha_revision_th     = NOW(),
            observaciones_th      = $5,
            updated_at            = NOW()
          WHERE id = $6
          `,
          [ESTADOS.completado, personaUsuarioId, correoEmpresarialFinal, req.user?.id, observaciones, internalId]
        );

        const updatedSolicitud = await getByInternalId(client, internalId);
        await syncLinkedPreregistroFromSolicitud(client, updatedSolicitud, {
          actorUserId: req.user?.id || null,
          markThCompletion: true,
          markApproval: true
        });

        await client.query("COMMIT");

        const updated = await syncAnexoDesdeSolicitud(internalId, req.user?.id);
        const response = formatRow(updated) || {};
        if (usuarioCreado?.public_id && typeof response === "object") {
          response.usuario_creado = {
            id: usuarioCreado.public_id,
            nombre: usuarioCreado.nombre_usuario,
            email: usuarioCreado.email
          };
        }
        return res.json(response);
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
        if (err?.code === "23505") {
          return res.status(409).json({ error: "Conflicto de unicidad creando usuario" });
        }
        console.error(err);
        return res.status(500).json({ error: "Error procesando revision TH" });
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/contrataciones/solicitudes/:id/enviar-th",
    requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }),
    async (req, res) => {
      try {
        const row = await getByPublicId(pool, req.params.id);
        if (!row) return res.status(404).json({ error: "Solicitud no encontrada" });
        const internalId = row.id;
        if (!requireOwnerIfCoordinator(req, row)) {
          return res.status(403).json({ error: "No puedes operar solicitudes de otro coordinador" });
        }
        if (row.tipo_solicitud !== TIPO_NUEVO) {
          return res.status(422).json({ error: "Solo aplica para solicitudes tipo Nuevo" });
        }
        if (!row.requiere_confirmacion_cliente) {
          return res.status(422).json({ error: "Esta solicitud no requiere confirmacion de cliente" });
        }
        if (row.estado !== ESTADOS.pendienteConfirmacionCliente && row.estado !== ESTADOS.enProceso) {
          return res.status(422).json({ error: "La solicitud no esta en estado apto para enviar a TH" });
        }

        const solicitud = formatRow(row);
        const destinosTh = await getDestinosTalentoHumano();
        const thResult = await sendMail(getGraphContext(req), destinosTh, buildMailThNuevo(solicitud));
        const thOk = Boolean(thResult.ok);

        await pool.query(
          `
          UPDATE solicitudes_contratacion
          SET
            correo_enviado_th = $1,
            estado = $2
          WHERE id = $3
          `,
          [thOk, thOk ? ESTADOS.pendienteRevisionTh : ESTADOS.pendienteConfirmacionCliente, internalId]
        );

        const updated = await getByInternalId(pool, internalId);
        return res.json(formatRow(updated));
      } catch (err) {
        if (err?.code === "PUBLIC_ID_NOT_FOUND") {
          return res.status(404).json({ error: "Solicitud no encontrada" });
        }
        console.error(err);
        return res.status(500).json({ error: "Error enviando solicitud a Talento Humano" });
      }
    }
  );
};
