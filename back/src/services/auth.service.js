const https = require("https");
const { pool } = require("../db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { env } = require("../config/env");

const JWT_SECRET = env.JWT_SECRET;

function buildUserResponse(userRow) {
  return {
    id: userRow?.public_id || (userRow?.id ? String(userRow.id) : null),
    nombre_usuario: userRow?.nombre_usuario || "",
    email: userRow?.email || "",
    rol: userRow?.rol || "",
    rol_usuario_id: userRow?.rol_usuario_id || null,
    tipo_consultor: userRow?.tipo_consultor || null
  };
}

function graphGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "graph.microsoft.com",
      path,
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (e) {
            resolve({});
          }
        } else {
          reject(new Error(`Graph error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function graphGetBinary(path, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "graph.microsoft.com",
      path,
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const statusCode = Number(res.statusCode || 0);
        if (statusCode >= 200 && statusCode < 300) {
          return resolve({
            statusCode,
            buffer,
            contentType: String(res.headers["content-type"] || "image/jpeg")
          });
        }
        return reject(
          new Error(
            `Graph binary error ${statusCode}: ${buffer.toString("utf8")}`
          )
        );
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function graphPost(path, accessToken, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const options = {
      hostname: "graph.microsoft.com",
      path,
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (e) {
            resolve({});
          }
        } else {
          reject(new Error(`Graph error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function resolveGraphPath(nextLink) {
  if (!nextLink) return null;
  if (nextLink.startsWith("https://graph.microsoft.com")) {
    try {
      const url = new URL(nextLink);
      return `${url.pathname}${url.search}`;
    } catch (err) {
      return null;
    }
  }
  return nextLink;
}

async function graphGetAll(path, accessToken, maxPages = 20) {
  const values = [];
  let nextPath = path;
  let pages = 0;

  while (nextPath && pages < maxPages) {
    const data = await graphGet(nextPath, accessToken);
    if (Array.isArray(data?.value)) {
      values.push(...data.value);
    }
    nextPath = resolveGraphPath(data?.["@odata.nextLink"]);
    pages += 1;
  }

  return values;
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch (err) {
    return null;
  }
}

function parseGraphErrorStatus(message) {
  const match = String(message || "").match(/Graph(?: binary)? error (\d{3})/);
  return match ? Number(match[1]) : null;
}

const normalizeValue = (value) => String(value || "").toLowerCase().trim();
const isGuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );

/**
 * Registra un usuario local con rol consultor
 */
async function registerUser(req, res) {
  if (String(process.env.AUTH_MODE || "").toLowerCase() === "ms_only") {
    return res.status(403).json({ error: "Registro deshabilitado. Usa Microsoft SSO." });
  }
  const { nombre_usuario, email, password } = req.body;

  try {
    if (!nombre_usuario || !email || !password) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const existe = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: "El correo ya está registrado" });
    }

    const rolRes = await pool.query(
      "SELECT id FROM roles WHERE titulo = 'Consultor' LIMIT 1"
    );
    const rolId = rolRes.rows[0]?.id || null;

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (nombre_usuario, email, password_hash, rol_usuario_id, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, public_id, nombre_usuario, email, rol_usuario_id`,
      [nombre_usuario, email, hash, rolId]
    );

    const user = result.rows[0];
    res.json({
      ok: true,
      user: {
        id: user.public_id || (user.id ? String(user.id) : null),
        nombre_usuario: user.nombre_usuario,
        email: user.email,
        rol_usuario_id: user.rol_usuario_id
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al registrar" });
  }
}

/**
 * Autentica usuarios locales y emite JWT
 */
async function loginUser(req, res) {
  if (String(process.env.AUTH_MODE || "").toLowerCase() === "ms_only") {
    return res.status(403).json({ error: "Login deshabilitado. Usa Microsoft SSO." });
  }
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const result = await pool.query(
      `SELECT u.id, u.public_id, u.nombre_usuario, u.email, u.password_hash, u.rol_usuario_id, u.tipo_consultor, r.titulo AS rol
         FROM usuarios u
         LEFT JOIN roles r ON u.rol_usuario_id = r.id
         WHERE u.email = $1 AND u.activo = true`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    try {
      await pool.query(
        "UPDATE usuarios SET ultimo_inicio_sesion = CURRENT_TIMESTAMP WHERE id = $1",
        [user.id]
      );
    } catch (err) {
      console.error("No se pudo actualizar ultimo_inicio_sesion:", err.message);
    }

    const payload = {
      id: user.id,
      public_id: user.public_id || null,
      nombre_usuario: user.nombre_usuario,
      email: user.email,
      rol: user.rol || "",
      rol_usuario_id: user.rol_usuario_id,
      tipo_consultor: user.tipo_consultor || null
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
    res.json({ token, user: buildUserResponse(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
}

/**
 * Devuelve el usuario autenticado por JWT
 */
async function getCurrentUser(req, res) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "No autorizado" });
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      `SELECT u.id, u.public_id, u.nombre_usuario, u.email, u.rol_usuario_id, u.tipo_consultor, r.titulo AS rol
         FROM usuarios u
         LEFT JOIN roles r ON u.rol_usuario_id = r.id
         WHERE u.id = $1 AND u.activo = true`,
      [decoded.id]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Usuario no válido" });
    }
    res.json({ user: buildUserResponse(result.rows[0]) });
  } catch (err) {
    res.status(401).json({ error: "Token inválido" });
  }
}

/**
 * Obtiene la foto Microsoft del usuario autenticado
 */
async function getUserPhoto(req, res) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "No autorizado" });
    jwt.verify(token, JWT_SECRET);

    const graphAccessToken = String(req.headers["x-graph-access-token"] || "").trim();
    if (!graphAccessToken) {
      return res.json({
        hasPhoto: false,
        message: "No tiene foto de perfil"
      });
    }

    const photo = await graphGetBinary("/v1.0/me/photo/$value", graphAccessToken);
    return res.json({
      hasPhoto: true,
      contentType: photo.contentType || "image/jpeg",
      data: photo.buffer.toString("base64")
    });
  } catch (err) {
    if (err?.name === "JsonWebTokenError" || err?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token inválido" });
    }
    const status = parseGraphErrorStatus(err?.message);
    if (status === 404) {
      return res.json({
        hasPhoto: false,
        message: "No tiene foto de perfil"
      });
    }
    if (status === 401 || status === 403) {
      return res.json({
        hasPhoto: false,
        message: "No se pudo validar la sesión de Microsoft para la foto"
      });
    }
    console.error("Error obteniendo foto de perfil Microsoft:", err?.message || err);
    return res.status(500).json({
      hasPhoto: false,
      message: "Error al cargar foto de perfil"
    });
  }
}

/**
 * Autentica usuarios con Microsoft SSO y emite JWT
 */
async function loginWithMicrosoft(req, res) {
  const accessToken = req.body?.access_token;
  if (!accessToken) {
    return res.status(400).json({ error: "access_token requerido" });
  }

  const tokenPayload = decodeJwtPayload(accessToken);
  const aud = tokenPayload?.aud || null;
  const scope = tokenPayload?.scp || "";
  const isGraphAud =
    aud === "https://graph.microsoft.com" ||
    aud === "00000003-0000-0000-c000-000000000000";

  if (!isGraphAud) {
    return res.status(401).json({
      error: "El token recibido no es de Microsoft Graph. Solicita el scope User.Read en el frontend."
    });
  }

  try {
    const me = await graphGet("/v1.0/me?$select=id,mail,userPrincipalName,displayName,mobilePhone", accessToken);
    const oid = me.id;
    const email = me.mail || me.userPrincipalName;
    const nombre = me.displayName || email;
    const telefono = me.mobilePhone || null;

    if (!oid || !email) {
      return res.status(400).json({ error: "No se pudo obtener información del usuario" });
    }

    const allowedGroups = (process.env.AZURE_ALLOWED_GROUPS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowedGroupsNormalized = new Set(allowedGroups.map(normalizeValue));
    const allowedGroupIds = allowedGroups.filter(isGuid);
    const allowedGroupNames = allowedGroups.filter((g) => !isGuid(g));

    if (allowedGroups.length > 0) {
      let groups = [];
      let matchedGroup = null;
      let allowed = false;

      if (allowedGroupIds.length > 0) {
        const check = await graphPost("/v1.0/me/checkMemberGroups", accessToken, {
          groupIds: allowedGroupIds
        });
        const matchedIds = Array.isArray(check?.value) ? check.value : [];
        if (matchedIds.length > 0) {
          matchedGroup = { id: matchedIds[0], name: null };
          allowed = true;
        }
      }

      if (!allowed && allowedGroupNames.length > 0) {
        const memberOf = await graphGetAll("/v1.0/me/transitiveMemberOf?$select=id,displayName", accessToken);
        groups = memberOf.map((g) => ({
          id: g.id,
          name: g.displayName
        }));
        matchedGroup = groups.find(
          (g) =>
            allowedGroupsNormalized.has(normalizeValue(g.id)) ||
            allowedGroupsNormalized.has(normalizeValue(g.name))
        ) || null;
        allowed = Boolean(matchedGroup);
      }

      if (!allowed) {
        return res.status(403).json({ error: "Usuario sin acceso al grupo permitido" });
      }
    }

    const roleRes = await pool.query(
      "SELECT id, titulo FROM roles WHERE LOWER(titulo) = LOWER('Consultor') LIMIT 1"
    );
    const rolId = roleRes.rows[0]?.id || null;
    const rolTitulo = roleRes.rows[0]?.titulo || "Consultor";
    if (!rolId) {
      return res.status(500).json({ error: "No existe el rol 'Consultor' en la tabla roles" });
    }

    let userRes = await pool.query(
      `SELECT u.id, u.public_id, u.nombre_usuario, u.email, u.rol_usuario_id, u.tipo_consultor, u.azure_oid, u.activo, r.titulo AS rol
       FROM usuarios u
       LEFT JOIN roles r ON u.rol_usuario_id = r.id
       WHERE (u.azure_oid = $1 OR u.email = $2)
       LIMIT 1`,
      [oid, email]
    );

    if (userRes.rows.length > 0 && !userRes.rows[0].activo) {
      return res.status(403).json({ error: "Tu cuenta está desactivada. Contacta al administrador." });
    }

    if (userRes.rows.length === 0) {
      userRes = await pool.query(
        `INSERT INTO usuarios
          (nombre_usuario, email, rol_usuario_id, activo, telefono, created_by, azure_oid)
         VALUES ($1, $2, $3, true, $4, 'ms_sso', $5)
         RETURNING id, public_id, nombre_usuario, email, rol_usuario_id`,
        [nombre, email, rolId, telefono, oid]
      );
    } else {
      const user = userRes.rows[0];
      if (!user.azure_oid) {
        await pool.query(
          "UPDATE usuarios SET azure_oid = $1 WHERE id = $2",
          [oid, user.id]
        );
      }
    }

    const userRow = userRes.rows[0];
    if (!userRow?.id) {
      return res.status(500).json({ error: "No se pudo crear o recuperar el usuario de Microsoft en BD" });
    }

    try {
      await pool.query(
        "UPDATE usuarios SET ultimo_inicio_sesion = CURRENT_TIMESTAMP WHERE id = $1",
        [userRow.id]
      );
    } catch (err) {
      console.error("No se pudo actualizar ultimo_inicio_sesion:", err.message);
    }

    const payload = {
      id: userRow.id,
      public_id: userRow.public_id || null,
      nombre_usuario: userRow.nombre_usuario || nombre,
      email: userRow.email || email,
      rol: userRow.rol || rolTitulo,
      rol_usuario_id: userRow.rol_usuario_id || rolId,
      tipo_consultor: userRow.tipo_consultor || null
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
    res.json({
      token,
      user: buildUserResponse({
        ...userRow,
        rol: userRow.rol || rolTitulo
      })
    });
  } catch (err) {
    const status = parseGraphErrorStatus(err.message);
    if (status === 401 || status === 403) {
      return res.status(401).json({
        error: "Token Microsoft inválido o sin permisos en Graph (revisa consentimiento de User.Read)."
      });
    }
    console.error("Error auth microsoft (interno):", err.message);

    if (err.code === "28P01") {
      return res.status(500).json({ error: "Credenciales de base de datos inválidas (DB_USER/DB_PASSWORD)" });
    }
    if (err.code === "3D000") {
      return res.status(500).json({ error: "Base de datos no existe (DB_NAME)" });
    }
    if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      return res.status(500).json({ error: "No se pudo conectar a la base de datos (DB_HOST/DB_PORT)" });
    }
    if (err.code === "42703") {
      return res.status(500).json({
        error:
          "Falta una columna requerida en la BD. Ejecuta la migracion db/migrations/2026-02-24-add-public-id.sql y reinicia el backend."
      });
    }
    if (err.code === "23505") {
      return res.status(500).json({ error: "Conflicto de datos al crear usuario (email/azure_oid duplicado)" });
    }
    if (err.code === "23502") {
      return res.status(500).json({ error: "Campo obligatorio nulo al crear usuario en BD" });
    }
    return res.status(500).json({ error: "Error interno al procesar autenticación Microsoft" });
  }
}

module.exports = {
  registerUser,
  loginUser,
  getCurrentUser,
  getUserPhoto,
  loginWithMicrosoft
};
