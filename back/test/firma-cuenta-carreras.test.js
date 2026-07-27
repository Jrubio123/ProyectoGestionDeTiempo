const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buscarSeguridadSocialClickSign,
  iniciarFirmaCuenta,
  reiniciarFirmaCuenta,
  adjuntarFirmaCuenta,
  persistirDiagnosticoFirmaCuenta,
  __private
} = require("../src/services/cuentas-cobro.service");
const {
  __private: clicksignPrivate
} = require("../src/services/clicksign.service");
const {
  __private: cierrePrivate
} = require("../src/services/cuenta-cobro-cierre.service");

function createJsonResponse() {
  const response = { statusCode: 200, body: null };
  return {
    response,
    res: {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(body) {
        response.body = body;
        return body;
      }
    }
  };
}

function createTransactionPool(lockedCuenta) {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("SELECT id, public_id, datos_adjuntos")) {
        return { rows: [lockedCuenta] };
      }
      if (text.includes("SELECT id, estado, datos_adjuntos")) {
        return { rows: [lockedCuenta] };
      }
      if (text.includes("SELECT") && text.includes("FROM cuenta_cobro cc")) {
        return { rows: [lockedCuenta] };
      }
      if (text.includes("UPDATE cuenta_cobro")) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  };
  return {
    calls,
    pool: { connect: async () => client }
  };
}

test("intentos terminales usan cancelacion best-effort y pending sin URL bloquea", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  for (const estado of ["expired", "rejected", "cancelled"]) {
    assert.equal(__private.clasificarIntentoFirmaCuenta({ estado }, now).terminal, true);
  }
  const signedSinDocumento = {
    estado: "signed",
    request_id: "REQ-SIGNED",
    documento_firmado: {}
  };
  assert.equal(
    __private.clasificarIntentoFirmaCuenta(signedSinDocumento, now).terminal,
    true
  );
  assert.equal(
    __private.clasificarIntentoFirmaCuenta({
      ...signedSinDocumento,
      documento_firmado: { url: "https://onedrive/firmado.pdf" }
    }, now).terminal,
    false
  );
  assert.equal(
    __private.clasificarIntentoFirmaCuenta({
      estado: "pending",
      iniciado_en: "2026-07-21T11:00:00.000Z"
    }, now).terminal,
    true
  );
  assert.equal(
    __private.clasificarIntentoFirmaCuenta({ estado: "pending", request_id: "REQ-PENDING" }, now).terminal,
    false
  );
  assert.equal(
    __private.clasificarIntentoFirmaCuenta({
      estado: "starting",
      iniciado_en: "2026-07-22T11:58:00.000Z"
    }, now).startingEnCurso,
    true
  );
  assert.equal(
    __private.clasificarIntentoFirmaCuenta({
      estado: "starting",
      iniciado_en: "2026-07-22T11:56:00.000Z"
    }, now).terminal,
    true
  );

  const firmaTerminal = {
    estado: "expired",
    request_id: "REQ-OLD",
    contract_id: "CC-test"
  };
  const bestEffort = await __private.resolverCancelacionParaNuevoIntentoFirma({
    firma: firmaTerminal,
    terminal: true,
    cancelarFn: async () => ({
      ok: false,
      reason: "transporte",
      resumen: { message: "ECONNRESET" }
    })
  });
  assert.equal(bestEffort.ok, true);
  assert.equal(bestEffort.cancelada, false);

  const signedBestEffort = await __private.resolverCancelacionParaNuevoIntentoFirma({
    firma: signedSinDocumento,
    terminal: __private.clasificarIntentoFirmaCuenta(signedSinDocumento, now).terminal,
    cancelarFn: async () => ({
      ok: false,
      reason: "transporte",
      resumen: { message: "ECONNRESET" }
    })
  });
  assert.equal(signedBestEffort.ok, true);
  assert.equal(signedBestEffort.cancelada, false);

  const tx = createTransactionPool({
    id: 1,
    public_id: "cc-test",
    datos_adjuntos: { firma: firmaTerminal }
  });
  const archivo = await __private.archivarIntentoFirmaCuenta({
    cuentaId: 1,
    cancelacionResult: bestEffort,
    expected: { hasPreviousFirma: true, request_id: "REQ-OLD" },
    reserva: { requestId: "REQ-NEW", contractToken: "test" },
    deps: { pool: tx.pool }
  });
  assert.equal(archivo.updated, true);
  assert.equal(archivo.placeholder.estado, "starting");
  assert.equal(archivo.firmaArchivada.cancelada_en_clicksign, false);
  assert.equal(archivo.firmaArchivada.cancelacion_error, "ECONNRESET");
  assert.deepEqual(archivo.firmaArchivada.cancelacion_clicksign, { message: "ECONNRESET" });

  const estricta = await __private.resolverCancelacionParaNuevoIntentoFirma({
    firma: { estado: "pending", request_id: "REQ-PENDING" },
    terminal: false,
    req: { body: {}, user: { rol: "Coordinador" } },
    cancelarFn: async () => ({ ok: false, reason: "transporte" })
  });
  assert.equal(estricta.ok, false);
  assert.equal(estricta.statusCode, 502);

  const forceEstricto = await __private.resolverCancelacionParaNuevoIntentoFirma({
    firma: firmaTerminal,
    forceRestart: true,
    terminal: true,
    req: { body: {}, user: { rol: "Coordinador" } },
    cancelarFn: async () => ({ ok: false, reason: "transporte" })
  });
  assert.equal(forceEstricto.ok, false);
});

test("rN usa maximo historico + 1 dentro de la reserva", async () => {
  const firmaActiva = { request_id: "REQ-R1", contract_id: "CC-test-r1" };
  const tx = createTransactionPool({
    id: 1,
    public_id: "cc-test",
    datos_adjuntos: {
      firma: firmaActiva,
      firma_reseteos: [
        {
          contract_id: "CC-test-r1",
          firma_original: { contract_id: "CC-test" }
        }
      ]
    }
  });

  const result = await __private.archivarIntentoFirmaCuenta({
    cuentaId: 1,
    expected: { hasPreviousFirma: true, request_id: "REQ-R1" },
    cancelacionResult: { cancelada: true },
    reserva: { requestId: "REQ-R2", contractToken: "test" },
    deps: { pool: tx.pool }
  });

  assert.equal(result.contractId, "CC-test-r2");
  assert.equal(result.retryNumber, 2);
  assert.equal(result.placeholder.contract_id, "CC-test-r2");
});

test("archivo detecta cambio de identidad bajo lock y no actualiza", async () => {
  const tx = createTransactionPool({
    id: 1,
    public_id: "cc-test",
    datos_adjuntos: {
      firma: { request_id: "REQ-ACTUAL", contract_id: "CC-test-r2" }
    }
  });

  const result = await __private.archivarIntentoFirmaCuenta({
    cuentaId: 1,
    expected: { hasPreviousFirma: true, request_id: "REQ-LEIDO" },
    reserva: { requestId: "REQ-NUEVO", contractToken: "test" },
    deps: { pool: tx.pool }
  });

  assert.equal(result.raced, true);
  assert.equal(tx.calls.some((call) => call.sql.includes("UPDATE cuenta_cobro")), false);
});

test("archivo no reabre una firma finalizada bajo lock", async () => {
  const casos = [
    {
      estadoCuenta: "Aprobado",
      firma: {
        estado: "signed",
        request_id: "REQ-1",
        documento_firmado: {}
      }
    },
    {
      estadoCuenta: "Pendiente",
      firma: {
        estado: "pending",
        request_id: "REQ-1",
        documento_firmado: { url: "https://onedrive/firmado.pdf" }
      }
    }
  ];

  for (const { estadoCuenta, firma } of casos) {
    const datosAdjuntos = {
      firma,
      soportes: {
        cuenta_cobro_firmada: { url: "https://onedrive/firmado.pdf" },
        seguridad_social_firma: { url: "https://onedrive/seguridad.pdf" }
      }
    };
    const tx = createTransactionPool({
      id: 1,
      public_id: "cc-test",
      estado: estadoCuenta,
      datos_adjuntos: datosAdjuntos
    });
    const result = await __private.archivarIntentoFirmaCuenta({
      cuentaId: 1,
      expected: { hasPreviousFirma: true, request_id: "REQ-1", snapshot: firma },
      reserva: { requestId: "REQ-2", contractToken: "test" },
      estadoAprobado: "Aprobado",
      deps: { pool: tx.pool }
    });

    assert.equal(result.updated, false);
    assert.equal(result.raced, true);
    assert.equal(result.reason, "firma_finalizada");
    assert.deepEqual(result.adjuntosActuales.soportes, datosAdjuntos.soportes);
    assert.equal(tx.calls.some((call) => call.sql.includes("UPDATE cuenta_cobro")), false);

    const response = __private.buildRespuestaFirmaFinalizada({
      archivoResult: result,
      cuenta: { id: 1, public_id: "cc-test" },
      estadoAprobado: "Aprobado"
    });
    assert.equal(response.ok, true);
    assert.equal(response.ya_firmada, true);
    assert.equal(response.estado_cuenta, estadoCuenta);
  }
});

test("solo un cierre persistido o con documento habilita ya_firmada", () => {
  assert.equal(__private.esCierreFirmaFinalizada({ updated: true }), true);
  assert.equal(
    __private.esCierreFirmaFinalizada({
      updated: false,
      documentoFirmadoUrl: "https://onedrive/firmada.pdf"
    }),
    true
  );
  assert.equal(
    __private.esCierreFirmaFinalizada({
      updated: false,
      raceLost: true,
      reason: "firma_cambiada"
    }),
    false
  );
  assert.equal(
    __private.esCierreFirmaFinalizada({
      updated: false,
      reason: "autocierre_deshabilitado"
    }),
    false
  );
});

test("iniciar firma finalizada nunca reutiliza el enlace anterior, incluso con force", async () => {
  const cuenta = {
    id: 1,
    public_id: "cc-test",
    estado: "Pendiente",
    email: "consultor@test.local",
    datos_adjuntos: {
      firma: {
        estado: "pending",
        request_id: "REQ-1",
        contract_id: "CC-test-r1",
        url_firma: "https://firma.test/anterior",
        documento_firmado: { url: "https://onedrive/firmado.pdf" }
      }
    }
  };
  let generados = 0;
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(body) {
      response.body = body;
      return body;
    }
  };

  await iniciarFirmaCuenta(
    {
      params: { id: "cc-test" },
      body: { force: true },
      user: { rol: "Coordinador" }
    },
    res,
    {
      pool: {
        query: async () => ({ rows: [{ id: 1, created_by: 10 }] })
      },
      helpers: {
        isClickSignConfigured: () => true,
        getCuentaCobroPdfContext: async () => ({ cuenta, detalles: [] }),
        getCuentaCobroEstadoAprobado: async () => "Aprobado",
        generateCuentaCobroPdfBuffer: async () => {
          generados += 1;
          return Buffer.from("%PDF");
        }
      }
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ya_firmada, true);
  assert.equal(response.body.reused, undefined);
  assert.equal(response.body.documento_firmado_url, "https://onedrive/firmado.pdf");
  assert.equal(generados, 0);
  assert.equal(__private.esFirmaReutilizable(cuenta.datos_adjuntos.firma), false);
});

test("signed sin PDF ni estado aprobado puede archivarse y cerrarse", async () => {
  const firma = {
    estado: "signed",
    request_id: "REQ-1",
    documento_firmado: {}
  };
  const tx = createTransactionPool({
    id: 1,
    public_id: "cc-test",
    estado: "Pendiente",
    datos_adjuntos: { firma }
  });
  const result = await __private.archivarIntentoFirmaCuenta({
    cuentaId: 1,
    expected: { hasPreviousFirma: true, request_id: "REQ-1", snapshot: firma },
    reserva: { requestId: "REQ-2", contractToken: "test" },
    estadoAprobado: "Aprobado",
    deps: { pool: tx.pool }
  });

  assert.equal(result.updated, true);
  assert.equal(
    cierrePrivate.validarCuentaAntesDeCerrar({
      cuenta: {
        id: 1,
        estado: "En Firma",
        datos_adjuntos: { firma }
      },
      expectedRequestId: "REQ-1",
      estadoAprobado: "Aprobado",
      estadoEnFirma: "En Firma"
    }).ok,
    true
  );
  assert.equal(
    cierrePrivate.validarCuentaAntesDeCerrar({
      cuenta: {
        id: 1,
        estado: "En Firma",
        datos_adjuntos: {
          firma: {
            ...firma,
            documento_firmado: { url: "https://onedrive/firmado.pdf" }
          }
        }
      },
      expectedRequestId: "REQ-1",
      estadoAprobado: "Aprobado",
      estadoEnFirma: "En Firma"
    }).reason,
    "firma_finalizada"
  );
});

test("firma activa sin ids usa ausencia o snapshot exacto para reservar", () => {
  const placeholderCompetidor = {
    proveedor: "clicksign",
    estado: "starting",
    request_id: "REQ-COMPETIDOR"
  };
  assert.equal(
    __private.firmaActualCoincideConEsperada(
      placeholderCompetidor,
      { hasPreviousFirma: false, snapshot: null }
    ),
    false
  );

  const legacy = {
    proveedor: "clicksign",
    estado: "pending",
    url_firma: "https://firma.test/legacy"
  };
  assert.equal(
    __private.firmaActualCoincideConEsperada(
      legacy,
      { hasPreviousFirma: true, snapshot: legacy }
    ),
    true
  );
  assert.equal(
    __private.firmaActualCoincideConEsperada(
      placeholderCompetidor,
      { hasPreviousFirma: true, snapshot: legacy }
    ),
    false
  );

  const legacyConFecha = {
    estado: "pending",
    iniciado_en: "2026-07-22T10:00:00.000Z",
    url_firma: "https://firma.test/original"
  };
  assert.equal(
    __private.firmaActualCoincideConEsperada(
      {
        ...legacyConFecha,
        url_firma: "https://firma.test/competidor"
      },
      {
        hasPreviousFirma: true,
        iniciado_en: legacyConFecha.iniciado_en,
        snapshot: legacyConFecha
      }
    ),
    false
  );
});

test("completar placeholder distingue cuenta finalizada de reinicio concurrente", async () => {
  const firmaNueva = {
    estado: "pending",
    request_id: "REQ-NUEVA",
    contract_id: "CC-test-r1",
    signature_id: "SIG-1"
  };
  const casos = [
    {
      cuenta: {
        id: 1,
        public_id: "cc-test",
        estado: "Pendiente",
        datos_adjuntos: {
          firma: {
            request_id: "REQ-NUEVA",
            estado: "signed",
            documento_firmado: { url: "https://onedrive/firmado.pdf" }
          }
        }
      },
      reason: "firma_finalizada"
    },
    {
      cuenta: {
        id: 1,
        public_id: "cc-test",
        estado: "Pendiente",
        datos_adjuntos: {
          firma: {
            request_id: "REQ-COMPETIDOR",
            estado: "starting"
          }
        }
      },
      reason: "firma_cambiada"
    }
  ];

  for (const caso of casos) {
    const calls = [];
    let cancelaciones = 0;
    const result = await __private.completarPlaceholderFirmaCuenta({
      cuentaId: 1,
      firma: firmaNueva,
      estadoEnFirma: "En Firma",
      estadoAprobado: "Aprobado",
      deps: {
        pool: {
          query: async (sql, params) => {
            calls.push({ sql: String(sql), params });
            if (String(sql).includes("UPDATE cuenta_cobro")) return { rowCount: 0 };
            return { rows: [caso.cuenta] };
          }
        },
        cancelarFn: async () => {
          cancelaciones += 1;
          return { ok: true, cancelada: true };
        },
        logger: { warn: () => {} }
      }
    });

    assert.equal(result.updated, false);
    assert.equal(result.reason, caso.reason);
    assert.equal(cancelaciones, 1);
    assert.match(calls[0].sql, /datos_adjuntos->'firma'->>'estado' = 'starting'/);
    assert.match(calls[0].sql, /estado = \$5::tipo_estado_reporte/);
    assert.match(
      calls[0].sql,
      /COALESCE\(datos_adjuntos->'firma'->'documento_firmado'->>'url', ''\) = ''/
    );
    assert.equal(calls[0].params[4], "Pendiente");

    if (caso.reason === "firma_finalizada") {
      const response = __private.buildRespuestaFirmaFinalizada({
        archivoResult: result,
        cuenta: caso.cuenta,
        estadoAprobado: "Aprobado"
      });
      assert.equal(response.ya_firmada, true);
      assert.equal(response.documento_firmado_url, "https://onedrive/firmado.pdf");
    }
  }
});

test("firma pending vencida con URL no es reutilizable", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const firma = {
    estado: "pending",
    url_firma: "https://firma.test/vencida",
    iniciado_en: "2026-07-21T11:00:00.000Z"
  };
  const clasificacion = __private.clasificarIntentoFirmaCuenta(firma, now);

  assert.equal(__private.esFirmaReutilizable(firma, now), false);
  assert.equal(clasificacion.reutilizable, false);
  assert.equal(clasificacion.terminal, true);
});

test("diagnostico omite escritura si cambio la firma activa", async () => {
  const tx = createTransactionPool({
    id: 1,
    estado: "En Firma",
    datos_adjuntos: {
      firma: { estado: "pending", request_id: "REQ-ACTUAL" }
    }
  });

  const result = await persistirDiagnosticoFirmaCuenta({
    cuentaId: 1,
    estadoEnFirma: "En Firma",
    status: "rejected",
    resolution: { requestId: "REQ-ANTERIOR", normalizedStatus: "rejected" },
    expectedRequestId: "REQ-ANTERIOR",
    deps: { pool: tx.pool }
  });

  assert.equal(result.updated, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "firma_cambiada");
  assert.equal(tx.calls.some((call) => call.sql.includes("UPDATE cuenta_cobro")), false);
});

test("buscar seguridad social ClickSign conserva prevFirma y responde sin ReferenceError", async () => {
  const PDF_BUFFER = Buffer.from("%PDF-1.4\nseguridad\n");
  const cuenta = {
    id: 1,
    public_id: "cc-test",
    created_by: 10,
    datos_adjuntos: {
      firma: {
        request_id: "REQ-1",
        contract_id: "CC-test-r1",
        notificacion_proveedores: { enviada: true }
      },
      soportes: { carpeta: "cuentas/cc-test" }
    }
  };
  let queryCount = 0;
  const dbPool = {
    query: async (sql) => {
      queryCount += 1;
      const text = String(sql);
      if (text.includes("LEFT JOIN usuarios")) return { rows: [cuenta] };
      if (text.includes("SELECT id, datos_adjuntos")) return { rows: [cuenta] };
      if (text.includes("UPDATE cuenta_cobro")) return { rowCount: 1 };
      return { rows: [] };
    }
  };
  const req = {
    params: { id: "cc-test" },
    body: {},
    query: {},
    user: { id: 10 }
  };
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(body) {
      response.body = body;
      return body;
    }
  };

  await buscarSeguridadSocialClickSign(req, res, {
    pool: dbPool,
    helpers: {
      isClickSignConfigured: () => true,
      parseGraphErrorStatus: () => 0,
      resolveClickSignArtifacts: async () => ({
        extraFiles: [{
          kind: "seguridad_social_firma",
          fileName: "seguridad_social_firma.pdf",
          buffer: PDF_BUFFER
        }],
        catalogEntries: []
      }),
      sameResourceUrl: () => false,
      uploadClickSignExtraFilesToOneDrive: async () => ({
        carpeta: "cuentas/cc-test",
        uploaded: [{
          kind: "seguridad_social_firma",
          id: "archivo-1",
          nombre: "seguridad_social_firma.pdf",
          url: "https://onedrive/seguridad.pdf"
        }]
      }),
      notifySeguridadSocialProveedoresTardia: async () => ({ enviada: true })
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.notificacion_proveedores, { enviada: true });
  assert.equal(queryCount, 3);
});

test("hint webhook con identificadores distintos no modifica firma activa", async () => {
  const tx = createTransactionPool({
    id: 1,
    public_id: "cc-test",
    estado: "En Firma",
    datos_adjuntos: {
      firma: {
        estado: "pending",
        request_id: "REQ-B",
        contract_id: "CC-test-r2",
        signature_id: "SIG-B"
      }
    }
  });
  const warnings = [];

  const result = await clicksignPrivate.registrarHintWebhookCuentaCobro({
    publicIdFromEvent: "cc-test",
    requestId: "REQ-A",
    contractId: "CC-test-r1",
    signatureId: "SIG-A",
    deps: {
      pool: tx.pool,
      getCuentaCobroEstadoEnFirma: async () => "En Firma",
      logger: { warn: (...args) => warnings.push(args) }
    }
  });

  assert.equal(result.cuenta, null);
  assert.equal(result.mismatch, true);
  assert.equal(warnings.length, 1);
  assert.equal(tx.calls.some((call) => call.sql.includes("UPDATE cuenta_cobro")), false);
});

test("hint webhook se detiene si el UPDATE no encuentra cuenta accionable", async () => {
  const calls = [];
  const cuenta = {
    id: 1,
    public_id: "cc-test",
    estado: "Rechazado",
    datos_adjuntos: {
      firma: {
        estado: "pending",
        request_id: "REQ-1",
        contract_id: "CC-test-r1",
        signature_id: "SIG-1"
      }
    }
  };
  const client = {
    query: async (sql) => {
      const text = String(sql);
      calls.push(text);
      if (text.includes("SELECT") && text.includes("FROM cuenta_cobro cc")) {
        return { rows: [cuenta] };
      }
      if (text.includes("UPDATE cuenta_cobro")) return { rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  };

  const result = await clicksignPrivate.registrarHintWebhookCuentaCobro({
    publicIdFromEvent: "cc-test",
    requestId: "REQ-1",
    contractId: "CC-test-r1",
    signatureId: "SIG-1",
    deps: {
      pool: { connect: async () => client },
      getCuentaCobroEstadoEnFirma: async () => "En Firma",
      logger: { warn: () => {} }
    }
  });

  assert.equal(result.cuenta, null);
  assert.equal(result.estadoEnFirma, "En Firma");
  assert.equal(calls.filter((sql) => sql === "ROLLBACK").length, 1);
  assert.equal(calls.some((sql) => sql === "COMMIT"), false);
});

test("placeholder fallido solo actualiza el intento starting pendiente y sin documento", async () => {
  const calls = [];
  const warnings = [];
  const result = await __private.marcarPlaceholderFirmaFallida({
    cuentaId: 7,
    requestId: "REQ-STARTING",
    error: "fallo ClickSign",
    dbPool: {
      query: async (sql, params) => {
        calls.push({ sql: String(sql), params });
        return { rowCount: 0 };
      }
    },
    logger: { warn: (...args) => warnings.push(args) }
  });

  assert.equal(result.rowCount, 0);
  assert.equal(warnings.length, 1);
  assert.match(calls[0].sql, /datos_adjuntos->'firma'->>'estado' = 'starting'/);
  assert.match(calls[0].sql, /estado = \$4::tipo_estado_reporte/);
  assert.match(
    calls[0].sql,
    /COALESCE\(datos_adjuntos->'firma'->'documento_firmado'->>'url', ''\) = ''/
  );
  assert.equal(calls[0].params[1], 7);
  assert.equal(calls[0].params[2], "REQ-STARTING");
  assert.equal(calls[0].params[3], "Pendiente");
  assert.equal(JSON.parse(calls[0].params[0]).estado, "failed");
});

test("correo deshabilitado no envia y fallo de persistencia no se propaga", async (t) => {
  const previous = process.env.EMAIL_ENABLED;
  process.env.EMAIL_ENABLED = "false";
  t.after(() => {
    if (previous === undefined) delete process.env.EMAIL_ENABLED;
    else process.env.EMAIL_ENABLED = previous;
  });

  let sendCalls = 0;
  const notificacion = await __private.enviarNotificacionEnlaceFirma({
    destinatario: "consultor@test.local",
    payload: {},
    sendEmailFn: async () => {
      sendCalls += 1;
      return { ok: true };
    }
  });
  assert.equal(sendCalls, 0);
  assert.equal(notificacion.enviado, false);
  assert.equal(notificacion.error, "Envío de correo deshabilitado (EMAIL_ENABLED=false)");

  const persisted = await __private.persistirNotificacionEnlaceFirma({
    cuentaId: 1,
    requestId: "REQ-1",
    notificacion,
    dbPool: { query: async () => { throw new Error("DB no disponible"); } },
    logger: { warn: () => {} }
  });
  assert.equal(persisted, false);
});

test("iniciar verifica y cierra firma previa antes de crear otra", async () => {
  const cuenta = {
    id: 1,
    public_id: "cc-test",
    created_by: 10,
    estado: "En Firma",
    email: "consultor@test.local",
    datos_adjuntos: {
      firma: {
        estado: "signed",
        request_id: "REQ-1",
        contract_id: "CC-test-r1",
        documento_firmado: {}
      }
    }
  };
  let startCalls = 0;
  let cierreArgs = null;
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(body) {
      response.body = body;
      return body;
    }
  };

  await iniciarFirmaCuenta(
    {
      params: { id: "cc-test" },
      body: { force: true },
      user: { rol: "Coordinador" }
    },
    res,
    {
      pool: {
        query: async () => ({ rows: [{ id: 1, created_by: 10 }] })
      },
      helpers: {
        isClickSignConfigured: () => true,
        getCuentaCobroPdfContext: async () => ({ cuenta, detalles: [] }),
        getCuentaCobroEstadoAprobado: async () => "Aprobado",
        getCuentaCobroEstadoEnFirma: async () => "En Firma",
        generateCuentaCobroPdfBuffer: async () => {
          throw new Error("No debe generar otro PDF");
        },
        jsonRequest: async () => {
          startCalls += 1;
          throw new Error("No debe llamar START_SIGNATURE");
        }
      },
      resolverFirmaCuentaVerificada: async () => ({
        signed: true,
        requestId: "REQ-1",
        contractId: "CC-test-r1",
        signedPdf: {
          buffer: Buffer.from("%PDF-1.4\nfirmado\n"),
          fileName: "firmado.pdf"
        }
      }),
      cerrarCuentaCobroConFirmaResuelta: async (args) => {
        cierreArgs = args;
        return {
          updated: true,
          estadoCuenta: "Aprobado",
          documentoFirmado: { url: "https://onedrive/firmado.pdf" }
        };
      }
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ya_firmada, true);
  assert.equal(response.body.reconciliado, true);
  assert.equal(response.body.documento_firmado_url, "https://onedrive/firmado.pdf");
  assert.match(response.body.mensaje, /firma ya estaba completada/i);
  assert.equal(cierreArgs.origen, "inicio");
  assert.equal(startCalls, 0);
});

test("iniciar crea firma nueva solo cuando verify-first confirma que no esta firmada", async () => {
  const firmaAnterior = {
    estado: "signed",
    documento_firmado: {}
  };
  const cuenta = {
    id: 1,
    public_id: "cc-test",
    created_by: 10,
    estado: "En Firma",
    email: "consultor@test.local",
    nombre_usuario: "Consultor",
    datos_adjuntos: { firma: firmaAnterior }
  };
  const calls = [];
  const client = {
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("SELECT id, public_id, datos_adjuntos, estado")) {
        return { rows: [cuenta] };
      }
      if (text.includes("UPDATE cuenta_cobro")) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  };
  const dbPool = {
    connect: async () => client,
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("SELECT id, created_by")) {
        return { rows: [{ id: 1, created_by: 10 }] };
      }
      if (text.includes("UPDATE cuenta_cobro")) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
  let startCalls = 0;
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(body) {
      response.body = body;
      return body;
    }
  };

  await iniciarFirmaCuenta(
    {
      params: { id: "cc-test" },
      body: {},
      user: { rol: "Coordinador" }
    },
    res,
    {
      pool: dbPool,
      helpers: {
        isClickSignConfigured: () => true,
        getCuentaCobroPdfContext: async () => ({ cuenta, detalles: [] }),
        getCuentaCobroEstadoAprobado: async () => "Aprobado",
        getCuentaCobroEstadoEnFirma: async () => "En Firma",
        generateCuentaCobroPdfBuffer: async () => Buffer.from("%PDF-1.4\ncuenta\n"),
        sanitizePdfFileName: (name) => name,
        getRequestPublicBaseUrl: () => "",
        jsonRequest: async () => {
          startCalls += 1;
          return { data: { signature_id: "SIG-2", url: "https://firma.test/nueva" } };
        },
        buildClickSignUrl: () => "https://clicksign.test/start",
        buildClickSignAuthHeaders: () => ({}),
        extractClickSignSignatureId: (data) => data.signature_id,
        getClickSignLandingUrl: (data) => data.url,
        getGraphContext: () => ({}),
        sendEmailSafe: async () => ({ ok: true }),
        buildEmailLayout: () => "<p>Firma pendiente</p>",
        CLICKSIGN_USER: "usuario-clicksign",
        CLICKSIGN_SIGNATURE_CB_URL: "",
        CLICKSIGN_SIGNATORY_CB_URL: "",
        CLICKSIGN_SIGNATORY_EMAIL_CB_URL: "",
        CLICKSIGN_WEBHOOK_TOKEN: ""
      },
      resolverFirmaCuentaVerificada: async () => ({ signed: false }),
      cerrarCuentaCobroConFirmaResuelta: async () => {
        throw new Error("No debe intentar cerrar una firma no verificada");
      }
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.url_firma, "https://firma.test/nueva");
  assert.equal(startCalls, 1);
  assert.equal(calls.some(({ sql }) => sql.includes("firma_reseteos")), false);
  assert.equal(
    calls.some(({ params }) =>
      Array.isArray(params) &&
      params.some((value) => typeof value === "string" && value.includes('"firma_reseteos"'))
    ),
    true
  );
});

test("iniciar responde 503 si el estado En Firma no puede resolverse", async () => {
  const err = new Error("Enum no disponible");
  err.code = "ESTADO_ENUM_UNRESOLVED";
  let startCalls = 0;
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(body) {
      response.body = body;
      return body;
    }
  };

  await iniciarFirmaCuenta(
    {
      params: { id: "cc-test" },
      body: {},
      user: { rol: "Coordinador" }
    },
    res,
    {
      pool: {
        query: async () => ({ rows: [{ id: 1, created_by: 10 }] })
      },
      helpers: {
        isClickSignConfigured: () => true,
        getCuentaCobroPdfContext: async () => ({
          cuenta: {
            id: 1,
            public_id: "cc-test",
            estado: "Pendiente",
            email: "consultor@test.local",
            datos_adjuntos: {}
          },
          detalles: []
        }),
        getCuentaCobroEstadoAprobado: async () => "Aprobado",
        getCuentaCobroEstadoEnFirma: async () => {
          throw err;
        },
        jsonRequest: async () => {
          startCalls += 1;
        }
      }
    }
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "Estado de firma no disponible temporalmente.");
  assert.equal(startCalls, 0);
});

test("reiniciar resuelve ambos estados antes de consultar o cancelar en Click&Sign", async () => {
  const enumError = new Error("Enum Aprobado no disponible");
  enumError.code = "ESTADO_ENUM_UNRESOLVED";
  let resolverCalls = 0;
  let cancelCalls = 0;
  let connectCalls = 0;
  const sqlCalls = [];
  const { response, res } = createJsonResponse();

  await reiniciarFirmaCuenta(
    {
      params: { id: "cc-test" },
      body: {},
      user: { rol: "Coordinador" }
    },
    res,
    {
      pool: {
        query: async (sql) => {
          sqlCalls.push(String(sql));
          return {
            rows: [{
              id: 1,
              public_id: "cc-test",
              created_by: 10,
              datos_adjuntos: {
                firma: {
                  estado: "pending",
                  request_id: "REQ-1",
                  contract_id: "CC-test"
                }
              }
            }]
          };
        },
        connect: async () => {
          connectCalls += 1;
          throw new Error("No debe abrir transacción");
        }
      },
      helpers: {
        isClickSignConfigured: () => true,
        getCuentaCobroEstadoEnFirma: async () => "En_Firma",
        getCuentaCobroEstadoAprobado: async () => {
          throw enumError;
        },
        parseGraphErrorStatus: () => null
      },
      resolverFirmaCuentaVerificada: async () => {
        resolverCalls += 1;
        return { signed: false };
      },
      cancelarFirmaClickSign: async () => {
        cancelCalls += 1;
        return { ok: true };
      }
    }
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "Estado de firma no disponible temporalmente.");
  assert.equal(resolverCalls, 0);
  assert.equal(cancelCalls, 0);
  assert.equal(connectCalls, 0);
  assert.equal(sqlCalls.length, 1);
  assert.equal(sqlCalls.some((sql) => sql.includes("UPDATE cuenta_cobro")), false);
});

test("reiniciar devuelve ya_firmada al recuperar una firma válida", async () => {
  let cancelCalls = 0;
  const { response, res } = createJsonResponse();

  await reiniciarFirmaCuenta(
    {
      params: { id: "cc-test" },
      body: {},
      user: { rol: "Coordinador" }
    },
    res,
    {
      pool: {
        query: async () => ({
          rows: [{
            id: 1,
            public_id: "cc-test",
            created_by: 10,
            datos_adjuntos: {
              firma: {
                estado: "pending",
                request_id: "REQ-1",
                contract_id: "CC-test"
              }
            }
          }]
        })
      },
      helpers: {
        isClickSignConfigured: () => true,
        getCuentaCobroEstadoEnFirma: async () => "En_Firma",
        getCuentaCobroEstadoAprobado: async () => "Aprobado",
        parseGraphErrorStatus: () => null
      },
      resolverFirmaCuentaVerificada: async () => ({
        signed: true,
        requestId: "REQ-1"
      }),
      cerrarCuentaCobroConFirmaResuelta: async () => ({
        updated: true,
        estadoCuenta: "Aprobado",
        documentoFirmado: {
          url: "https://onedrive/firmada.pdf"
        }
      }),
      cancelarFirmaClickSign: async () => {
        cancelCalls += 1;
        return { ok: true };
      }
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ya_firmada, true);
  assert.equal(response.body.reconciliado, true);
  assert.equal(response.body.documento_firmado_url, "https://onedrive/firmada.pdf");
  assert.equal(cancelCalls, 0);
});

test("reiniciar devuelve error explícito si la firma verificada queda pendiente de cierre", async () => {
  const cuenta = {
    id: 1,
    public_id: "cc-test",
    estado: "En_Firma",
    created_by: 10,
    datos_adjuntos: {
      firma: {
        estado: "pending",
        request_id: "REQ-1",
        contract_id: "CC-test"
      }
    }
  };
  const casos = [
    {
      cierre: {
        updated: false,
        raceLost: true,
        reason: "firma_cambiada"
      },
      statusCode: 409
    },
    {
      cierre: {
        updated: false,
        raceLost: false,
        reason: "autocierre_deshabilitado"
      },
      statusCode: 503
    }
  ];

  for (const { cierre, statusCode } of casos) {
    const tx = createTransactionPool(cuenta);
    let cancelCalls = 0;
    const { response, res } = createJsonResponse();
    await reiniciarFirmaCuenta(
      {
        params: { id: "cc-test" },
        body: {},
        user: { rol: "Coordinador" }
      },
      res,
      {
        pool: {
          query: async () => ({ rows: [cuenta] }),
          connect: tx.pool.connect
        },
        helpers: {
          isClickSignConfigured: () => true,
          getCuentaCobroEstadoEnFirma: async () => "En_Firma",
          getCuentaCobroEstadoAprobado: async () => "Aprobado",
          parseGraphErrorStatus: () => null
        },
        resolverFirmaCuentaVerificada: async () => ({
          signed: true,
          requestId: "REQ-1"
        }),
        cerrarCuentaCobroConFirmaResuelta: async () => cierre,
        cancelarFirmaClickSign: async () => {
          cancelCalls += 1;
          return { ok: true };
        }
      }
    );

    assert.equal(response.statusCode, statusCode);
    assert.equal(response.body.codigo, "FIRMA_VERIFICADA_PENDIENTE_CIERRE");
    assert.equal(response.body.firma_verificada, true);
    assert.equal(response.body.ya_firmada, false);
    assert.equal(cancelCalls, 0);
  }
});

test("reiniciar no consulta ni cancela una cuenta ya finalizada", async () => {
  let resolverCalls = 0;
  let cancelCalls = 0;
  const { response, res } = createJsonResponse();

  await reiniciarFirmaCuenta(
    {
      params: { id: "cc-test" },
      body: {},
      user: { rol: "Coordinador" }
    },
    res,
    {
      pool: {
        query: async () => ({
          rows: [{
            id: 1,
            public_id: "cc-test",
            estado: "Aprobado",
            created_by: 10,
            datos_adjuntos: {
              firma: {
                estado: "starting",
                request_id: "REQ-1",
                iniciado_en: new Date().toISOString(),
                documento_firmado: {
                  url: "https://onedrive/firmada.pdf"
                }
              }
            }
          }]
        })
      },
      helpers: {
        isClickSignConfigured: () => true,
        getCuentaCobroEstadoEnFirma: async () => "En_Firma",
        getCuentaCobroEstadoAprobado: async () => "Aprobado",
        parseGraphErrorStatus: () => null
      },
      resolverFirmaCuentaVerificada: async () => {
        resolverCalls += 1;
        return { signed: false };
      },
      cancelarFirmaClickSign: async () => {
        cancelCalls += 1;
        return { ok: true };
      }
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ya_firmada, true);
  assert.equal(response.body.documento_firmado_url, "https://onedrive/firmada.pdf");
  assert.equal(resolverCalls, 0);
  assert.equal(cancelCalls, 0);
});

test("adjuntar resuelve Aprobado antes de subir, notificar o actualizar", async () => {
  const enumError = new Error("Enum Aprobado no disponible");
  enumError.code = "ESTADO_ENUM_UNRESOLVED";
  let uploadCalls = 0;
  let notifyCalls = 0;
  let connectCalls = 0;
  const sqlCalls = [];
  const { response, res } = createJsonResponse();

  await adjuntarFirmaCuenta(
    {
      params: { id: "cc-test" },
      body: { cuenta_pdf_base64: "pdf-base64" },
      headers: {},
      user: { rol: "Consultor" }
    },
    res,
    {
      onedriveEnabled: true,
      pool: {
        query: async (sql) => {
          sqlCalls.push(String(sql));
          return {
            rows: [{
              id: 1,
              public_id: "cc-test",
              estado: "En_Firma",
              created_by: 10,
              datos_adjuntos: {}
            }]
          };
        },
        connect: async () => {
          connectCalls += 1;
          throw new Error("No debe abrir transacción");
        }
      },
      helpers: {
        assertCuentaCobroOwnerAccess: async () => {},
        parsePdfDataUrl: () => Buffer.from("%PDF-1.4\nmanual\n"),
        isPdfBuffer: () => true,
        sanitizePdfFileName: (name) => name,
        uploadSignedPdfToOneDrive: async () => {
          uploadCalls += 1;
          throw new Error("No debe subir");
        },
        buildCuentaCobroEmailAttachments: () => [],
        notifyCuentaCobroFirmadaToProveedores: async () => {
          notifyCalls += 1;
          throw new Error("No debe notificar");
        },
        getGraphContext: () => ({}),
        getCuentaCobroEstadoAprobado: async () => {
          throw enumError;
        },
        parseGraphErrorStatus: () => null
      },
      logger: { warn: () => {} }
    }
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "Estado de firma no disponible temporalmente.");
  assert.equal(uploadCalls, 0);
  assert.equal(notifyCalls, 0);
  assert.equal(connectCalls, 0);
  assert.equal(sqlCalls.some((sql) => sql.includes("UPDATE cuenta_cobro")), false);
});

test("adjuntar no aprueba ni notifica si OneDrive no devuelve URL", async () => {
  let connectCalls = 0;
  let notifyCalls = 0;
  const { response, res } = createJsonResponse();

  await adjuntarFirmaCuenta(
    {
      params: { id: "cc-test" },
      body: { cuenta_pdf_base64: "pdf-base64" },
      headers: {},
      user: { rol: "Consultor" }
    },
    res,
    {
      onedriveEnabled: true,
      pool: {
        query: async () => ({
          rows: [{
            id: 1,
            public_id: "cc-test",
            estado: "En_Firma",
            created_by: 10,
            datos_adjuntos: {}
          }]
        }),
        connect: async () => {
          connectCalls += 1;
          throw new Error("No debe abrir transacción");
        }
      },
      helpers: {
        assertCuentaCobroOwnerAccess: async () => {},
        parsePdfDataUrl: () => Buffer.from("%PDF-1.4\nmanual\n"),
        isPdfBuffer: () => true,
        sanitizePdfFileName: (name) => name,
        uploadSignedPdfToOneDrive: async () => ({
          carpeta: "Cuentas/cc-test",
          archivo: {
            id: "PDF-1",
            nombre: "firmada.pdf",
            url: ""
          }
        }),
        buildCuentaCobroEmailAttachments: () => [],
        notifyCuentaCobroFirmadaToProveedores: async () => {
          notifyCalls += 1;
        },
        getGraphContext: () => ({}),
        getCuentaCobroEstadoAprobado: async () => "Aprobado",
        parseGraphErrorStatus: () => null
      },
      logger: { warn: () => {} }
    }
  );

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "OneDrive no devolvió un enlace válido para el PDF firmado.");
  assert.equal(connectCalls, 0);
  assert.equal(notifyCalls, 0);
});

test("adjuntar persiste bajo lock antes de notificar y conserva soportes concurrentes", async () => {
  const initialCuenta = {
    id: 1,
    public_id: "cc-test",
    estado: "En_Firma",
    created_by: 10,
    nombre_usuario: "Consultor",
    email: "consultor@test.local",
    datos_adjuntos: {
      firma: {
        estado: "pending",
        request_id: "REQ-1"
      },
      soportes: {}
    }
  };
  const lockedCuenta = {
    ...initialCuenta,
    datos_adjuntos: {
      ...initialCuenta.datos_adjuntos,
      soportes: {
        seguridad_social: {
          id: "SS-1",
          nombre: "SeguridadSocial.pdf",
          url: "https://onedrive/seguridad.pdf"
        }
      }
    }
  };
  const events = [];
  let warnCalls = 0;
  let persistedAdjuntos = null;
  const client = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        events.push(text);
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FOR UPDATE")) {
        events.push("LOCK");
        return { rows: [lockedCuenta], rowCount: 1 };
      }
      if (text.includes("UPDATE cuenta_cobro")) {
        events.push("UPDATE");
        persistedAdjuntos = JSON.parse(params[0]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`SQL inesperado: ${text}`);
    },
    release: () => {
      events.push("RELEASE");
    }
  };
  const { response, res } = createJsonResponse();

  await adjuntarFirmaCuenta(
    {
      params: { id: "cc-test" },
      body: {
        cuenta_pdf_base64: "pdf-base64",
        cuenta_pdf_nombre: "firmada.pdf"
      },
      headers: {},
      user: { rol: "Consultor" }
    },
    res,
    {
      onedriveEnabled: true,
      pool: {
        query: async () => ({ rows: [initialCuenta] }),
        connect: async () => client
      },
      helpers: {
        assertCuentaCobroOwnerAccess: async () => {},
        parsePdfDataUrl: () => Buffer.from("%PDF-1.4\nmanual\n"),
        isPdfBuffer: () => true,
        sanitizePdfFileName: (name) => name,
        uploadSignedPdfToOneDrive: async (_cuenta, _buffer, fileName) => {
          events.push("UPLOAD");
          assert.match(fileName, /^firmada_[a-f0-9]{12}\.pdf$/);
          return {
            carpeta: "Cuentas/cc-test",
            archivo: {
              id: "PDF-1",
              nombre: fileName,
              url: "https://onedrive/firmada.pdf"
            }
          };
        },
        buildCuentaCobroEmailAttachments: () => [],
        notifyCuentaCobroFirmadaToProveedores: async () => {
          events.push("NOTIFY");
          throw new Error("Correo temporalmente no disponible");
        },
        getGraphContext: () => ({}),
        getCuentaCobroEstadoAprobado: async () => {
          events.push("ESTADO");
          return "Aprobado";
        },
        parseGraphErrorStatus: () => null
      },
      logger: {
        warn: () => {
          warnCalls += 1;
        }
      }
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.documento_firmado_url, "https://onedrive/firmada.pdf");
  assert.equal(response.body.notificacion_proveedores, null);
  assert.equal(warnCalls, 1);
  assert.equal(persistedAdjuntos.soportes.seguridad_social.id, "SS-1");
  assert.equal(persistedAdjuntos.firma.documento_firmado.id, "PDF-1");
  assert.deepEqual(events, [
    "ESTADO",
    "UPLOAD",
    "BEGIN",
    "LOCK",
    "UPDATE",
    "COMMIT",
    "RELEASE",
    "NOTIFY"
  ]);
});

test("adjuntar no pisa firma ni estado que cambiaron durante la carga", async () => {
  const initialCuenta = {
    id: 1,
    public_id: "cc-test",
    estado: "En_Firma",
    created_by: 10,
    datos_adjuntos: {
      firma: {
        estado: "pending",
        request_id: "REQ-1"
      }
    }
  };
  const escenarios = [
    {
      nombre: "firma",
      lockedCuenta: {
        ...initialCuenta,
        datos_adjuntos: {
          firma: {
            estado: "pending",
            request_id: "REQ-2"
          }
        }
      }
    },
    {
      nombre: "estado",
      lockedCuenta: {
        ...initialCuenta,
        estado: "Rechazado"
      }
    }
  ];

  for (const { nombre, lockedCuenta } of escenarios) {
    let updateCalls = 0;
    let notifyCalls = 0;
    const client = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FOR UPDATE")) return { rows: [lockedCuenta], rowCount: 1 };
        if (text.includes("UPDATE cuenta_cobro")) {
          updateCalls += 1;
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {}
    };
    const { response, res } = createJsonResponse();

    await adjuntarFirmaCuenta(
      {
        params: { id: "cc-test" },
        body: { cuenta_pdf_base64: "pdf-base64" },
        headers: {},
        user: { rol: "Consultor" }
      },
      res,
      {
        onedriveEnabled: true,
        pool: {
          query: async () => ({ rows: [initialCuenta] }),
          connect: async () => client
        },
        helpers: {
          assertCuentaCobroOwnerAccess: async () => {},
          parsePdfDataUrl: () => Buffer.from("%PDF-1.4\nmanual\n"),
          isPdfBuffer: () => true,
          sanitizePdfFileName: (name) => name,
          uploadSignedPdfToOneDrive: async () => ({
            carpeta: "Cuentas/cc-test",
            archivo: {
              id: "PDF-1",
              nombre: "firmada.pdf",
              url: "https://onedrive/firmada.pdf"
            }
          }),
          buildCuentaCobroEmailAttachments: () => [],
          notifyCuentaCobroFirmadaToProveedores: async () => {
            notifyCalls += 1;
          },
          getGraphContext: () => ({}),
          getCuentaCobroEstadoAprobado: async () => "Aprobado",
          parseGraphErrorStatus: () => null
        },
        logger: { warn: () => {} }
      }
    );

    assert.equal(response.statusCode, 409, nombre);
    assert.equal(updateCalls, 0, nombre);
    assert.equal(notifyCalls, 0, nombre);
  }
});
