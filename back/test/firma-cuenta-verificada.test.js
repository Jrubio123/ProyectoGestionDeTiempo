const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createClickSignFirmaVerificadaService
} = require("../src/services/clicksign-firma-verificada.service");
const {
  cerrarCuentaCobroConFirmaResuelta,
  cuentasFirmaAutocierreHabilitado
} = require("../src/services/cuenta-cobro-cierre.service");
const {
  __private
} = require("../src/services/cuentas-cobro.service");

const PDF_BUFFER = Buffer.from("%PDF-1.4\nfirmado\n");

function cuentaBase() {
  return {
    id: 1,
    public_id: "cc-test",
    created_by: 10,
    fecha_correspondiente: "2026-07-01",
    created_at: "2026-07-01T00:00:00Z",
    nombre_usuario: "Consultor",
    email: "consultor@test.local"
  };
}

function adjuntosFirma(extra = {}) {
  return {
    firma: {
      estado: "pending",
      request_id: "REQ-1",
      contract_id: "CC-test",
      signature_id: "123",
      ...extra
    }
  };
}

function createHttpMock({ statusBody = {}, fileListBody = {}, fileBuffer = null } = {}) {
  const calls = {
    json: [],
    binary: []
  };
  return {
    calls,
    httpClient: {
      jsonRequest: async ({ url, body }) => {
        calls.json.push({ url, body });
        if (url.includes("get_signature_status")) return statusBody;
        if (url.includes("get_signature")) return statusBody;
        if (url.includes("get_file_list")) {
          if (typeof fileListBody === "function") return fileListBody(body);
          return fileListBody;
        }
        return {};
      },
      binaryRequest: async ({ url, body }) => {
        calls.binary.push({ url, body });
        if (fileBuffer instanceof Error) throw fileBuffer;
        return { buffer: fileBuffer || Buffer.from("no-pdf") };
      }
    }
  };
}

function createClosureDeps({ lockedEstado = "En Firma", lockedUrl = "", updateRowCount = 1 } = {}) {
  const calls = {
    upload: 0,
    notify: 0,
    queries: []
  };
  const client = {
    query: async (sql, params) => {
      calls.queries.push({ sql, params });
      const text = String(sql);
      if (text.includes("SELECT id, public_id, estado, datos_adjuntos")) {
        return {
          rows: [
            {
              id: 1,
              public_id: "cc-test",
              estado: lockedEstado,
              datos_adjuntos: {
                firma: {
                  estado: "pending",
                  documento_firmado: lockedUrl ? { url: lockedUrl } : {}
                },
                soportes: {
                  carpeta: "base",
                  seguridad_social: { url: "seguridad.pdf" },
                  cuenta_cobro_original: { url: "original.pdf" }
                }
              }
            }
          ]
        };
      }
      if (text.includes("UPDATE cuenta_cobro")) return { rowCount: updateRowCount };
      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  };
  return {
    calls,
    deps: {
      pool: { connect: async () => client },
      isPdfBuffer: (buffer) => Buffer.isBuffer(buffer) && buffer.slice(0, 4).toString("utf8") === "%PDF",
      buildCuentaCobroEmailAttachments: () => [{ filename: "firmado.pdf", content: PDF_BUFFER }],
      uploadSignedPdfToOneDrive: async () => {
        calls.upload += 1;
        return {
          carpeta: "carpeta",
          archivo: { id: "onedrive-id", nombre: "firmado.pdf", url: "https://onedrive/firmado.pdf" }
        };
      },
      uploadClickSignExtraFilesToOneDrive: async () => ({ uploaded: [] }),
      sameResourceUrl: (a, b) => String(a || "") === String(b || ""),
      notifyCuentaCobroFirmadaToProveedores: async () => {
        calls.notify += 1;
        return { enviada: true };
      },
      getGraphContext: () => null,
      getCuentaCobroEstadoAprobado: async () => "Aprobado",
      getCuentaCobroEstadoEnFirma: async () => "En Firma",
      logger: { warn: () => {}, error: () => {} }
    }
  };
}

test("ready + catalogo con PDF original no firma ni cierra", async () => {
  const mock = createHttpMock({
    statusBody: { signature_status: "ready", signature_id: "123" },
    fileListBody: {
      file_list: {
        files: [{ file_id: "orig", file_group: "ORIGINAL", filename: "CuentaCobro_original.pdf" }]
      }
    },
    fileBuffer: PDF_BUFFER
  });
  const service = createClickSignFirmaVerificadaService({
    httpClient: mock.httpClient,
    config: { signedFileGroups: "SIGNED", user: "u", apiKey: "k", apiBase: "https://mock" },
    logger: { error: () => {} }
  });

  const resolution = await service.resolverFirmaCuentaVerificada({
    cuenta: cuentaBase(),
    prevAdjuntos: adjuntosFirma()
  });

  assert.equal(resolution.signed, false);
  assert.equal(resolution.normalizedStatus, "pending");
  assert.equal(mock.calls.binary.length, 0);
});

test("status Success sin signature_status oficial queda pending", async () => {
  const mock = createHttpMock({ statusBody: { status: "Success" } });
  const service = createClickSignFirmaVerificadaService({
    httpClient: mock.httpClient,
    config: { signedFileGroups: "SIGNED", user: "u", apiKey: "k", apiBase: "https://mock" }
  });

  const status = await service.consultarSignatureStatusOficial({
    signatureId: "123",
    requestId: "REQ-1",
    contractId: "CC-test"
  });

  assert.equal(status.status, "pending");
  assert.equal(status.rawStatus, "");
});

test("signed sin archivos permitidos no cierra", async () => {
  const mock = createHttpMock({
    statusBody: { signature_status: "signed", signature_id: "123" },
    fileListBody: { file_list: { files: [] } }
  });
  const service = createClickSignFirmaVerificadaService({
    httpClient: mock.httpClient,
    config: { signedFileGroups: "SIGNED", user: "u", apiKey: "k", apiBase: "https://mock" }
  });

  const resolution = await service.resolverFirmaCuentaVerificada({
    cuenta: cuentaBase(),
    prevAdjuntos: adjuntosFirma()
  });

  assert.equal(resolution.signed, false);
  assert.equal(resolution.reason, "firmado_sin_pdf_en_grupos");
});

test("signed + PDF valido en grupo SIGNED cierra y notifica", async (t) => {
  const prev = process.env.CUENTAS_FIRMA_AUTOCIERRE;
  process.env.CUENTAS_FIRMA_AUTOCIERRE = "true";
  t.after(() => {
    process.env.CUENTAS_FIRMA_AUTOCIERRE = prev;
  });

  const mock = createHttpMock({
    statusBody: { signature_status: "signed", signature_id: "123" },
    fileListBody: {
      file_list: {
        files: [{ file_id: "signed-file", file_group: "SIGNED", filename: "CuentaCobroFirmada.pdf" }]
      }
    },
    fileBuffer: PDF_BUFFER
  });
  const service = createClickSignFirmaVerificadaService({
    httpClient: mock.httpClient,
    config: { signedFileGroups: "SIGNED", user: "u", apiKey: "k", apiBase: "https://mock" }
  });
  const resolution = await service.resolverFirmaCuentaVerificada({
    cuenta: cuentaBase(),
    prevAdjuntos: adjuntosFirma()
  });
  const { deps, calls } = createClosureDeps();

  const cierre = await cerrarCuentaCobroConFirmaResuelta({
    cuenta: cuentaBase(),
    resolution,
    deps
  });

  assert.equal(resolution.signed, true);
  assert.equal(cierre.updated, true);
  assert.equal(calls.upload, 1);
  assert.equal(calls.notify, 1);
});

test("autocierre off no sube, no actualiza y no notifica", async (t) => {
  const prev = process.env.CUENTAS_FIRMA_AUTOCIERRE;
  process.env.CUENTAS_FIRMA_AUTOCIERRE = "";
  t.after(() => {
    process.env.CUENTAS_FIRMA_AUTOCIERRE = prev;
  });

  const cierre = await cerrarCuentaCobroConFirmaResuelta({
    cuenta: cuentaBase(),
    resolution: {
      signed: true,
      signedPdf: { buffer: PDF_BUFFER, fileName: "firmado.pdf" }
    },
    deps: {
      uploadSignedPdfToOneDrive: async () => {
        throw new Error("no debe subir");
      }
    }
  });

  assert.equal(cuentasFirmaAutocierreHabilitado(), false);
  assert.equal(cierre.updated, false);
  assert.equal(cierre.reason, "autocierre_deshabilitado");
});

test("allowlist vacia o desconocida nunca firma", async () => {
  for (const signedFileGroups of ["", "SIGNED,ORIGINAL"]) {
    const mock = createHttpMock({
      statusBody: { signature_status: "signed", signature_id: "123" },
      fileListBody: {
        file_list: {
          files: [{ file_id: "signed-file", file_group: "SIGNED", filename: "CuentaCobroFirmada.pdf" }]
        }
      },
      fileBuffer: PDF_BUFFER
    });
    const service = createClickSignFirmaVerificadaService({
      httpClient: mock.httpClient,
      config: { signedFileGroups, user: "u", apiKey: "k", apiBase: "https://mock" },
      logger: { error: () => {} }
    });
    const resolution = await service.resolverFirmaCuentaVerificada({
      cuenta: cuentaBase(),
      prevAdjuntos: adjuntosFirma()
    });
    assert.equal(resolution.signed, false);
    assert.equal(resolution.reason, "allowlist_invalida");
  }
});

test("raceLost no duplica notificacion", async (t) => {
  const prev = process.env.CUENTAS_FIRMA_AUTOCIERRE;
  process.env.CUENTAS_FIRMA_AUTOCIERRE = "true";
  t.after(() => {
    process.env.CUENTAS_FIRMA_AUTOCIERRE = prev;
  });

  const { deps, calls } = createClosureDeps({ lockedEstado: "Aprobado", lockedUrl: "https://onedrive/existente.pdf" });
  const cierre = await cerrarCuentaCobroConFirmaResuelta({
    cuenta: cuentaBase(),
    resolution: {
      signed: true,
      rawStatus: "signed",
      requestId: "REQ-1",
      contractId: "CC-test",
      signatureId: "123",
      signedPdf: { buffer: PDF_BUFFER, fileName: "firmado.pdf", source: "file_group_verificado" }
    },
    deps
  });

  assert.equal(cierre.updated, false);
  assert.equal(cierre.raceLost, true);
  assert.equal(calls.notify, 0);
});

test("reinicio aborta si cancelacion falla y override admin audita omision", async () => {
  const fallo = await __private.resolverCancelacionIntentoFirma({
    firma: { signature_id: "123", request_id: "REQ-1", contract_id: "CC-test" },
    req: { body: {}, user: { rol: "Coordinador", id: "coord-1" } },
    cancelarFn: async () => ({ ok: false, reason: "transporte", resumen: { message: "ECONNRESET" } })
  });

  assert.equal(fallo.ok, false);
  assert.equal(fallo.statusCode, 502);

  const override = await __private.resolverCancelacionIntentoFirma({
    firma: { signature_id: "123", request_id: "REQ-1", contract_id: "CC-test" },
    req: {
      body: { forzar_sin_cancelacion: true },
      user: { rol: "Administrador", id: "admin-1", email: "admin@test.local" }
    },
    cancelarFn: async () => {
      throw new Error("no debe llamar red");
    }
  });
  const archivada = __private.buildFirmaArchivada(
    { request_id: "REQ-1", contract_id: "CC-test", signature_id: "123" },
    { cancelacionResult: override, motivo: "reinicio manual" }
  );

  assert.equal(override.ok, true);
  assert.equal(override.omitida, true);
  assert.equal(archivada.no_reconciliar, true);
  assert.equal(archivada.cancelada_en_clicksign, false);
  assert.equal(archivada.cancelacion_omitida_por.usuario_id, "admin-1");
});

test("webhook generico con cuenta delega al verificador estricto sin pipeline legacy", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "clicksign.service.js"),
    "utf8"
  );
  const start = source.indexOf("async function processSignatureEvent");
  const end = source.indexOf("module.exports", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const fn = source.slice(start, end);

  assert.match(fn, /await rollbackIfOpen\(\);\s*await procesarWebhookCuentaCobroEstricto\(/);
  assert.doesNotMatch(fn, /allowCatalogFallback:\s*true/);
  assert.doesNotMatch(fn, /resolveClickSignArtifacts\s*\(/);
  assert.doesNotMatch(fn, /uploadSignedPdfToOneDrive\s*\(/);
  assert.doesNotMatch(fn, /notifyCuentaCobroFirmadaToProveedores\s*\(/);
});
