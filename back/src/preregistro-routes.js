module.exports = function registerPreregistroRoutes(deps) {
  const {
    app,
    pool,
    ID_TABLES,
    normalizeValue,
    requireAccess,
    getGraphContext,
    sendEmailSafe,
    buildEmailLayout,
    buildPortalUrl,
    ensurePersistedAnexoFromProceso,
    resolveTalentoHumanoNotificationRecipients
  } = deps;

  const ESTADOS = Object.freeze({
    pendienteCoordinador: "Pendiente Coordinador",
    pendienteComercial: "Pendiente Comercial",
    pendienteRevisionTh: "Pendiente Revision TH",
    pendienteCorreoSilver: "Pendiente Correo Silver",
    completado: "Completado",
    anulado: "Anulado"
  });

  function normalizeRequesterRole(value) {
    return normalizeValue(value);
  }

  function resolveContinuationRoleForRequester(value) {
    const role = normalizeRequesterRole(value);
    if (role === "comercial") return "Comercial";
    return "Coordinador";
  }

  function resolveInitialPreregistroStateForRequester(value) {
    return resolveContinuationRoleForRequester(value) === "Comercial"
      ? ESTADOS.pendienteComercial
      : ESTADOS.pendienteCoordinador;
  }

  function mapPreregistroEstadoToSolicitudEstado(estado) {
    const raw = String(estado || "").trim();
    if (!raw) return null;
    if (raw === ESTADOS.pendienteCoordinador) return ESTADOS.pendienteCoordinador;
    if (raw === ESTADOS.pendienteComercial) return ESTADOS.pendienteComercial;
    if (raw === ESTADOS.pendienteRevisionTh) return ESTADOS.pendienteRevisionTh;
    if (raw === ESTADOS.pendienteCorreoSilver) return ESTADOS.pendienteCorreoSilver;
    if (raw === ESTADOS.completado) return ESTADOS.completado;
    if (raw === ESTADOS.anulado) return "Cancelado";
    return null;
  }

  const TIPOS_CUENTA = new Set(["Ahorros", "Corriente"]);
  const TIPOS_PERSONA = new Set(["Natural", "Juridica", "Jurídica"]);
  const MONEDAS = new Set(["COP", "USD", "EUR"]);

  function normalizeEnumKey(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/gi, "")
      .toLowerCase()
      .trim();
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  function isValidSilverEmail(value) {
    return /^[^\s@]+@silverconsulting\.com\.co$/i.test(String(value || "").trim());
  }

  function parseTarifaInput(value, fieldName) {
    if (value === undefined || value === null || value === "") return { value: null };
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return { error: `${fieldName} debe ser un numero valido` };
    }
    if (parsed < 0) {
      return { error: `${fieldName} no puede ser negativa` };
    }
    return { value: parsed };
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(value || "").trim()
    );
  }

  async function resolveBancoInternalId(db, bancoValue) {
    if (bancoValue === undefined || bancoValue === null || bancoValue === "") return null;

    const numeric = Number(bancoValue);
    if (Number.isInteger(numeric) && numeric > 0) {
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

  function normalizeDocKey(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/gi, "")
      .toLowerCase()
      .trim();
  }

  function classifyTipoDocumento(value) {
    const key = normalizeDocKey(value);
    if (!key) return null;
    if (key === "cc" || key.includes("ciudadania") || key === "cedula" || key.includes("ceduladeciudadania")) return "cc";
    if (key === "ce" || key.includes("extranjeria") || key.includes("ceduladeextranjeria")) return "ce";
    if (key === "nit") return "nit";
    if (key === "pa" || key.includes("pasaporte")) return "pasaporte";
    return null;
  }

  async function resolveDocumentoIdentidadId(db, tipoDocumentoInput) {
    const tipo = classifyTipoDocumento(tipoDocumentoInput);
    if (!tipo) return null;

    const result = await db.query(
      `SELECT id, titulo
       FROM documento_identidad
       WHERE activo = true
       ORDER BY id ASC`
    );
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (!rows.length) return null;

    const byTypeMatchers = {
      cc: [/^cedula$/, /ceduladeciudadania/, /ciudadania/, /cedula/],
      ce: [/ceduladeextranjeria/, /extranjeria/],
      nit: [/^nit$/],
      pasaporte: [/pasaporte/]
    };

    const matchers = byTypeMatchers[tipo] || [];
    for (const row of rows) {
      const titleKey = normalizeDocKey(row.titulo);
      if (matchers.some((re) => re.test(titleKey))) {
        return row.id;
      }
    }

    return null;
  }

  function normalizeGrupoUsuarioInput(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const key = normalizeEnumKey(raw);
    if (["admin", "administrador", "administracion"].includes(key)) return "ADMIN";
    if (["coordinador", "coordinacion"].includes(key)) return "COORDINADOR";
    if (["consultor", "consultoria", "consulting", "consultant"].includes(key)) return "CONSULTOR";
    if (["contabilidad", "contable", "finanzas"].includes(key)) return "CONTABILIDAD";
    if (["comercial", "ventas"].includes(key)) return "COMERCIAL";
    if (["otro", "otros"].includes(key)) return "Otro";
    return null;
  }

  function normalizeGrupoDistribucionInput(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const key = normalizeEnumKey(raw);
    if (["todossilver", "todos", "all"].includes(key)) return "Todos Silver";
    if (["vinculado", "vinculados"].includes(key)) return "Vinculados";
    if (["responsable", "responsables"].includes(key)) return "Responsable";
    return null;
  }

  function normalizeFacturaEnColombia(value) {
    if (value === true || value === "true" || value === 1 || value === "1") return true;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
    return null;
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

  const BASE_SELECT = `
    SELECT
      p.id, p.public_id, p.id_solicitud_rrhh,
      s.public_id AS solicitud_public_id,
      s.coordinador_id AS solicitud_coordinador_id,
      s.estado AS solicitud_estado,
      p.nombre, p.apellidos, p.tipo_documento_id, di.titulo AS tipo_documento, p.numero_documento, p.telefono,
      p.correo_personal, p.pais_ubicacion, p.ciudad,
      p.fecha_fin, p.moneda, p.pais_pago, p.factura_en_colombia,
      p.tarifa_hora, p.tarifa_mes, p.tarifa_medio_tiempo, p.tarifa_capacitacion,
      p.vpn_corona, p.necesita_s_user, p.grupo_usuario, p.grupo_distribucion,
      p.observaciones, p.direccion, p.tipo_persona, p.banco_id,
      b.titulo AS banco_nombre,
      p.tipo_cuenta, p.numero_cuenta, p.correo_silver, p.estado, p.crear_usuario_sistema,
      p.creado_por, creador.public_id AS creado_por_public_id, creador.nombre_usuario AS creado_por_nombre,
      p.completado_coordinador_por, coordDone.public_id AS completado_coordinador_por_public_id, coordDone.nombre_usuario AS completado_coordinador_por_nombre,
      p.completado_th_por, thDone.public_id AS completado_th_por_public_id, thDone.nombre_usuario AS completado_th_por_nombre,
      p.aprobado_por, apr.public_id AS aprobado_por_public_id, apr.nombre_usuario AS aprobado_por_nombre,
      p.anulado_por, anu.public_id AS anulado_por_public_id, anu.nombre_usuario AS anulado_por_nombre,
      p.motivo_anulacion, p.id_usuario_creado,
      ucre.public_id AS usuario_creado_public_id, ucre.nombre_usuario AS usuario_creado_nombre, ucre.email AS usuario_creado_email,
      p.fecha_completado_coordinador, p.fecha_completado_th, p.fecha_aprobacion, p.fecha_anulacion,
      p.created_at, p.updated_at,
      s.perfil, s.nivel, s.tiempo, s.ubicacion, s.modalidad, s.fecha_inicio_esperada,
      s.tipo_proyecto, s.experiencia, s.presupuesto, s.descripcion, s.informacion_adicional,
      s.prioridad, s.observaciones_rrhh,
      c.public_id AS cliente_public_id, c.titulo AS cliente_nombre,
      m.public_id AS modulo_public_id, m.titulo AS modulo_nombre,
      su.public_id AS coordinador_public_id, su.nombre_usuario AS coordinador_nombre, su.email AS coordinador_email,
      rsol.titulo AS solicitante_rol_titulo
    FROM preregistro_personas p
    JOIN solicitudes_rrhh s ON s.id = p.id_solicitud_rrhh
    LEFT JOIN bancos b ON b.id = p.banco_id
    LEFT JOIN documento_identidad di ON di.id = p.tipo_documento_id
    LEFT JOIN clientes c ON c.id = s.cliente_id
    LEFT JOIN modulo m ON m.id = s.modulo_id
    LEFT JOIN usuarios su ON su.id = s.coordinador_id
    LEFT JOIN roles rsol ON rsol.id = su.rol_usuario_id
    LEFT JOIN usuarios creador ON creador.id = p.creado_por
    LEFT JOIN usuarios coordDone ON coordDone.id = p.completado_coordinador_por
    LEFT JOIN usuarios thDone ON thDone.id = p.completado_th_por
    LEFT JOIN usuarios apr ON apr.id = p.aprobado_por
    LEFT JOIN usuarios anu ON anu.id = p.anulado_por
    LEFT JOIN usuarios ucre ON ucre.id = p.id_usuario_creado
  `;

  function formatRow(row) {
    if (!row) return null;
    return {
      id: row.public_id,
      solicitud: {
        id: row.solicitud_public_id,
        perfil: row.perfil,
        nivel: row.nivel,
        modalidad: row.modalidad,
        estado: row.solicitud_estado,
        cliente: { id: row.cliente_public_id, nombre: row.cliente_nombre },
        modulo: { id: row.modulo_public_id, nombre: row.modulo_nombre },
        coordinador: {
          id: row.coordinador_public_id,
          nombre: row.coordinador_nombre,
          email: row.coordinador_email,
          rol: row.solicitante_rol_titulo || null
        },
        solicitante_rol: row.solicitante_rol_titulo || null,
        responsable_continuacion_rol: resolveContinuationRoleForRequester(row.solicitante_rol_titulo)
      },
      nombre: row.nombre,
      apellidos: row.apellidos,
      tipo_documento: row.tipo_documento,
      tipo_documento_id: row.tipo_documento_id || null,
      numero_documento: row.numero_documento,
      telefono: row.telefono,
      correo_personal: row.correo_personal,
      pais_ubicacion: row.pais_ubicacion,
      ciudad: row.ciudad,
      fecha_fin: row.fecha_fin,
      moneda: row.moneda,
      pais_pago: row.pais_pago,
      factura_en_colombia:
        row.factura_en_colombia === null || row.factura_en_colombia === undefined
          ? null
          : Boolean(row.factura_en_colombia),
      tarifa_hora: row.tarifa_hora,
      tarifa_mes: row.tarifa_mes,
      tarifa_medio_tiempo: row.tarifa_medio_tiempo,
      tarifa_capacitacion: row.tarifa_capacitacion,
      vpn_corona: row.vpn_corona,
      necesita_s_user: row.necesita_s_user,
      grupo_usuario: row.grupo_usuario,
      grupo_distribucion: row.grupo_distribucion,
      observaciones: row.observaciones,
      direccion: row.direccion,
      tipo_persona: row.tipo_persona,
      banco: row.banco_id ? { id: row.banco_id, nombre: row.banco_nombre } : null,
      tipo_cuenta: row.tipo_cuenta,
      numero_cuenta: row.numero_cuenta,
      correo_silver: row.correo_silver,
      estado: row.estado,
      creado_por: row.creado_por_public_id,
      creado_por_nombre: row.creado_por_nombre || null,
      completado_coordinador_por: row.completado_coordinador_por_public_id,
      completado_coordinador_por_nombre: row.completado_coordinador_por_nombre || null,
      completado_th_por: row.completado_th_por_public_id,
      completado_th_por_nombre: row.completado_th_por_nombre || null,
      aprobado_por: row.aprobado_por_public_id,
      aprobado_por_nombre: row.aprobado_por_nombre || null,
      anulado_por: row.anulado_por_public_id,
      anulado_por_nombre: row.anulado_por_nombre || null,
      motivo_anulacion: row.motivo_anulacion,
      id_usuario_creado: row.usuario_creado_public_id,
      usuario_creado: row.usuario_creado_public_id ? { id: row.usuario_creado_public_id, nombre: row.usuario_creado_nombre, email: row.usuario_creado_email } : null,
      fecha_completado_coordinador: row.fecha_completado_coordinador,
      fecha_completado_th: row.fecha_completado_th,
      fecha_aprobacion: row.fecha_aprobacion,
      fecha_anulacion: row.fecha_anulacion,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  async function getByInternalId(db, id) {
    const r = await db.query(`${BASE_SELECT} WHERE p.id = $1 LIMIT 1`, [id]);
    return r.rows[0] || null;
  }

  async function getByPublicId(db, publicId) {
    const r = await db.query(`${BASE_SELECT} WHERE p.public_id = $1 LIMIT 1`, [publicId]);
    return r.rows[0] || null;
  }

  async function findLinkedSolicitudContratacion(db, preregistroRow) {
    if (!preregistroRow?.id) return null;
    const preregistroPublicId = String(preregistroRow.public_id || "").trim();
    const r = await db.query(
      `
      SELECT id, datos_extra
      FROM solicitudes_contratacion
      WHERE preregistro_id = $1
         OR COALESCE(datos_extra->>'preregistro_id', '') = $2
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 1
      `,
      [preregistroRow.id, preregistroPublicId]
    );
    return r.rows[0] || null;
  }

  async function syncSolicitudContratacionFromPreregistro(db, preregistroRow, { estado = null, personaUsuarioId = null } = {}) {
    const linked = await findLinkedSolicitudContratacion(db, preregistroRow);
    if (!linked?.id) return null;

    const existingDatosExtra =
      linked.datos_extra && typeof linked.datos_extra === "object" && !Array.isArray(linked.datos_extra)
        ? linked.datos_extra
        : {};

    const mergedDatosExtra = {
      ...existingDatosExtra,
      preregistro_id: String(preregistroRow.public_id || existingDatosExtra.preregistro_id || ""),
      direccion: preregistroRow.direccion || existingDatosExtra.direccion || null,
      tipo_persona: preregistroRow.tipo_persona || existingDatosExtra.tipo_persona || null,
      banco_id: preregistroRow.banco_id || existingDatosExtra.banco_id || null,
      tipo_cuenta: preregistroRow.tipo_cuenta || existingDatosExtra.tipo_cuenta || null,
      numero_cuenta: preregistroRow.numero_cuenta || existingDatosExtra.numero_cuenta || null,
      vpn_corona: preregistroRow.vpn_corona === null || preregistroRow.vpn_corona === undefined
        ? (existingDatosExtra.vpn_corona ?? null)
        : Boolean(preregistroRow.vpn_corona),
      necesita_s_user: preregistroRow.necesita_s_user === null || preregistroRow.necesita_s_user === undefined
        ? (existingDatosExtra.necesita_s_user ?? null)
        : Boolean(preregistroRow.necesita_s_user),
      grupo_usuario: preregistroRow.grupo_usuario || existingDatosExtra.grupo_usuario || null,
      grupo_distribucion: preregistroRow.grupo_distribucion || existingDatosExtra.grupo_distribucion || null,
      pais_pago: preregistroRow.pais_pago || existingDatosExtra.pais_pago || null,
      factura_en_colombia:
        preregistroRow.factura_en_colombia === null || preregistroRow.factura_en_colombia === undefined
          ? (existingDatosExtra.factura_en_colombia ?? null)
          : Boolean(preregistroRow.factura_en_colombia)
    };
    const nextEstado = estado || mapPreregistroEstadoToSolicitudEstado(preregistroRow.estado);

    await db.query(
      `
      UPDATE solicitudes_contratacion
      SET
        preregistro_id = $1,
        origen_flujo = 'rrhh',
        tipo_documento_id = COALESCE($2, tipo_documento_id),
        nombre = $3,
        apellidos = $4,
        numero_documento = $5,
        correo_personal = $6,
        correo_empresarial = COALESCE($7, correo_empresarial),
        telefono = $8,
        ubicacion = COALESCE($9, ubicacion),
        moneda = COALESCE($10::tipo_moneda, moneda),
        tarifa_hora = $11,
        tarifa_mes = $12,
        tarifa_medio_tiempo = $13,
        tarifa_capacitacion = $14,
        fecha_fin = COALESCE($15, fecha_fin),
        datos_extra = COALESCE(datos_extra, '{}'::jsonb) || $16::jsonb,
        persona_usuario_id = COALESCE($17, persona_usuario_id),
        estado = COALESCE($18, estado),
        updated_at = NOW()
      WHERE id = $19
      `,
      [
        preregistroRow.id,
        preregistroRow.tipo_documento_id || null,
        preregistroRow.nombre || "",
        preregistroRow.apellidos || "",
        preregistroRow.numero_documento || null,
        preregistroRow.correo_personal || null,
        preregistroRow.correo_silver || null,
        preregistroRow.telefono || null,
        preregistroRow.ciudad || preregistroRow.pais_ubicacion || null,
        preregistroRow.moneda || null,
        preregistroRow.tarifa_hora,
        preregistroRow.tarifa_mes,
        preregistroRow.tarifa_medio_tiempo,
        preregistroRow.tarifa_capacitacion,
        preregistroRow.fecha_fin || null,
        JSON.stringify(mergedDatosExtra),
        personaUsuarioId || preregistroRow.id_usuario_creado || null,
        nextEstado || null,
        linked.id
      ]
    );

    return linked.id;
  }

  async function syncSolicitudYAnexoDesdePreregistro(db, preregistroRow, userId, { estado = null, personaUsuarioId = null } = {}) {
    const solicitudId = await syncSolicitudContratacionFromPreregistro(db, preregistroRow, {
      estado,
      personaUsuarioId
    });

    try {
      await ensurePersistedAnexoFromProceso({
        solicitudId: solicitudId || null,
        preregistroId: preregistroRow.id,
        createdBy: userId || null,
        strict: false
      });
    } catch (err) {
      console.warn("No se pudo sincronizar anexo tecnico desde preregistro:", err?.message || err);
    }

    return solicitudId;
  }

  app.post("/api/solicitudes-rrhh/:public_id/contratar", requireAccess({ roles: ["Reclutador", "Administrador"] }), async (req, res) => {
    const { nombre, apellidos, tipo_documento, numero_documento, telefono, correo_personal, pais_ubicacion, ciudad,
            moneda, tarifa_mes, tarifa_hora } = req.body || {};
    const docType = String(tipo_documento || "").trim();
    const monedaNorm = String(moneda || "").trim().toUpperCase();
    const facturaEnColombia = normalizeFacturaEnColombia(req.body?.factura_en_colombia);

    if (!nombre || !apellidos || !docType || !numero_documento || !correo_personal) {
      return res.status(400).json({ error: "Faltan campos obligatorios de la seccion 1" });
    }
    if (facturaEnColombia === null) {
      return res.status(400).json({ error: "factura_en_colombia es obligatorio" });
    }
    if (!monedaNorm || !MONEDAS.has(monedaNorm)) {
      return res.status(400).json({ error: "moneda es obligatoria y debe ser COP, USD o EUR" });
    }
    const tarifaMesParsed = parseTarifaInput(tarifa_mes, "tarifa_mes");
    if (tarifaMesParsed.error) {
      return res.status(400).json({ error: tarifaMesParsed.error });
    }
    const tarifaHoraParsed = parseTarifaInput(tarifa_hora, "tarifa_hora");
    if (tarifaHoraParsed.error) {
      return res.status(400).json({ error: tarifaHoraParsed.error });
    }
    if (tarifaMesParsed.value === null && tarifaHoraParsed.value === null) {
      return res.status(400).json({ error: "Se requiere tarifa mensual o tarifa por hora" });
    }
    if (!isValidEmail(correo_personal)) {
      return res.status(400).json({ error: "correo_personal no tiene formato valido" });
    }

    // Validar que correo_personal no este registrado para otra persona (diferente documento)
    const dupCheckRrhh = await pool.query(
      `SELECT 1 FROM preregistro_personas
       WHERE LOWER(correo_personal) = LOWER($1)
         AND COALESCE(numero_documento,'') <> $2
       LIMIT 1`,
      [correo_personal, String(numero_documento || "").trim()]
    );
    if (dupCheckRrhh.rows.length) {
      return res.status(422).json({
        error: "El correo personal ya está registrado para otra persona en el sistema. Cada persona debe tener un correo personal único."
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const solicitudRes = await client.query(
        `SELECT s.id, s.estado, su.email AS coordinador_email, su.nombre_usuario AS coordinador_nombre, rsol.titulo AS solicitante_rol_titulo, s.perfil
              , s.public_id AS solicitud_public_id, s.coordinador_id, s.cliente_id, s.modulo_id
              , c.public_id AS cliente_public_id, m.public_id AS modulo_public_id
              , s.modalidad, s.ubicacion, s.fecha_inicio_esperada, s.descripcion, s.informacion_adicional, s.observaciones_rrhh
              , c.titulo AS cliente_nombre, m.titulo AS modulo_nombre
         FROM solicitudes_rrhh s
         LEFT JOIN clientes c ON c.id = s.cliente_id
         LEFT JOIN modulo m ON m.id = s.modulo_id
         LEFT JOIN usuarios su ON su.id = s.coordinador_id
         LEFT JOIN roles rsol ON rsol.id = su.rol_usuario_id
         WHERE s.public_id = $1 FOR UPDATE OF s`,
        [req.params.public_id]
      );
      const solicitud = solicitudRes.rows[0];
      if (!solicitud) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Solicitud no encontrada" });
      }
      const continuationRole = resolveContinuationRoleForRequester(solicitud.solicitante_rol_titulo);
      const initialPreregistroState = resolveInitialPreregistroStateForRequester(solicitud.solicitante_rol_titulo);
      const solicitudId = solicitud.id;
      if (!["Entrevistas", "Entrevista", "Reclutamiento"].includes(String(solicitud.estado || ""))) {
        await client.query("ROLLBACK");
        return res.status(422).json({ error: "La solicitud debe estar en Entrevistas o Reclutamiento para contratar" });
      }

      const dup = await client.query(`SELECT id FROM preregistro_personas WHERE id_solicitud_rrhh = $1 AND estado <> 'Anulado' LIMIT 1`, [solicitudId]);
      if (dup.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Ya existe un preregistro activo para esta solicitud" });
      }

      const tipoDocumentoId = await resolveDocumentoIdentidadId(client, docType);
      if (!tipoDocumentoId) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "tipo_documento no encontrado en documento_identidad" });
      }

      await client.query(`UPDATE solicitudes_rrhh SET estado = 'Contratado' WHERE id = $1`, [solicitudId]);
      const created = await client.query(
        `INSERT INTO preregistro_personas
          (id_solicitud_rrhh, nombre, apellidos, tipo_documento_id, numero_documento, telefono, correo_personal, pais_ubicacion, ciudad, moneda, factura_en_colombia, tarifa_mes, tarifa_hora, estado, creado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id, public_id, estado`,
        [
          solicitudId,
          String(nombre).trim(),
          String(apellidos).trim(),
          tipoDocumentoId,
          String(numero_documento).trim(),
          telefono || null,
          String(correo_personal).trim().toLowerCase(),
          pais_ubicacion || null,
          ciudad || null,
          monedaNorm,
          facturaEnColombia,
          tarifaMesParsed.value,
          tarifaHoraParsed.value,
          initialPreregistroState,
          req.user?.id
        ]
      );

      // Si existe el modulo de contrataciones, crear un borrador para continuar el flujo desde Coordinacion.
      // No envia correos todavia: el coordinador completa datos faltantes y luego dispara el proceso.
      const hasContratacionesTable = await client.query(`SELECT to_regclass('public.solicitudes_contratacion') AS reg`);
      if (hasContratacionesTable.rows[0]?.reg) {
        await client.query("SAVEPOINT sv_preregistro_contratacion");
        try {
          const existingContratacion = await client.query(
            `
            SELECT id
            FROM solicitudes_contratacion
            WHERE tipo_solicitud = 'Nuevo'
              AND COALESCE(datos_extra->>'origen', '') = 'rrhh'
              AND COALESCE(datos_extra->>'rrhh_solicitud_id', '') = $1
            LIMIT 1
            `,
            [String(solicitud.solicitud_public_id || "")]
          );

          if (!existingContratacion.rows.length) {
            const clienteMeta = await client.query(
              `
              SELECT COALESCE(requiere_confirmacion_cliente, false) AS requiere_confirmacion_cliente
              FROM clientes
              WHERE id = $1
              LIMIT 1
              `,
              [solicitud.cliente_id]
            );
            const requiereConfirmacionCliente = Boolean(clienteMeta.rows[0]?.requiere_confirmacion_cliente);

            const necesidadTiResumen = [solicitud.descripcion, solicitud.informacion_adicional]
              .map((v) => String(v || "").trim())
              .filter(Boolean)
              .join(" | ");

            const datosExtra = {
              origen: "rrhh",
              rrhh_solicitud_id: String(solicitud.solicitud_public_id || ""),
              preregistro_id: String(created.rows[0]?.public_id || ""),
              modulo_id: solicitud.modulo_public_id || null,
              modulo_nombre: solicitud.modulo_nombre || null,
              cliente_id: solicitud.cliente_public_id || null,
              cliente_nombre: solicitud.cliente_nombre || null
            };

            await client.query(
              `
              INSERT INTO solicitudes_contratacion (
                tipo_solicitud,
                estado,
                coordinador_solicitante_id,
                preregistro_id,
                cliente_id,
                tipo_documento_id,
                origen_flujo,
                nombre,
                apellidos,
                numero_documento,
                perfil,
                correo_personal,
                telefono,
                ubicacion,
                modalidad_contrato,
                moneda,
                tarifa_hora,
                tarifa_mes,
                fecha_inicio,
                necesidad_ti,
                observaciones,
                datos_extra,
                requiere_confirmacion_cliente,
                correo_enviado_mesa,
                correo_enviado_th,
                correo_confirmacion_coordinador
              )
              VALUES (
                'Nuevo',
                $22,
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                $14,
                $15,
                $16,
                $17,
                $18,
                $19,
                $20::jsonb,
                $21,
                false,
                false,
                false
              )
              `,
              [
                solicitud.coordinador_id,
                created.rows[0]?.id || null,
                solicitud.cliente_id,
                tipoDocumentoId,
                "rrhh",
                String(nombre).trim(),
                String(apellidos).trim(),
                String(numero_documento).trim(),
                solicitud.perfil || null,
                String(correo_personal).trim().toLowerCase(),
                telefono || null,
                solicitud.ubicacion || pais_ubicacion || null,
                solicitud.modalidad || null,
                monedaNorm,
                tarifaHoraParsed.value,
                tarifaMesParsed.value,
                solicitud.fecha_inicio_esperada || null,
                necesidadTiResumen || null,
                solicitud.observaciones_rrhh || null,
                JSON.stringify(datosExtra),
                requiereConfirmacionCliente,
                initialPreregistroState
              ]
            );
          }
          await client.query("RELEASE SAVEPOINT sv_preregistro_contratacion");
        } catch (draftErr) {
          await client.query("ROLLBACK TO SAVEPOINT sv_preregistro_contratacion");
          console.error("No fue posible crear borrador en contrataciones (se continua con preregistro):", draftErr?.message || draftErr);
        }
      }
      await client.query("COMMIT");

      try {
        const createdPreregistro = await getByInternalId(pool, created.rows[0]?.id);
        if (createdPreregistro) {
          await syncSolicitudYAnexoDesdePreregistro(pool, createdPreregistro, req.user?.id);
        }
      } catch (syncErr) {
        console.warn("No se pudo sincronizar anexo tecnico tras crear preregistro RRHH:", syncErr?.message || syncErr);
      }

      if (solicitud.coordinador_email) {
        const base = {
          toName: solicitud.coordinador_nombre || "Coordinador",
          nombre: `${String(nombre || "").trim()} ${String(apellidos || "").trim()}`.trim() || "N/A",
          perfil: solicitud.perfil || "Perfil",
          preregistroId: String(created.rows[0]?.public_id || ""),
          url: buildPortalUrl("preregistrosCoord"),
          senderName: req.user?.nombre_usuario || req.user?.email || "Silver Consulting"
        };
        base.closing = `Atentamente, ${base.senderName}.`;
        sendEmailSafe({
          ...getGraphContext(req),
          to: solicitud.coordinador_email,
          subject: `Nuevo preregistro pendiente - ${base.perfil}`,
          text:
            `Hola ${base.toName},\n\n` +
            `Se creo un preregistro para ${base.nombre}, perfil ${base.perfil}. ID: ${base.preregistroId}\n\n` +
            `Ver preregistro en el sistema: ${base.url}\n\n` +
            `${base.closing}\n`,
          html: buildEmailLayout({
            title: "Preregistro pendiente por completar",
            intro: `Hola <strong>${base.toName}</strong>, se creo un preregistro pendiente por completar.`,
            blocks: [
              { label: "Nombre", value: base.nombre },
              { label: "Perfil", value: base.perfil },
              { label: "Responsable", value: continuationRole },
              { label: "Estado", value: initialPreregistroState },
              { label: "ID preregistro", value: base.preregistroId }
            ],
            ctaLabel: "Ver preregistro en el sistema",
            ctaUrl: base.url,
            closing: base.closing
          })
        }).catch((err) => console.error("Error notificando preregistro al coordinador:", err?.message || err));
      }

      return res.status(201).json({ preregistro_id: created.rows[0]?.public_id, estado_preregistro: created.rows[0]?.estado, estado_solicitud: "Contratado" });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Solicitud no encontrada" });
      if (err?.code === "23505") return res.status(400).json({ message: "El correo personal ya está registrado en nuestra BD" });
      console.error(err);
      return res.status(500).json({ error: "Error creando preregistro" });
    } finally {
      client.release();
    }
  });

  app.patch("/api/preregistros/:public_id/seccion-1", requireAccess({ roles: ["Reclutador"] }), async (req, res) => {
    const editable = [
      "nombre",
      "apellidos",
      "tipo_documento",
      "numero_documento",
      "telefono",
      "correo_personal",
      "pais_ubicacion",
      "ciudad",
      "moneda",
      "factura_en_colombia",
      "tarifa_mes",
      "tarifa_hora"
    ];
    const client = await pool.connect();
    try {
      const current = await getByPublicId(client, req.params.public_id);
      if (!current) return res.status(404).json({ error: "Preregistro no encontrado" });
      const id = current.id;
      if (current.estado !== ESTADOS.pendienteCoordinador) {
        return res.status(422).json({ error: "No se puede editar seccion 1 en el estado actual" });
      }

      let nextMoneda = current.moneda;
      let nextTarifaMes = current.tarifa_mes;
      let nextTarifaHora = current.tarifa_hora;

      if (req.body?.moneda !== undefined) {
        const monedaNorm = String(req.body.moneda || "").trim().toUpperCase();
        if (!monedaNorm || !MONEDAS.has(monedaNorm)) {
          return res.status(400).json({ error: "moneda es obligatoria y debe ser COP, USD o EUR" });
        }
        nextMoneda = monedaNorm;
      }

      if (req.body?.tarifa_mes !== undefined) {
        const parsed = parseTarifaInput(req.body.tarifa_mes, "tarifa_mes");
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        nextTarifaMes = parsed.value;
      }

      if (req.body?.tarifa_hora !== undefined) {
        const parsed = parseTarifaInput(req.body.tarifa_hora, "tarifa_hora");
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        nextTarifaHora = parsed.value;
      }

      let nextFacturaEnColombia = current.factura_en_colombia;
      if (req.body?.factura_en_colombia !== undefined) {
        nextFacturaEnColombia = normalizeFacturaEnColombia(req.body.factura_en_colombia);
        if (nextFacturaEnColombia === null) {
          return res.status(400).json({ error: "factura_en_colombia debe ser booleano" });
        }
      }

      if (req.body?.tarifa_mes !== undefined || req.body?.tarifa_hora !== undefined) {
        if (nextTarifaMes === null && nextTarifaHora === null) {
          return res.status(400).json({ error: "Se requiere tarifa mensual o tarifa por hora" });
        }
      }

      const sets = [];
      const vals = [];
      let idx = 1;
      for (const field of editable) {
        if (req.body?.[field] === undefined) continue;
        if (field === "correo_personal" && !isValidEmail(req.body[field])) {
          return res.status(400).json({ error: "correo_personal no tiene formato valido" });
        }
        if (field === "tipo_documento") {
          const tipoDocumentoId = await resolveDocumentoIdentidadId(client, req.body[field]);
          if (!tipoDocumentoId) {
            return res.status(400).json({ error: "tipo_documento no encontrado en documento_identidad" });
          }
          sets.push(`tipo_documento_id = $${idx++}`);
          vals.push(tipoDocumentoId);
          continue;
        }
        if (field === "moneda") {
          sets.push(`moneda = $${idx++}`);
          vals.push(nextMoneda);
          continue;
        }
        if (field === "factura_en_colombia") {
          sets.push(`factura_en_colombia = $${idx++}`);
          vals.push(nextFacturaEnColombia);
          continue;
        }
        if (field === "tarifa_mes") {
          sets.push(`tarifa_mes = $${idx++}`);
          vals.push(nextTarifaMes);
          continue;
        }
        if (field === "tarifa_hora") {
          sets.push(`tarifa_hora = $${idx++}`);
          vals.push(nextTarifaHora);
          continue;
        }
        sets.push(`${field} = $${idx++}`);
        vals.push(field === "correo_personal" ? String(req.body[field]).trim().toLowerCase() : req.body[field]);
      }
      if (!sets.length) return res.status(400).json({ error: "No hay campos para actualizar" });
      vals.push(id);
      await client.query(`UPDATE preregistro_personas SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
      const updated = await getByInternalId(client, id);
      await syncSolicitudYAnexoDesdePreregistro(client, updated, req.user?.id);
      return res.json(formatRow(updated));
    } catch (err) {
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Preregistro no encontrado" });
      console.error(err);
      return res.status(500).json({ error: "Error actualizando seccion 1" });
    } finally {
      client.release();
    }
  });

  app.patch("/api/preregistros/:public_id/seccion-2", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }), async (req, res) => {
    const {
      fecha_fin, moneda, pais_pago,
      tarifa_hora, tarifa_mes, tarifa_medio_tiempo, tarifa_capacitacion,
      vpn_corona, necesita_s_user, grupo_usuario, grupo_distribucion, observaciones
    } = req.body || {};

    if (!moneda || typeof vpn_corona !== "boolean" || typeof necesita_s_user !== "boolean") {
      return res.status(400).json({ error: "Faltan campos obligatorios de la seccion 2" });
    }
    if (!MONEDAS.has(String(moneda || "").trim())) {
      return res.status(400).json({ error: "moneda no valida" });
    }
    const tarifaHoraParsed = parseTarifaInput(tarifa_hora, "tarifa_hora");
    if (tarifaHoraParsed.error) return res.status(400).json({ error: tarifaHoraParsed.error });
    const tarifaMesParsed = parseTarifaInput(tarifa_mes, "tarifa_mes");
    if (tarifaMesParsed.error) return res.status(400).json({ error: tarifaMesParsed.error });
    const tarifaMedioParsed = parseTarifaInput(tarifa_medio_tiempo, "tarifa_medio_tiempo");
    if (tarifaMedioParsed.error) return res.status(400).json({ error: tarifaMedioParsed.error });
    const tarifaCapParsed = parseTarifaInput(tarifa_capacitacion, "tarifa_capacitacion");
    if (tarifaCapParsed.error) return res.status(400).json({ error: tarifaCapParsed.error });
    if (
      tarifaHoraParsed.value === null &&
      tarifaMesParsed.value === null &&
      tarifaMedioParsed.value === null &&
      tarifaCapParsed.value === null
    ) {
      return res.status(400).json({ error: "Se requiere al menos una tarifa" });
    }

    const client = await pool.connect();
    try {
      const current = await getByPublicId(client, req.params.public_id);
      if (!current) return res.status(404).json({ error: "Preregistro no encontrado" });
      const id = current.id;
      const estadosPermitidosSeccion2 = [ESTADOS.pendienteCoordinador, ESTADOS.pendienteComercial];
      if (!estadosPermitidosSeccion2.includes(current.estado)) {
        return res.status(422).json({ error: "La seccion 2 solo puede completarse en Pendiente Coordinador o Pendiente Comercial" });
      }
      const isAdmin = normalizeValue(req.user?.rol) === "administrador";
      if (!isAdmin && String(current.solicitud_coordinador_id) !== String(req.user?.id || "")) {
        return res.status(403).json({ error: "No eres el coordinador dueno de esta solicitud" });
      }
      const grupoUsuarioNorm = normalizeGrupoUsuarioInput(grupo_usuario);
      const grupoDistribucionNorm = normalizeGrupoDistribucionInput(grupo_distribucion);

      await client.query(
        `UPDATE preregistro_personas
         SET fecha_fin = $1,
             moneda = $2,
             pais_pago = $3,
             tarifa_hora = $4,
             tarifa_mes = $5,
             tarifa_medio_tiempo = $6,
             tarifa_capacitacion = $7,
             vpn_corona = $8,
             necesita_s_user = $9,
             grupo_usuario = $10,
             grupo_distribucion = $11,
             observaciones = $12,
             estado = $13,
             completado_coordinador_por = $14,
             fecha_completado_coordinador = NOW()
         WHERE id = $15`,
        [
          fecha_fin || null, String(moneda).trim(), pais_pago || null,
          tarifaHoraParsed.value,
          tarifaMesParsed.value,
          tarifaMedioParsed.value,
          tarifaCapParsed.value,
          vpn_corona, necesita_s_user, grupoUsuarioNorm, grupoDistribucionNorm, observaciones || null,
          ESTADOS.pendienteRevisionTh, req.user?.id, id
        ]
      );

      const updated = await getByInternalId(client, id);
      await syncSolicitudYAnexoDesdePreregistro(client, updated, req.user?.id);
      const thDest = typeof resolveTalentoHumanoNotificationRecipients === "function"
        ? await resolveTalentoHumanoNotificationRecipients()
        : [];
      const tiDest = String(process.env.EMAIL_TO_TI || "").split(",").map((s) => s.trim()).filter(Boolean);

      const tasks = [];
      if (thDest.length) {
        tasks.push(sendEmailSafe({
          ...getGraphContext(req),
          to: thDest,
          subject: `Preregistro listo para revision TH - ${updated?.nombre || ""} ${updated?.apellidos || ""}`.trim(),
          text: `Se completo la seccion 2. ID preregistro: ${updated?.public_id}`
        }));
      }
      if (tiDest.length) {
        const requiereTi = Boolean(updated?.vpn_corona) || Boolean(updated?.necesita_s_user);
        tasks.push(sendEmailSafe({
          ...getGraphContext(req),
          to: tiDest,
          subject: `Solicitud TI onboarding - ${updated?.nombre || ""} ${updated?.apellidos || ""}`.trim(),
          text:
            `Nombre: ${updated?.nombre || ""} ${updated?.apellidos || ""}\n` +
            `Correo personal: ${updated?.correo_personal || ""}\n` +
            `VPN Corona: ${updated?.vpn_corona ? "Si" : "No"}\n` +
            `S-User: ${updated?.necesita_s_user ? "Si" : "No"}\n` +
            `${requiereTi ? "Accion: crear accesos tecnicos y correo Silver." : "Accion: crear correo Silver."}`
        }));
      }
      Promise.all(tasks).catch((e) => console.error("Error enviando correos de seccion 2:", e?.message || e));

      return res.json(formatRow(updated));
    } catch (err) {
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Preregistro no encontrado" });
      console.error(err);
      return res.status(500).json({ error: "Error actualizando seccion 2" });
    } finally {
      client.release();
    }
  });

  app.patch("/api/preregistros/:public_id/seccion-2/editar", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial"] }), async (req, res) => {
    const editable = [
      "fecha_fin", "moneda", "pais_pago", "tarifa_hora", "tarifa_mes",
      "tarifa_medio_tiempo", "tarifa_capacitacion", "vpn_corona", "necesita_s_user", "grupo_usuario",
      "grupo_distribucion", "observaciones"
    ];

    const client = await pool.connect();
    try {
      const current = await getByPublicId(client, req.params.public_id);
      if (!current) return res.status(404).json({ error: "Preregistro no encontrado" });
      const id = current.id;
      if (current.estado !== ESTADOS.pendienteRevisionTh) {
        return res.status(422).json({ error: "Solo se puede editar seccion 2 en Pendiente Revision TH" });
      }
      const isAdmin = normalizeValue(req.user?.rol) === "administrador";
      if (!isAdmin && String(current.solicitud_coordinador_id) !== String(req.user?.id || "")) {
        return res.status(403).json({ error: "No eres el coordinador dueno de esta solicitud" });
      }

      const sets = [];
      const vals = [];
      let idx = 1;
      for (const field of editable) {
        if (req.body?.[field] === undefined) continue;
        if (field === "moneda" && !MONEDAS.has(String(req.body[field] || "").trim())) {
          return res.status(400).json({ error: "moneda no valida" });
        }
        if (field.startsWith("tarifa_")) {
          const parsed = parseTarifaInput(req.body[field], field);
          if (parsed.error) {
            return res.status(400).json({ error: parsed.error });
          }
          sets.push(`${field} = $${idx++}`);
          vals.push(parsed.value);
          continue;
        }
        if (field === "grupo_usuario") {
          sets.push(`${field} = $${idx++}`);
          vals.push(normalizeGrupoUsuarioInput(req.body[field]));
          continue;
        }
        if (field === "grupo_distribucion") {
          sets.push(`${field} = $${idx++}`);
          vals.push(normalizeGrupoDistribucionInput(req.body[field]));
          continue;
        }
        sets.push(`${field} = $${idx++}`);
        vals.push(req.body[field]);
      }
      if (!sets.length) return res.status(400).json({ error: "No hay campos para actualizar" });
      vals.push(id);
      await client.query(`UPDATE preregistro_personas SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
      const updated = await getByInternalId(client, id);
      await syncSolicitudYAnexoDesdePreregistro(client, updated, req.user?.id);
      return res.json(formatRow(updated));
    } catch (err) {
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Preregistro no encontrado" });
      console.error(err);
      return res.status(500).json({ error: "Error editando seccion 2" });
    } finally {
      client.release();
    }
  });

  app.patch("/api/preregistros/:public_id/seccion-3", requireAccess({ roles: ["Talento Humano"] }), async (req, res) => {
    const {
      direccion, tipo_persona, banco_id, tipo_cuenta, numero_cuenta, correo_silver,
      razon_social, nit_empresa, representante_legal,
      tipo_documento_representante, numero_documento_representante
    } = req.body || {};
    if (!direccion || !tipo_persona || !banco_id || !tipo_cuenta || !numero_cuenta) {
      return res.status(400).json({ error: "Faltan campos obligatorios de la seccion 3" });
    }
    if (!TIPOS_PERSONA.has(String(tipo_persona || "").trim())) {
      return res.status(400).json({ error: "tipo_persona no valido" });
    }
    if (!TIPOS_CUENTA.has(String(tipo_cuenta || "").trim())) {
      return res.status(400).json({ error: "tipo_cuenta no valido" });
    }
    if (correo_silver && !isValidSilverEmail(correo_silver)) {
      return res.status(400).json({ error: "correo_silver debe pertenecer al dominio @silverconsulting.com.co" });
    }

    const client = await pool.connect();
    try {
      const current = await getByPublicId(client, req.params.public_id);
      if (!current) return res.status(404).json({ error: "Preregistro no encontrado" });
      const id = current.id;
      if (![ESTADOS.pendienteRevisionTh, ESTADOS.pendienteCorreoSilver].includes(current.estado)) {
        return res.status(422).json({ error: "No se puede completar seccion 3 en el estado actual" });
      }

      const bancoId = await resolveBancoInternalId(client, banco_id);
      if (!bancoId) return res.status(400).json({ error: "Banco no encontrado" });
      const correoSilverNorm = correo_silver ? String(correo_silver).trim().toLowerCase() : null;
      if (correoSilverNorm) {
        const [dupUser, dupPre] = await Promise.all([
          client.query(`SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1`, [correoSilverNorm]),
          client.query(`SELECT id FROM preregistro_personas WHERE LOWER(correo_silver) = LOWER($1) AND id <> $2 AND estado <> 'Anulado' LIMIT 1`, [correoSilverNorm, id])
        ]);
        if (dupUser.rows.length || dupPre.rows.length) {
          return res.status(409).json({ error: "correo_silver ya esta en uso" });
        }
      }

      const nextState = correoSilverNorm ? ESTADOS.pendienteRevisionTh : ESTADOS.pendienteCorreoSilver;
      const tipoPersonaNorm = normalizeTipoPersonaForPreregistro(tipo_persona);
      await client.query(
        `UPDATE preregistro_personas
         SET direccion = $1, tipo_persona = $2, banco_id = $3, tipo_cuenta = $4, numero_cuenta = $5,
             correo_silver = COALESCE($6, correo_silver), estado = $7,
             completado_th_por = $8, fecha_completado_th = NOW(),
             razon_social = $10, nit_empresa = $11, representante_legal = $12,
             tipo_documento_representante = $13, numero_documento_representante = $14
         WHERE id = $9`,
        [
          direccion, tipoPersonaNorm, bancoId, String(tipo_cuenta).trim(), String(numero_cuenta).trim(),
          correoSilverNorm, nextState, req.user?.id, id,
          razon_social ? String(razon_social).trim() : null,
          nit_empresa ? String(nit_empresa).trim() : null,
          representante_legal ? String(representante_legal).trim() : null,
          tipo_documento_representante ? String(tipo_documento_representante).trim() : null,
          numero_documento_representante ? String(numero_documento_representante).trim() : null
        ]
      );

      const updated = await getByInternalId(client, id);
      await syncSolicitudYAnexoDesdePreregistro(client, updated, req.user?.id);
      return res.json(formatRow(updated));
    } catch (err) {
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(400).json({ error: "Preregistro o banco no encontrado" });
      console.error(err);
      return res.status(500).json({ error: "Error completando seccion 3" });
    } finally {
      client.release();
    }
  });

  app.patch("/api/preregistros/:public_id/correo-silver", requireAccess({ roles: ["Talento Humano"] }), async (req, res) => {
    const correoSilver = String(req.body?.correo_silver || "").trim().toLowerCase();
    if (!correoSilver || !isValidSilverEmail(correoSilver)) {
      return res.status(400).json({ error: "correo_silver es obligatorio y debe pertenecer al dominio @silverconsulting.com.co" });
    }

    const client = await pool.connect();
    try {
      const current = await getByPublicId(client, req.params.public_id);
      if (!current) return res.status(404).json({ error: "Preregistro no encontrado" });
      const id = current.id;
      if (current.estado !== ESTADOS.pendienteCorreoSilver) {
        return res.status(422).json({ error: "Solo se puede ingresar correo silver en Pendiente Correo Silver" });
      }

      const [dupUser, dupPre] = await Promise.all([
        client.query(`SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1`, [correoSilver]),
        client.query(`SELECT id FROM preregistro_personas WHERE LOWER(correo_silver) = LOWER($1) AND id <> $2 AND estado <> 'Anulado' LIMIT 1`, [correoSilver, id])
      ]);
      if (dupUser.rows.length || dupPre.rows.length) {
        return res.status(409).json({ error: "correo_silver ya esta en uso" });
      }

      await client.query(`UPDATE preregistro_personas SET correo_silver = $1 WHERE id = $2`, [correoSilver, id]);
      const updated = await getByInternalId(client, id);
      await syncSolicitudYAnexoDesdePreregistro(client, updated, req.user?.id);
      return res.json(formatRow(updated));
    } catch (err) {
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Preregistro no encontrado" });
      console.error(err);
      return res.status(500).json({ error: "Error actualizando correo_silver" });
    } finally {
      client.release();
    }
  });

  app.post("/api/preregistros/:public_id/aprobar", requireAccess({ roles: ["Talento Humano"] }), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const current = await getByPublicId(client, req.params.public_id);
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Preregistro no encontrado" });
      }
      const id = current.id;
      if (![ESTADOS.pendienteRevisionTh, ESTADOS.pendienteCorreoSilver].includes(current.estado)) {
        await client.query("ROLLBACK");
        return res.status(422).json({ error: "El preregistro no esta en un estado aprobable" });
      }

      const debeCrearUsuario = current.crear_usuario_sistema !== false;
      let correoSilver = null;
      let rolId = null;
      let tipoCuentaRes = null;

      if (debeCrearUsuario) {
        correoSilver = String(current.correo_silver || "").trim().toLowerCase();
        if (!correoSilver) {
          await client.query("ROLLBACK");
          return res.status(422).json({ error: "Debe existir correo_silver para aprobar" });
        }
        if (!isValidSilverEmail(correoSilver)) {
          await client.query("ROLLBACK");
          return res.status(422).json({ error: "correo_silver debe pertenecer al dominio @silverconsulting.com.co" });
        }

        const dup = await client.query(`SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1`, [correoSilver]);
        if (dup.rows.length > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Ya existe un usuario con ese correo_silver" });
        }

        const [rolRes, tipoCuentaResult] = await Promise.all([
          client.query(`SELECT id FROM roles WHERE LOWER(titulo) = LOWER('Consultor') LIMIT 1`),
          client.query(`SELECT id FROM tipo_cuenta_bancaria WHERE LOWER(titulo) LIKE LOWER($1) LIMIT 1`, [`${current.tipo_cuenta || ""}%`])
        ]);

        tipoCuentaRes = tipoCuentaResult;
        rolId = rolRes.rows[0]?.id || null;
        if (!rolId) {
          await client.query("ROLLBACK");
          return res.status(500).json({ error: "No existe el rol Consultor" });
        }
      } else {
        tipoCuentaRes = await client.query(
          `SELECT id FROM tipo_cuenta_bancaria WHERE LOWER(titulo) LIKE LOWER($1) LIMIT 1`,
          [`${current.tipo_cuenta || ""}%`]
        );
      }

      // ── UPSERT en tabla personas (núcleo de datos personales) ──────────────
      // Detectar si el módulo es "Otros" para poblar modulo_otro
      const linkedSolicitud = await client.query(
        `SELECT datos_extra, coordinador_solicitante_id FROM solicitudes_contratacion WHERE preregistro_id = $1 AND estado <> 'Cancelado' ORDER BY updated_at DESC LIMIT 1`,
        [id]
      );
      const solicitudDatosExtra = linkedSolicitud.rows[0]?.datos_extra || {};
      const moduloUuidPreregistro = solicitudDatosExtra.modulo_id || null;
      let moduloInternoIdPreregistro = null;
      if (moduloUuidPreregistro) {
        const modRes = await client.query(`SELECT id FROM modulo WHERE public_id::text = $1::text LIMIT 1`, [moduloUuidPreregistro]);
        moduloInternoIdPreregistro = modRes.rows[0]?.id || null;
      }
      const moduloOtroPreregistro = !moduloInternoIdPreregistro ? (solicitudDatosExtra.modulo || current.perfil || null) : null;

      const clienteUuidPreregistro = solicitudDatosExtra.cliente_id || null;
      let clienteInternoIdPreregistro = null;
      if (clienteUuidPreregistro) {
        const cliRes = await client.query(`SELECT id FROM clientes WHERE public_id::text = $1::text LIMIT 1`, [clienteUuidPreregistro]);
        clienteInternoIdPreregistro = cliRes.rows[0]?.id || null;
      }

      const tipoPersonaParaPersonas = normalizeTipoPersonaForUsuarios(current.tipo_persona) || null;

      const personaRes = await client.query(
        `INSERT INTO personas (
          numero_documento, tipo_documento_id, nombre, apellidos,
          numero_contacto, correo_electronico, direccion_residencia, ciudad_residencia,
          tipo_persona, factura_en_colombia,
          banco_id, tipo_cuenta_id, numero_cuenta,
          modulo_id, modulo_otro, cliente_id,
          razon_social, nit_empresa, representante_legal,
          tipo_documento_representante, numero_documento_representante,
          preregistro_id, created_by
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
          razon_social                   = COALESCE(EXCLUDED.razon_social, personas.razon_social),
          nit_empresa                    = COALESCE(EXCLUDED.nit_empresa, personas.nit_empresa),
          representante_legal            = COALESCE(EXCLUDED.representante_legal, personas.representante_legal),
          tipo_documento_representante   = COALESCE(EXCLUDED.tipo_documento_representante, personas.tipo_documento_representante),
          numero_documento_representante = COALESCE(EXCLUDED.numero_documento_representante, personas.numero_documento_representante),
          preregistro_id                 = COALESCE(EXCLUDED.preregistro_id, personas.preregistro_id),
          updated_at                     = NOW()
        RETURNING id`,
        [
          current.numero_documento || null,
          current.tipo_documento_id || null,
          current.nombre || null,
          current.apellidos || null,
          current.telefono || null,
          current.correo_personal || null,
          current.direccion || null,
          current.ciudad || null,
          tipoPersonaParaPersonas,
          current.factura_en_colombia === null || current.factura_en_colombia === undefined ? null : Boolean(current.factura_en_colombia),
          current.banco_id || null,
          tipoCuentaRes.rows[0]?.id || null,
          current.numero_cuenta || null,
          moduloInternoIdPreregistro,
          moduloOtroPreregistro,
          clienteInternoIdPreregistro,
          current.razon_social || null,
          current.nit_empresa || null,
          current.representante_legal || null,
          current.tipo_documento_representante || null,
          current.numero_documento_representante || null,
          id,
          req.user?.id || null
        ]
      );
      const personaId = personaRes.rows[0]?.id || null;
      // ────────────────────────────────────────────────────────────────────────

      const nombreCompleto = `${current.nombre || ""} ${current.apellidos || ""}`.trim();
      if (!debeCrearUsuario) {
        await client.query(
          `UPDATE preregistro_personas
           SET estado = 'Completado', aprobado_por = $1, id_usuario_creado = NULL, fecha_aprobacion = NOW()
           WHERE id = $2`,
          [req.user?.id, id]
        );
        const updatedPreregistro = await getByInternalId(client, id);
        const solicitudId = await syncSolicitudContratacionFromPreregistro(client, updatedPreregistro, {
          estado: ESTADOS.completado,
          personaUsuarioId: null
        });
        await client.query("COMMIT");

        try {
          await ensurePersistedAnexoFromProceso({
            solicitudId: solicitudId || null,
            preregistroId: id,
            createdBy: req.user?.id || null,
            strict: false
          });
        } catch (err) {
          console.warn("No se pudo sincronizar anexo tecnico desde preregistro:", err?.message || err);
        }

        if (current.coordinador_email) {
          sendEmailSafe({
            ...getGraphContext(req),
            to: current.coordinador_email,
            subject: `Persona registrada para ${nombreCompleto}`,
            text: `Se aprobó el preregistro y se creó la persona ${nombreCompleto} (${current.numero_documento || ""}) sin cuenta de sistema.`
          }).catch((e) => console.error("Error enviando correo de aprobacion:", e?.message || e));
        }

        return res.json({
          preregistro_id: current.public_id,
          estado: "Completado",
          persona_creada: { nombre: nombreCompleto, numero_documento: current.numero_documento }
        });
      }

      const usuarioRes = await client.query(
        `INSERT INTO usuarios
          (nombre_usuario, email, rol_usuario_id, activo, nro_cuenta_bancaria, banco_id, tipo_cuenta_id, tipo_documento_id, cedula, direccion, telefono, ciudad, tipo_persona, moneda_cobro, factura_en_colombia, persona_id, created_by, azure_oid)
         VALUES
          ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12::tipo_persona, $13::tipo_moneda, $14, $15, 'preregistro_th', NULL)
         RETURNING id, public_id, nombre_usuario, email`,
        [
          nombreCompleto || correoSilver,
          correoSilver,
          rolId,
          current.numero_cuenta || null,
          current.banco_id || null,
          tipoCuentaRes.rows[0]?.id || null,
          current.tipo_documento_id || null,
          current.numero_documento || null,
          current.direccion || null,
          current.telefono || null,
          current.ciudad || null,
          normalizeTipoPersonaForUsuarios(current.tipo_persona) || null,
          current.moneda || "COP",
          current.factura_en_colombia === null || current.factura_en_colombia === undefined
            ? null
            : Boolean(current.factura_en_colombia),
          personaId
        ]
      );

      const usuario = usuarioRes.rows[0];
      await client.query(
        `UPDATE preregistro_personas
         SET estado = $1, aprobado_por = $2, id_usuario_creado = $3, fecha_aprobacion = NOW()
         WHERE id = $4`,
        [ESTADOS.completado, req.user?.id, usuario.id, id]
      );
      const updatedPreregistro = await getByInternalId(client, id);
      // Sincronizar solicitud_contratacion dentro de la transacción (necesita el client)
      const solicitudId = await syncSolicitudContratacionFromPreregistro(client, updatedPreregistro, {
        estado: ESTADOS.completado,
        personaUsuarioId: usuario.id
      });
      await client.query("COMMIT");

      // Generar anexo DESPUÉS del COMMIT para que pool vea id_usuario_creado ya confirmado
      try {
        await ensurePersistedAnexoFromProceso({
          solicitudId: solicitudId || null,
          preregistroId: id,
          createdBy: req.user?.id || null,
          strict: false
        });
      } catch (err) {
        console.warn("No se pudo sincronizar anexo tecnico desde preregistro:", err?.message || err);
      }

      const tasks = [
        sendEmailSafe({ ...getGraphContext(req), to: current.correo_personal, subject: "Bienvenido(a) - cuenta creada", text: `Tu usuario fue creado. Correo Silver: ${correoSilver}` })
      ];
      if (current.coordinador_email) {
        tasks.push(sendEmailSafe({ ...getGraphContext(req), to: current.coordinador_email, subject: `Usuario creado para ${nombreCompleto}`, text: `Se aprobo el preregistro y se creo el usuario ${usuario.email}` }));
      }
      Promise.all(tasks).catch((e) => console.error("Error enviando correos de aprobacion:", e?.message || e));

      return res.json({
        preregistro_id: current.public_id,
        estado: ESTADOS.completado,
        usuario_creado: { id: usuario.public_id, nombre: usuario.nombre_usuario, email: usuario.email }
      });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Preregistro no encontrado" });
      if (err?.code === "23505") return res.status(409).json({ error: "Conflicto de unicidad creando usuario" });
      console.error(err);
      return res.status(500).json({ error: "Error aprobando preregistro" });
    } finally {
      client.release();
    }
  });

  app.post("/api/preregistros/:public_id/completar", requireAccess({ roles: ["Talento Humano"] }), async (req, res) => {
    try {
      const current = await getByPublicId(pool, req.params.public_id);
      if (!current) return res.status(404).json({ error: "Preregistro no encontrado" });
      const id = current.id;
      if (current.estado === ESTADOS.completado) {
        return res.json(formatRow(current));
      }
      return res.status(422).json({ error: "Este flujo completa automaticamente al aprobar" });
    } catch (err) {
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Preregistro no encontrado" });
      console.error(err);
      return res.status(500).json({ error: "Error completando preregistro" });
    }
  });

  app.post("/api/preregistros/:public_id/anular", requireAccess({ roles: ["Talento Humano"] }), async (req, res) => {
    const motivo = String(req.body?.motivo_anulacion || "").trim();
    if (motivo.length < 20) {
      return res.status(400).json({ error: "motivo_anulacion es obligatorio y minimo de 20 caracteres" });
    }
    try {
      const current = await getByPublicId(pool, req.params.public_id);
      if (!current) return res.status(404).json({ error: "Preregistro no encontrado" });
      const id = current.id;
      if (current.estado === ESTADOS.completado) {
        return res.status(422).json({ error: "No se puede anular un preregistro Completado" });
      }

      await pool.query(`UPDATE preregistro_personas SET estado = $1, motivo_anulacion = $2, anulado_por = $3, fecha_anulacion = NOW() WHERE id = $4`, [ESTADOS.anulado, motivo, req.user?.id, id]);
      const updated = await getByInternalId(pool, id);
      await syncSolicitudContratacionFromPreregistro(pool, updated, { estado: "Cancelado" });

      const tasks = [];
      if (updated?.coordinador_email) {
        tasks.push(sendEmailSafe({ ...getGraphContext(req), to: updated.coordinador_email, subject: "Preregistro anulado", text: `Se anulo el preregistro ${updated.public_id}. Motivo: ${motivo}` }));
      }
      const reclutadorMail = await pool.query(`SELECT email FROM usuarios WHERE id = $1 LIMIT 1`, [updated.creado_por]);
      if (reclutadorMail.rows[0]?.email) {
        tasks.push(sendEmailSafe({ ...getGraphContext(req), to: reclutadorMail.rows[0].email, subject: "Preregistro anulado", text: `Se anulo el preregistro ${updated.public_id}. Motivo: ${motivo}` }));
      }
      Promise.all(tasks).catch((e) => console.error("Error enviando correos de anulacion:", e?.message || e));

      return res.json(formatRow(updated));
    } catch (err) {
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Preregistro no encontrado" });
      console.error(err);
      return res.status(500).json({ error: "Error anulando preregistro" });
    }
  });

  app.get("/api/preregistros", requireAccess({ roles: ["Reclutador", "Coordinador", "Comercial", "Talento Humano", "Administrador"] }), async (req, res) => {
    const page = Math.max(Number(req.query?.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query?.limit || 20), 1), 100);
    try {
      const role = normalizeValue(req.user?.rol);
      const { estado, search, desde, hasta, solicitud_id } = req.query || {};
      const offset = (page - 1) * limit;

      const where = [];
      const vals = [];
      let idx = 1;

      if (estado) {
        where.push(`p.estado = $${idx++}`);
        vals.push(estado);
      }
      if (search) {
        where.push(`(p.nombre ILIKE $${idx} OR p.apellidos ILIKE $${idx} OR p.numero_documento ILIKE $${idx} OR p.correo_personal ILIKE $${idx})`);
        vals.push(`%${String(search).trim()}%`);
        idx += 1;
      }
      if (desde) {
        where.push(`p.created_at::date >= $${idx++}::date`);
        vals.push(desde);
      }
      if (hasta) {
        where.push(`p.created_at::date <= $${idx++}::date`);
        vals.push(hasta);
      }
      if (solicitud_id) {
        const solRes = await pool.query("SELECT id FROM solicitudes_rrhh WHERE public_id = $1", [solicitud_id]);
        if (solRes.rows.length > 0) {
          where.push(`p.id_solicitud_rrhh = $${idx++}`);
          vals.push(solRes.rows[0].id);
        } else {
          return res.json({ page, limit, total: 0, data: [] });
        }
      }
      if (role === "reclutador") {
        where.push(`p.creado_por = $${idx++}`);
        vals.push(req.user?.id);
      }
      if (["coordinador", "comercial"].includes(role)) {
        where.push(`s.coordinador_id = $${idx++}`);
        vals.push(req.user?.id);
      }

      vals.push(limit);
      vals.push(offset);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const result = await pool.query(`${BASE_SELECT} ${whereSql} ORDER BY p.updated_at DESC LIMIT $${idx++} OFFSET $${idx}`, vals);

      return res.json({ page, limit, total: result.rows.length, data: result.rows.map(formatRow) });
    } catch (err) {
      if (["42P01", "42703", "42883"].includes(String(err?.code || ""))) {
        console.error("Preregistro con esquema incompleto, retornando vacio:", err?.message || err);
        return res.json({
          page,
          limit,
          total: 0,
          data: [],
          warning: "Esquema de preregistro pendiente de migracion en base de datos"
        });
      }
      console.error(err);
      return res.status(500).json({ error: "Error listando preregistros" });
    }
  });

  app.get("/api/preregistros/:public_id", requireAccess({ roles: ["Reclutador", "Coordinador", "Comercial", "Talento Humano", "Administrador"] }), async (req, res) => {
    try {
      const row = await getByPublicId(pool, req.params.public_id);
      if (!row) return res.status(404).json({ error: "Preregistro no encontrado" });

      const role = normalizeValue(req.user?.rol);
      if (role === "reclutador" && String(row.creado_por) !== String(req.user?.id || "")) {
        return res.status(403).json({ error: "No puedes ver preregistros creados por otro reclutador" });
      }
      if (["coordinador", "comercial"].includes(role) && String(row.solicitud_coordinador_id) !== String(req.user?.id || "")) {
        return res.status(403).json({ error: "No puedes ver preregistros de otro coordinador" });
      }

      return res.json(formatRow(row));
    } catch (err) {
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Preregistro no encontrado" });
      console.error(err);
      return res.status(500).json({ error: "Error consultando preregistro" });
    }
  });
};
