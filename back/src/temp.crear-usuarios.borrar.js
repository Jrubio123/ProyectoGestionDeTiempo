// ⚠️ TEMPORAL - BORRAR DESPUÉS DE IMPLEMENTAR VISTA DE USUARIOS
const https = require("https");
const { getGraphAccessToken } = require("./email");

const TEMP_KEY = "TEMP_CREATE_USER_2026";
const ROLES_PERMITIDOS = ["Administrador", "Talento Humano"];

function textOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function parseOptionalId(value, fieldName) {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { error: `${fieldName} debe ser un ID válido` };
  }
  return { value: parsed };
}

function normalizeEnumKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function parseTipoPersona(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null };
  const normalized = normalizeEnumKey(raw);
  if (normalized === "natural") return { value: "Natural" };
  if (normalized === "juridica") return { value: "Jurídica" };
  return { error: "tipo_persona debe ser Natural o Jurídica" };
}

function parseTipoConsultor(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null };
  const normalized = normalizeEnumKey(raw);
  if (normalized === "principal") return { value: "Principal" };
  if (normalized === "asociado") return { value: "Asociado" };
  return { error: "tipo_consultor_enum debe ser Principal o Asociado" };
}

function validateTempKey(req, res, next) {
  const providedKey = req.headers["x-temp-key"];
  if (providedKey !== undefined && String(providedKey).trim() !== TEMP_KEY) {
    return res.status(403).json({ error: "x-temp-key inválido" });
  }
  return next();
}

async function validateCatalogId(pool, table, id, errorMessage) {
  if (!id) return null;
  const result = await pool.query(
    `SELECT id FROM ${table} WHERE id = $1 AND activo = true LIMIT 1`,
    [id]
  );
  return result.rows.length ? null : errorMessage;
}

function graphGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "graph.microsoft.com",
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ConsistencyLevel: "eventual"
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Graph error ${res.statusCode}: ${data}`));
          }
          try {
            return resolve(JSON.parse(data || "{}"));
          } catch (err) {
            return resolve({});
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function normalizeGraphNextPath(nextLink) {
  if (!nextLink) return null;
  try {
    const url = new URL(nextLink);
    return `${url.pathname}${url.search}`;
  } catch (err) {
    return null;
  }
}

function escapeODataText(value) {
  return String(value || "").trim().replace(/'/g, "''");
}

function mapGraphUser(user) {
  const email = String(user?.mail || user?.userPrincipalName || "").trim().toLowerCase();
  if (!email) return null;
  return {
    azure_oid: user.id || null,
    nombre_usuario: user.displayName || email,
    email,
    telefono: user.mobilePhone || user.businessPhones?.[0] || "",
    activo_tenant: user.accountEnabled !== false
  };
}

module.exports = function registerTempCrearUsuariosRoutes({ app, pool, requireAccess }) {
  const access = requireAccess({ roles: ROLES_PERMITIDOS });

  app.get("/temp/catalogos/roles", validateTempKey, access, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, titulo
        FROM roles
        WHERE activo = true
        ORDER BY titulo ASC
      `);
      return res.json(result.rows);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Error al obtener roles" });
    }
  });

  app.get("/temp/catalogos/bancos", validateTempKey, access, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, titulo AS nombre
        FROM bancos
        WHERE activo = true
        ORDER BY titulo ASC
      `);
      return res.json(result.rows);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Error al obtener bancos" });
    }
  });

  app.get("/temp/catalogos/tipo-cuenta", validateTempKey, access, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, titulo
        FROM tipo_cuenta_bancaria
        WHERE activo = true
        ORDER BY titulo ASC
      `);
      return res.json(result.rows);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Error al obtener tipos de cuenta" });
    }
  });

  app.get("/temp/catalogos/documentos", validateTempKey, access, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, titulo
        FROM documento_identidad
        WHERE activo = true
        ORDER BY titulo ASC
      `);
      return res.json(result.rows);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Error al obtener documentos" });
    }
  });

  app.get("/temp/usuario", validateTempKey, access, async (req, res) => {
    try {
      const email = normalizeEmail(req.query?.email);
      const azureOid = textOrNull(req.query?.azure_oid);
      if (!email && !azureOid) return res.status(400).json({ error: "email o azure_oid es obligatorio" });

      const result = await pool.query(
        `
        SELECT
          public_id,
          azure_oid,
          nombre_usuario,
          email,
          rol_usuario_id,
          tipo_documento_id,
          banco_id,
          tipo_cuenta_id,
          nro_cuenta_bancaria,
          tipo_persona::text AS tipo_persona,
          tipo_consultor::text AS tipo_consultor_enum,
          ciudad,
          telefono,
          cedula,
          direccion,
          activo
        FROM usuarios
        WHERE ($1::text IS NOT NULL AND LOWER(email) = LOWER($1))
           OR ($2::text IS NOT NULL AND azure_oid = $2)
        LIMIT 1
        `,
        [email || null, azureOid]
      );

      if (result.rows.length === 0) return res.json({ exists: false });
      return res.json({ exists: true, usuario: result.rows[0] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Error al buscar usuario" });
    }
  });

  app.get("/temp/tenant/usuarios", validateTempKey, access, async (req, res) => {
    try {
      const token = await getGraphAccessToken();
      const search = escapeODataText(req.query?.q);
      const select = "$select=id,displayName,mail,userPrincipalName,mobilePhone,businessPhones,accountEnabled";
      const top = "$top=50";
      const params = [select, top];
      if (search) {
        params.push(
          `$filter=${encodeURIComponent(`startswith(displayName,'${search}') or startswith(mail,'${search}') or startswith(userPrincipalName,'${search}')`)}`
        );
      }
      let path = `/v1.0/users?${params.join("&")}`;
      const usuarios = [];
      let pages = 0;

      while (path && pages < 4) {
        const data = await graphGet(path, token);
        const rows = Array.isArray(data.value) ? data.value : [];
        usuarios.push(...rows.map(mapGraphUser).filter(Boolean));
        path = normalizeGraphNextPath(data["@odata.nextLink"]);
        pages += 1;
      }

      const unique = Array.from(
        new Map(usuarios.map((user) => [user.email, user])).values()
      );
      return res.json(unique);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Error al consultar usuarios del tenant" });
    }
  });

  app.post("/temp/crear-usuario", validateTempKey, access, async (req, res) => {
    try {
      const nombreUsuario = textOrNull(req.body?.nombre_usuario);
      const email = normalizeEmail(req.body?.email);
      const azureOid = textOrNull(req.body?.azure_oid);

      if (!nombreUsuario) return res.status(400).json({ error: "nombre_usuario es obligatorio" });
      if (!email) return res.status(400).json({ error: "email es obligatorio" });

      const rolUsuario = parseOptionalId(req.body?.rol_usuario_id, "rol_usuario_id");
      const tipoDocumento = parseOptionalId(req.body?.tipo_documento_id, "tipo_documento_id");
      const banco = parseOptionalId(req.body?.banco_id, "banco_id");
      const tipoCuenta = parseOptionalId(req.body?.tipo_cuenta_id, "tipo_cuenta_id");
      const tipoPersona = parseTipoPersona(req.body?.tipo_persona);
      const tipoConsultor = parseTipoConsultor(req.body?.tipo_consultor_enum);

      const validationError = [
        rolUsuario,
        tipoDocumento,
        banco,
        tipoCuenta,
        tipoPersona,
        tipoConsultor
      ].find((item) => item.error)?.error;
      if (validationError) return res.status(400).json({ error: validationError });

      const catalogErrors = await Promise.all([
        validateCatalogId(pool, "roles", rolUsuario.value, "rol_usuario_id no existe o está inactivo"),
        validateCatalogId(pool, "documento_identidad", tipoDocumento.value, "tipo_documento_id no existe o está inactivo"),
        validateCatalogId(pool, "bancos", banco.value, "banco_id no existe o está inactivo"),
        validateCatalogId(pool, "tipo_cuenta_bancaria", tipoCuenta.value, "tipo_cuenta_id no existe o está inactivo")
      ]);
      const catalogError = catalogErrors.find(Boolean);
      if (catalogError) return res.status(400).json({ error: catalogError });

      const existing = await pool.query(
        `
        SELECT id
        FROM usuarios
        WHERE LOWER(email) = LOWER($1)
           OR ($2::text IS NOT NULL AND azure_oid = $2)
        LIMIT 2
        `,
        [email, azureOid]
      );

      if (existing.rows.length > 1) {
        return res.status(409).json({
          error: "El correo y el usuario de Microsoft pertenecen a registros distintos. Revisar manualmente."
        });
      }

      if (existing.rows.length > 0) {
        await pool.query(
          `
          UPDATE usuarios
          SET nombre_usuario = $1,
              rol_usuario_id = $2,
              activo = true,
              tipo_documento_id = $3,
              banco_id = $4,
              tipo_cuenta_id = $5,
              tipo_persona = $6::tipo_persona,
              tipo_consultor = $7::tipo_consultor_enum,
              ciudad = $8,
              telefono = $9,
              cedula = $10,
              nro_cuenta_bancaria = $11,
              direccion = $12,
              email = $13,
              azure_oid = COALESCE($14, azure_oid),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $15
          `,
          [
            nombreUsuario,
            rolUsuario.value,
            tipoDocumento.value,
            banco.value,
            tipoCuenta.value,
            tipoPersona.value,
            tipoConsultor.value,
            textOrNull(req.body?.ciudad),
            textOrNull(req.body?.telefono),
            textOrNull(req.body?.cedula),
            textOrNull(req.body?.nro_cuenta_bancaria),
            textOrNull(req.body?.direccion),
            email,
            azureOid,
            existing.rows[0].id
          ]
        );

        return res.json({ ok: true, updated: true });
      }

      await pool.query(
        `
        INSERT INTO usuarios (
          nombre_usuario,
          email,
          azure_oid,
          rol_usuario_id,
          activo,
          tipo_documento_id,
          banco_id,
          tipo_cuenta_id,
          tipo_persona,
          tipo_consultor,
          ciudad,
          telefono,
          cedula,
          nro_cuenta_bancaria,
          direccion,
          created_by
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          true,
          $5,
          $6,
          $7,
          $8::tipo_persona,
          $9::tipo_consultor_enum,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15
        )
        `,
        [
          nombreUsuario,
          email,
          azureOid,
          rolUsuario.value,
          tipoDocumento.value,
          banco.value,
          tipoCuenta.value,
          tipoPersona.value,
          tipoConsultor.value,
          textOrNull(req.body?.ciudad),
          textOrNull(req.body?.telefono),
          textOrNull(req.body?.cedula),
          textOrNull(req.body?.nro_cuenta_bancaria),
          textOrNull(req.body?.direccion),
          textOrNull(req.user?.email)
        ]
      );

      return res.json({ ok: true, updated: false });
    } catch (err) {
      if (err?.code === "23505") {
        return res.status(400).json({ error: "El email ya existe en usuarios" });
      }
      console.error(err);
      return res.status(500).json({ error: "Error al crear usuario temporal" });
    }
  });
};
