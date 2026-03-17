module.exports = function registerPreregistroRoutes(deps) {
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
    pendienteCoordinador: "Pendiente Coordinador",
    pendienteRevisionTh: "Pendiente Revision TH",
    pendienteCorreoSilver: "Pendiente Correo Silver",
    completado: "Completado",
    anulado: "Anulado"
  });

  const TIPOS_CUENTA = new Set(["Ahorros", "Corriente"]);
  const TIPOS_PERSONA = new Set(["Natural", "Juridica"]);
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
    return "Otro";
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

  function normalizeTipoPersonaForUsuarios(value) {
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
      p.fecha_fin, p.moneda, p.pais_pago,
      p.tarifa_hora, p.tarifa_mes, p.tarifa_medio_tiempo, p.tarifa_capacitacion,
      p.vpn_corona, p.necesita_s_user, p.grupo_usuario, p.grupo_distribucion,
      p.observaciones, p.direccion, p.tipo_persona, p.banco_id,
      b.titulo AS banco_nombre,
      p.tipo_cuenta, p.numero_cuenta, p.correo_silver, p.estado,
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
      su.public_id AS coordinador_public_id, su.nombre_usuario AS coordinador_nombre, su.email AS coordinador_email
    FROM preregistro_personas p
    JOIN solicitudes_rrhh s ON s.id = p.id_solicitud_rrhh
    LEFT JOIN bancos b ON b.id = p.banco_id
    LEFT JOIN documento_identidad di ON di.id = p.tipo_documento_id
    LEFT JOIN clientes c ON c.id = s.cliente_id
    LEFT JOIN modulo m ON m.id = s.modulo_id
    LEFT JOIN usuarios su ON su.id = s.coordinador_id
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
        coordinador: { id: row.coordinador_public_id, nombre: row.coordinador_nombre, email: row.coordinador_email }
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

  app.post("/api/solicitudes-rrhh/:public_id/contratar", requireAccess({ roles: ["Reclutador"] }), async (req, res) => {
    const { nombre, apellidos, tipo_documento, numero_documento, telefono, correo_personal, pais_ubicacion, ciudad,
            moneda, tarifa_mes, tarifa_hora } = req.body || {};
    const docType = String(tipo_documento || "").trim();
    const monedaNorm = String(moneda || "").trim().toUpperCase();

    if (!nombre || !apellidos || !docType || !numero_documento || !correo_personal) {
      return res.status(400).json({ error: "Faltan campos obligatorios de la seccion 1" });
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

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const solicitudRes = await client.query(
        `SELECT s.id, s.estado, su.email AS coordinador_email, su.nombre_usuario AS coordinador_nombre, s.perfil
              , s.public_id AS solicitud_public_id, s.coordinador_id, s.cliente_id, s.modulo_id
              , s.modalidad, s.ubicacion, s.fecha_inicio_esperada, s.descripcion, s.informacion_adicional, s.observaciones_rrhh
              , c.titulo AS cliente_nombre, m.titulo AS modulo_nombre
         FROM solicitudes_rrhh s
         LEFT JOIN clientes c ON c.id = s.cliente_id
         LEFT JOIN modulo m ON m.id = s.modulo_id
         LEFT JOIN usuarios su ON su.id = s.coordinador_id
         WHERE s.public_id = $1 FOR UPDATE OF s`,
        [req.params.public_id]
      );
      const solicitud = solicitudRes.rows[0];
      if (!solicitud) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Solicitud no encontrada" });
      }
      const solicitudId = solicitud.id;
      if (!["Entrevistas", "Reclutamiento"].includes(String(solicitud.estado || ""))) {
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
          (id_solicitud_rrhh, nombre, apellidos, tipo_documento_id, numero_documento, telefono, correo_personal, pais_ubicacion, ciudad, moneda, tarifa_mes, tarifa_hora, estado, creado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING public_id, estado`,
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
          tarifaMesParsed.value,
          tarifaHoraParsed.value,
          ESTADOS.pendienteCoordinador,
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
              modulo_id: solicitud.modulo_id || null,
              modulo_nombre: solicitud.modulo_nombre || null,
              cliente_nombre: solicitud.cliente_nombre || null
            };

            await client.query(
              `
              INSERT INTO solicitudes_contratacion (
                tipo_solicitud,
                estado,
                coordinador_solicitante_id,
                cliente_id,
                tipo_documento_id,
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
                'Pendiente',
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
                $18::jsonb,
                $19,
                false,
                false,
                false
              )
              `,
              [
                solicitud.coordinador_id,
                solicitud.cliente_id,
                tipoDocumentoId,
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
                requiereConfirmacionCliente
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

      if (solicitud.coordinador_email) {
        sendEmailSafe({
          ...getGraphContext(req),
          to: solicitud.coordinador_email,
          subject: `Nuevo preregistro pendiente - ${solicitud.perfil || "Perfil"}`,
          text: `Se creo un preregistro para la solicitud ${solicitud.perfil || ""}. ID: ${created.rows[0]?.public_id}`,
          html: buildEmailLayout({
            title: "Preregistro pendiente por completar",
            intro: `Se creo un preregistro para la solicitud ${solicitud.perfil || ""}.`,
            blocks: [
              { label: "Estado", value: ESTADOS.pendienteCoordinador },
              { label: "ID preregistro", value: String(created.rows[0]?.public_id || "") }
            ]
          })
        }).catch((err) => console.error("Error notificando preregistro al coordinador:", err?.message || err));
      }

      return res.status(201).json({ preregistro_id: created.rows[0]?.public_id, estado_preregistro: created.rows[0]?.estado, estado_solicitud: "Contratado" });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Solicitud no encontrada" });
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
      return res.json(formatRow(await getByInternalId(client, id)));
    } catch (err) {
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Preregistro no encontrado" });
      console.error(err);
      return res.status(500).json({ error: "Error actualizando seccion 1" });
    } finally {
      client.release();
    }
  });

  app.patch("/api/preregistros/:public_id/seccion-2", requireAccess({ roles: ["Coordinador"] }), async (req, res) => {
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
      if (current.estado !== ESTADOS.pendienteCoordinador) {
        return res.status(422).json({ error: "La seccion 2 solo puede completarse en Pendiente Coordinador" });
      }
      if (String(current.solicitud_coordinador_id) !== String(req.user?.id || "")) {
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
      const thUsers = await pool.query(
        `SELECT u.email
         FROM usuarios u
         JOIN roles r ON r.id = u.rol_usuario_id
         WHERE u.activo = true AND u.email IS NOT NULL AND LOWER(r.titulo) = LOWER('Talento Humano')`
      );
      const thDest = thUsers.rows.map((r) => r.email).filter(Boolean);
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

  app.patch("/api/preregistros/:public_id/seccion-2/editar", requireAccess({ roles: ["Coordinador"] }), async (req, res) => {
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
      if (String(current.solicitud_coordinador_id) !== String(req.user?.id || "")) {
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
      return res.json(formatRow(await getByInternalId(client, id)));
    } catch (err) {
      if (err?.code === "PUBLIC_ID_NOT_FOUND") return res.status(404).json({ error: "Preregistro no encontrado" });
      console.error(err);
      return res.status(500).json({ error: "Error editando seccion 2" });
    } finally {
      client.release();
    }
  });

  app.patch("/api/preregistros/:public_id/seccion-3", requireAccess({ roles: ["Talento Humano"] }), async (req, res) => {
    const { direccion, tipo_persona, banco_id, tipo_cuenta, numero_cuenta, correo_silver } = req.body || {};
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
      await client.query(
        `UPDATE preregistro_personas
         SET direccion = $1, tipo_persona = $2, banco_id = $3, tipo_cuenta = $4, numero_cuenta = $5,
             correo_silver = COALESCE($6, correo_silver), estado = $7,
             completado_th_por = $8, fecha_completado_th = NOW()
         WHERE id = $9`,
        [direccion, String(tipo_persona).trim(), bancoId, String(tipo_cuenta).trim(), String(numero_cuenta).trim(), correoSilverNorm, nextState, req.user?.id, id]
      );

      return res.json(formatRow(await getByInternalId(client, id)));
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
      return res.json(formatRow(await getByInternalId(client, id)));
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

      const correoSilver = String(current.correo_silver || "").trim().toLowerCase();
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

      const [rolRes, tipoCuentaRes] = await Promise.all([
        client.query(`SELECT id FROM roles WHERE LOWER(titulo) = LOWER('Consultor') LIMIT 1`),
        client.query(`SELECT id FROM tipo_cuenta_bancaria WHERE LOWER(titulo) LIKE LOWER($1) LIMIT 1`, [`${current.tipo_cuenta || ""}%`])
      ]);

      const rolId = rolRes.rows[0]?.id || null;
      if (!rolId) {
        await client.query("ROLLBACK");
        return res.status(500).json({ error: "No existe el rol Consultor" });
      }

      const nombreCompleto = `${current.nombre || ""} ${current.apellidos || ""}`.trim();
      const usuarioRes = await client.query(
        `INSERT INTO usuarios
          (nombre_usuario, email, rol_usuario_id, activo, nro_cuenta_bancaria, banco_id, tipo_cuenta_id, tipo_documento_id, cedula, direccion, telefono, ciudad, tipo_persona, moneda_cobro, created_by, azure_oid)
         VALUES
          ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12::tipo_persona, $13::tipo_moneda, 'preregistro_th', NULL)
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
          current.moneda || "COP"
        ]
      );

      const usuario = usuarioRes.rows[0];
      await client.query(
        `UPDATE preregistro_personas
         SET estado = $1, aprobado_por = $2, id_usuario_creado = $3, fecha_aprobacion = NOW()
         WHERE id = $4`,
        [ESTADOS.completado, req.user?.id, usuario.id, id]
      );
      await client.query("COMMIT");

      // Sincronizar el borrador de solicitud_contratacion que se creó automáticamente
      // cuando RRHH marcó la solicitud como Contratado (identificado por preregistro_id en datos_extra)
      pool.query(
        `UPDATE solicitudes_contratacion
         SET
           estado             = 'Completado',
           persona_usuario_id = $1,
           correo_empresarial = $2,
           updated_at         = NOW()
         WHERE estado = 'Pendiente'
           AND (datos_extra->>'preregistro_id') = $3`,
        [usuario.id, correoSilver, String(current.public_id)]
      ).catch((e) => console.error("Error sincronizando borrador contratacion:", e?.message || e));

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

  app.get("/api/preregistros", requireAccess({ roles: ["Reclutador", "Coordinador", "Talento Humano", "Administrador"] }), async (req, res) => {
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
      if (role === "coordinador") {
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

  app.get("/api/preregistros/:public_id", requireAccess({ roles: ["Reclutador", "Coordinador", "Talento Humano", "Administrador"] }), async (req, res) => {
    try {
      const row = await getByPublicId(pool, req.params.public_id);
      if (!row) return res.status(404).json({ error: "Preregistro no encontrado" });

      const role = normalizeValue(req.user?.rol);
      if (role === "reclutador" && String(row.creado_por) !== String(req.user?.id || "")) {
        return res.status(403).json({ error: "No puedes ver preregistros creados por otro reclutador" });
      }
      if (role === "coordinador" && String(row.solicitud_coordinador_id) !== String(req.user?.id || "")) {
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
