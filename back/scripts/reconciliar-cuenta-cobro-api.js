const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const jwt = require("jsonwebtoken");

const envFile = process.env.NODE_ENV === "production" ? ".env_produccion" : ".env";
require("dotenv").config({ path: path.resolve(process.cwd(), envFile) });

const { pool } = require("../src/db");

function parseArgs(argv) {
  const args = {
    cuenta: "",
    signatureId: "",
    apiBase: `http://127.0.0.1:${process.env.PORT || process.env.BACK_PORT || 4000}`
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cuenta" && argv[index + 1]) {
      args.cuenta = String(argv[++index]).trim();
    } else if (arg === "--signature-id" && argv[index + 1]) {
      args.signatureId = String(argv[++index]).trim();
    } else if (arg === "--api-base" && argv[index + 1]) {
      args.apiBase = String(argv[++index]).trim().replace(/\/+$/, "");
    } else {
      throw new Error(`Argumento no reconocido o incompleto: ${arg}`);
    }
  }

  if (!/^[0-9a-f-]{36}$/i.test(args.cuenta)) {
    throw new Error("Debe indicar --cuenta con el public_id UUID.");
  }
  if (args.signatureId && !/^\d+$/.test(args.signatureId)) {
    throw new Error("--signature-id debe contener solo números.");
  }
  return args;
}

function postJson(url, token, body = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": payload.length
        },
        timeout: 120000
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = {};
          try {
            data = JSON.parse(raw || "{}");
          } catch (_) {
            data = { raw };
          }
          resolve({ status: Number(response.statusCode || 0), data });
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("Timeout llamando la API interna.")));
    request.on("error", reject);
    request.end(payload);
  });
}

async function getCuenta(publicId) {
  const result = await pool.query(
    `SELECT cc.id, cc.public_id, cc.estado, cc.datos_adjuntos,
            u.nombre_usuario, u.email
       FROM cuenta_cobro cc
       LEFT JOIN usuarios u ON u.id = cc.created_by
      WHERE cc.public_id = $1
      LIMIT 1`,
    [publicId]
  );
  return result.rows[0] || null;
}

async function getAdminActivo() {
  const result = await pool.query(
    `SELECT u.id, u.public_id, u.nombre_usuario, u.email,
            u.rol_usuario_id, u.tipo_consultor, r.titulo AS rol
       FROM usuarios u
       JOIN roles r ON r.id = u.rol_usuario_id
      WHERE u.activo = true
        AND LOWER(BTRIM(r.titulo)) = 'administrador'
      ORDER BY u.id
      LIMIT 1`
  );
  return result.rows[0] || null;
}

async function corregirSignatureId(publicId, signatureId) {
  if (!signatureId) return;
  const result = await pool.query(
    `UPDATE cuenta_cobro
        SET datos_adjuntos = jsonb_set(
              jsonb_set(
                COALESCE(datos_adjuntos, '{}'::jsonb),
                '{firma,signature_id}',
                to_jsonb($1::text),
                true
              ),
              '{firma,recuperacion_consola}',
              jsonb_build_object(
                'ejecutada_en', CURRENT_TIMESTAMP,
                'signature_id_anterior', datos_adjuntos->'firma'->>'signature_id',
                'signature_id_corregido', $1::text,
                'origen', 'script_api'
              ),
              true
            )
      WHERE public_id = $2
        AND COALESCE(datos_adjuntos->'firma'->'documento_firmado'->>'url', '') = ''
      RETURNING public_id`,
    [signatureId, publicId]
  );
  if (result.rowCount !== 1) {
    throw new Error("No se corrigió signature_id: la cuenta no existe o ya tiene PDF firmado.");
  }
}

function buildToken(admin) {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) throw new Error("JWT_SECRET no está disponible en la consola del backend.");
  return jwt.sign(
    {
      id: admin.id,
      public_id: admin.public_id || null,
      nombre_usuario: admin.nombre_usuario,
      email: admin.email,
      rol: admin.rol,
      rol_usuario_id: admin.rol_usuario_id,
      tipo_consultor: admin.tipo_consultor || null,
      uso: "reconciliacion_consola"
    },
    secret,
    { expiresIn: "5m" }
  );
}

function resumir(cuenta) {
  const adjuntos = cuenta?.datos_adjuntos || {};
  const firma = adjuntos.firma || {};
  const soportes = adjuntos.soportes || {};
  const notificacion = firma.notificacion_proveedores || {};
  return {
    cuenta_id: cuenta?.public_id || null,
    estado: cuenta?.estado || null,
    firma_estado: firma.estado || null,
    signature_id: firma.signature_id || null,
    documento_firmado_url:
      firma.documento_firmado?.url ||
      soportes.cuenta_cobro_firmada?.url ||
      null,
    seguridad_social_url: soportes.seguridad_social?.url || null,
    correo_proveedores_enviado: notificacion.enviada === true,
    correo_proveedores_destinatario: notificacion.destinatario || null,
    correo_proveedores_error: notificacion.error || null
  };
}

async function main() {
  const args = parseArgs(process.argv);
  let cuenta = await getCuenta(args.cuenta);
  if (!cuenta) throw new Error("Cuenta de cobro no encontrada.");

  await corregirSignatureId(args.cuenta, args.signatureId);
  if (args.signatureId) cuenta = await getCuenta(args.cuenta);

  const admin = await getAdminActivo();
  if (!admin) throw new Error("No existe un usuario Administrador activo para la llamada interna.");
  const token = buildToken(admin);

  const reconciliacion = await postJson(
    `${args.apiBase}/cuentas-cobro/${encodeURIComponent(args.cuenta)}/firma/reconciliar`,
    token,
    args.signatureId ? { signature_id: args.signatureId } : {}
  );
  console.log("RECONCILIACION", JSON.stringify(reconciliacion, null, 2));
  if (reconciliacion.status < 200 || reconciliacion.status >= 300) {
    throw new Error(`La API de reconciliación respondió HTTP ${reconciliacion.status}.`);
  }

  cuenta = await getCuenta(args.cuenta);
  let estado = resumir(cuenta);

  if (estado.documento_firmado_url && !estado.seguridad_social_url) {
    const seguridad = await postJson(
      `${args.apiBase}/cuentas-cobro/${encodeURIComponent(args.cuenta)}/seguridad-social/buscar-clicksign`,
      token,
      args.signatureId ? { signature_id: args.signatureId } : {}
    );
    console.log("SEGURIDAD_SOCIAL", JSON.stringify(seguridad, null, 2));
    if (seguridad.status < 200 || seguridad.status >= 300) {
      throw new Error(`La búsqueda de seguridad social respondió HTTP ${seguridad.status}.`);
    }
    cuenta = await getCuenta(args.cuenta);
    estado = resumir(cuenta);
  }

  console.log("RESULTADO", JSON.stringify(estado, null, 2));
  if (
    !estado.documento_firmado_url ||
    !estado.seguridad_social_url ||
    !estado.correo_proveedores_enviado
  ) {
    process.exitCode = 2;
  }
}

main()
  .catch((error) => {
    console.error("ERROR", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
