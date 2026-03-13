module.exports = function registerContratacionesRoutes(deps) {
  const {
    app,
    pool,
    ID_TABLES,
    normalizeValue,
    requireAccess,
    getGraphContext,
    sendEmailSafe,
    buildEmailLayout
  } = deps;

  const ESTADOS = Object.freeze({
    pendiente: "Pendiente",
    enProceso: "En Proceso",
    pendienteConfirmacionCliente: "Pendiente Confirmación Cliente",
    pendienteRevisionTh: "Pendiente Revision TH",
    completado: "Completado"
  });

  const TIPO_NUEVO = "Nuevo";
  const TIPO_EXTENSION = "Extension";
  const TIPO_RETIRO = "Retiro";

  const DESTINOS_MESA = parseEmailList(
    process.env.CONTRATACIONES_DESTINO_MESA ||
      "mesadeayuda@zettatech.com.co,jorge.castaneda@zettatech.com.co,richard.rendon@zettatech.com.co"
  );
  const DESTINOS_TH = parseEmailList(
    process.env.CONTRATACIONES_DESTINO_TH ||
      "catalina.loaiza@silverconsulting.com.co,ana.garcia@silverconsulting.com.co"
  );

  const BASE_SELECT = `
    SELECT
      sc.id,
      sc.public_id,
      sc.tipo_solicitud,
      sc.estado,
      sc.coordinador_solicitante_id,
      coord.public_id AS coordinador_public_id,
      coord.nombre_usuario AS coordinador_nombre,
      coord.email AS coordinador_email,
      sc.persona_usuario_id,
      persona.public_id AS persona_public_id,
      persona.nombre_usuario AS persona_nombre,
      persona.email AS persona_email,
      sc.supervisor_id,
      sup.public_id AS supervisor_public_id,
      sup.nombre_usuario AS supervisor_nombre,
      sup.email AS supervisor_email,
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
    if (raw === "COP" || raw === "USD") return raw;
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

  function formatRow(row) {
    if (!row) return null;
    return {
      id: row.public_id,
      tipo_solicitud: row.tipo_solicitud,
      estado: row.estado,
      coordinador: row.coordinador_public_id
        ? {
            id: row.coordinador_public_id,
            nombre: row.coordinador_nombre,
            email: row.coordinador_email || null
          }
        : null,
      persona: row.persona_public_id
        ? {
            id: row.persona_public_id,
            nombre: row.persona_nombre,
            email: row.persona_email || null
          }
        : null,
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
      grupo_app_tiempos: row.grupo_app_tiempos || null,
      grupo_distribucion: row.grupo_distribucion || null,
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
      datos_extra: row.datos_extra || {},
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

  function requireOwnerIfCoordinator(req, row) {
    const role = normalizeValue(req.user?.rol);
    if (role !== "coordinador") return true;
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
      { label: "Fecha inicio", value: solicitud.fecha_inicio || "N/A" },
      { label: "Fecha fin", value: solicitud.fecha_fin || "N/A" },
      { label: "Fecha extension desde", value: solicitud.fecha_extension_desde || "N/A" },
      { label: "Fecha extension hasta", value: solicitud.fecha_extension_hasta || "N/A" },
      { label: "Fecha retiro", value: solicitud.fecha_retiro || "N/A" },
      { label: "Grupo APP tiempos", value: solicitud.grupo_app_tiempos || "N/A" },
      { label: "Grupo distribucion", value: solicitud.grupo_distribucion || "N/A" },
      { label: "Necesidad TI", value: solicitud.necesidad_ti || "N/A" },
      { label: "Observaciones", value: solicitud.observaciones || "N/A" },
      { label: "Solicitado por", value: solicitud?.coordinador?.email || "N/A" }
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
        "Se completo parcialmente la gestion de la solicitud.\n" +
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
    const blocks = baseBlocks(solicitud);
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

  function buildMailMesaRetiro(solicitud) {
    const blocks = baseBlocks(solicitud);
    return {
      subject: "Retirar usuarios, licencias y VPN",
      text:
        "Favor bloquear accesos (Microsoft y VPN), retirar licencias y S user.\n\n" +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Retiro - Acciones TI",
        intro: "Favor bloquear accesos, retirar licencias y eliminar S user.",
        blocks
      })
    };
  }

  function buildMailThRetiro(solicitud) {
    const blocks = baseBlocks(solicitud);
    return {
      subject: "Administrativos: Retirar contrato",
      text:
        "Proceder con el retiro del contrato para:\n\n" +
        blocks.map((item) => `${item.label}: ${item.value}`).join("\n"),
      html: buildEmailLayout({
        title: "Administrativos: Retiro de contrato",
        intro: "Se solicita gestionar el retiro de contrato con la siguiente informacion.",
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
    const coordinadorEmail = toNullableString(rawSolicitud.coordinador_email || req.user?.email);
    const requiereConfirmacionCliente = Boolean(rawSolicitud.requiere_confirmacion_cliente);

    const mailResults = {
      mesa: false,
      th: false,
      coordinador: false
    };

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
        const thResult = await sendMail(graphContext, DESTINOS_TH, buildMailThNuevo(solicitud));
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
      const thResult = await sendMail(graphContext, DESTINOS_TH, buildMailThExtension(solicitud));
      mailResults.th = Boolean(thResult.ok);
    }

    if (solicitud.tipo_solicitud === TIPO_RETIRO) {
      const mesaResult = await sendMail(graphContext, DESTINOS_MESA, buildMailMesaRetiro(solicitud));
      mailResults.mesa = Boolean(mesaResult.ok);
      const thResult = await sendMail(graphContext, DESTINOS_TH, buildMailThRetiro(solicitud));
      mailResults.th = Boolean(thResult.ok);
      const coordResult = await sendMail(graphContext, coordinadorEmail, buildMailCoordinadorRetiro(solicitud));
      mailResults.coordinador = Boolean(coordResult.ok);
    }

    const estadoFinal = computeFinalStateOnCreate({
      tipoSolicitud: solicitud.tipo_solicitud,
      requiereConfirmacionCliente,
      mailResults
    });

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

  app.get(
    "/contrataciones/personas",
    requireAccess({ roles: ["Administrador", "Coordinador", "Talento Humano"] }),
    async (req, res) => {
      try {
        const search = String(req.query?.search || "").trim();
        const limit = Math.min(Math.max(Number(req.query?.limit || 10), 1), 25);
        if (search.length < 2) return res.json([]);

        const result = await pool.query(
          `
          SELECT
            u.public_id AS id,
            u.nombre_usuario,
            u.email AS correo_empresarial,
            u.cedula AS numero_documento,
            u.telefono,
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
        return res.json(result.rows || []);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Error buscando personas" });
      }
    }
  );

  app.get(
    "/contrataciones/solicitudes",
    requireAccess({ roles: ["Administrador", "Coordinador", "Talento Humano"] }),
    async (req, res) => {
      try {
        const role = normalizeValue(req.user?.rol);
        const where = [];
        const values = [];
        let idx = 1;

        if (role === "coordinador") {
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
    requireAccess({ roles: ["Administrador", "Coordinador", "Talento Humano"] }),
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
    requireAccess({ roles: ["Administrador", "Coordinador"] }),
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
      const necesidadTi = toNullableString(payload.necesidad_ti);
      const observaciones = toNullableString(payload.observaciones);
      const enviarCorreos = payload.enviar_correos !== false;

      if (!nombre || !apellidos) {
        return res.status(400).json({ error: "nombre y apellidos son obligatorios" });
      }
      if (enviarCorreos && !necesidadTi) {
        return res.status(400).json({ error: "necesidad_ti es obligatoria" });
      }
      if (enviarCorreos && tipoSolicitud === TIPO_RETIRO && !payload.fecha_retiro) {
        return res.status(400).json({ error: "fecha_retiro es obligatoria para solicitudes de retiro" });
      }

      const moneda = payload.moneda === undefined ? null : normalizeMoneda(payload.moneda);
      if (payload.moneda !== undefined && !moneda) {
        return res.status(400).json({ error: "moneda invalida. Usa COP o USD" });
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
        if (tipoSolicitud === TIPO_NUEVO && (!payload.cliente_id || !refs.cliente_id)) {
           return res.status(400).json({ error: "Cliente obligatorio para solicitudes Nuevo" });
        }
        if (payload.cliente_id && !refs.cliente_id) throw { code: "PUBLIC_ID_NOT_FOUND" };

        const personaUsuarioId = refs.persona_usuario_id || null;
        const supervisorId = refs.supervisor_id || null;
        const tipoDocumentoId = refs.tipo_documento_id || null;
        const clienteId = refs.cliente_id || null;

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

        if (payload.modulo_id && !datosExtra.modulo_id) datosExtra.modulo_id = payload.modulo_id;
        if (payload.modulo && !datosExtra.modulo) datosExtra.modulo = payload.modulo;
        if (clienteNombre && !datosExtra.cliente_nombre) datosExtra.cliente_nombre = clienteNombre;

        const inserted = await pool.query(
          `
          INSERT INTO solicitudes_contratacion (
            tipo_solicitud,
            estado,
            coordinador_solicitante_id,
            persona_usuario_id,
            supervisor_id,
            cliente_id,
            tipo_documento_id,
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
            requiere_confirmacion_cliente,
            correo_enviado_mesa,
            correo_enviado_th,
            correo_confirmacion_coordinador
          )
          VALUES (
            $1,  $2,  $3,  $4,  $5,  $6,  $7,  $8,  $9,  $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
            $31, $32, false, false, false
          )
          RETURNING id
          `,
          [
            tipoSolicitud,
            estadoInicial,
            req.user?.id,
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
            moneda,
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
            requiereConfirmacionCliente
          ]
        );

        const createdId = inserted.rows[0]?.id;
        if (!createdId) {
          return res.status(500).json({ error: "No se pudo recuperar la solicitud creada" });
        }

        if (!enviarCorreos) {
          const created = await getByInternalId(pool, createdId);
          return res.status(201).json(formatRow(created));
        }

        const updated = await dispatchAndFinalizeSolicitud({ internalId: createdId, req });
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
    requireAccess({ roles: ["Administrador", "Coordinador"] }),
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
        const necesidadTi =
          payload.necesidad_ti !== undefined ? toNullableString(payload.necesidad_ti) : current.necesidad_ti;
        const observaciones = payload.observaciones !== undefined ? toNullableString(payload.observaciones) : current.observaciones;

        if (!nombre || !apellidos) {
          return res.status(400).json({ error: "nombre y apellidos son obligatorios" });
        }
        if (!necesidadTi) {
          return res.status(400).json({ error: "necesidad_ti es obligatoria" });
        }

        const monedaInput = payload.moneda !== undefined ? payload.moneda : current.moneda;
        const moneda = monedaInput ? normalizeMoneda(monedaInput) : null;
        if (monedaInput && !moneda) {
          return res.status(400).json({ error: "moneda invalida. Usa COP o USD" });
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

        if (tipoSolicitud === TIPO_NUEVO && !clienteId) {
          return res.status(400).json({ error: "Cliente obligatorio para solicitudes Nuevo" });
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
        if (payload.modulo_id && !datosExtra.modulo_id) datosExtra.modulo_id = payload.modulo_id;
        if (payload.modulo && !datosExtra.modulo) datosExtra.modulo = payload.modulo;
        if (clienteNombre && !datosExtra.cliente_nombre) datosExtra.cliente_nombre = clienteNombre;

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
            moneda = $16,
            tarifa_hora = $17,
            tarifa_mes = $18,
            tarifa_medio_tiempo = $19,
            tarifa_capacitacion = $20,
            modalidad_contrato = $21,
            fecha_inicio = $22,
            fecha_fin = $23,
            fecha_extension_desde = $24,
            fecha_extension_hasta = $25,
            fecha_retiro = $26,
            necesidad_ti = $27,
            observaciones = $28,
            datos_extra = $29::jsonb,
            requiere_confirmacion_cliente = $30,
            correo_enviado_mesa = false,
            correo_enviado_th = false,
            correo_confirmacion_coordinador = false
          WHERE id = $31
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
            requiereConfirmacionCliente,
            internalId
          ]
        );

        const updated = await dispatchAndFinalizeSolicitud({ internalId, req });
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
    "/contrataciones/solicitudes/:id/revision-th",
    requireAccess({ roles: ["Administrador", "Talento Humano"] }),
    async (req, res) => {
      try {
        const row = await getByPublicId(pool, req.params.id);
        if (!row) return res.status(404).json({ error: "Solicitud no encontrada" });
        const internalId = row.id;

        if (row.tipo_solicitud !== TIPO_NUEVO) {
          return res.status(422).json({ error: "La revision TH solo aplica para solicitudes tipo Nuevo" });
        }
        if (row.estado !== ESTADOS.pendienteRevisionTh) {
          return res.status(422).json({ error: `La solicitud debe estar en '${ESTADOS.pendienteRevisionTh}' para ser revisada por TH` });
        }

        const observaciones = toNullableString(req.body?.observaciones_th);

        await pool.query(
          `
          UPDATE solicitudes_contratacion
          SET
            estado                = $1,
            revisado_th_por       = $2,
            fecha_revision_th     = NOW(),
            observaciones_th      = $3,
            updated_at            = NOW()
          WHERE id = $4
          `,
          [ESTADOS.completado, req.user?.id, observaciones, internalId]
        );

        const updated = await getByInternalId(pool, internalId);
        return res.json(formatRow(updated));
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Error procesando revision TH" });
      }
    }
  );

  app.post(
    "/contrataciones/solicitudes/:id/enviar-th",
    requireAccess({ roles: ["Administrador", "Coordinador"] }),
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
        const thResult = await sendMail(getGraphContext(req), DESTINOS_TH, buildMailThNuevo(solicitud));
        const thOk = Boolean(thResult.ok);

        await pool.query(
          `
          UPDATE solicitudes_contratacion
          SET
            correo_enviado_th = $1,
            estado = $2
          WHERE id = $3
          `,
          [thOk, thOk ? ESTADOS.completado : ESTADOS.pendienteConfirmacionCliente, internalId]
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
