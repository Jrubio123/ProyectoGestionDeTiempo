const { pool } = require("../db");
const { getGraphAccessToken } = require("../email");
const https = require("https");

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

function graphPatch(path, accessToken, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const options = {
      hostname: "graph.microsoft.com",
      path,
      method: "PATCH",
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
            resolve(data ? JSON.parse(data) : {});
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

// Roles por usuario (admin)
async function listUsuariosRoles(req, res) {
  try {
    const result = await pool.query(
      `
      SELECT
        u.public_id AS id,
        u.nombre_usuario,
        u.email,
        u.activo,
        r.public_id AS rol_id,
        r.titulo AS rol
      FROM usuarios u
      LEFT JOIN roles r ON r.id = u.rol_usuario_id
      WHERE u.activo = true
      ORDER BY u.nombre_usuario ASC
      `
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar usuarios" });
  }
}

// ====Gestión de licencias / acceso ============================================================?
async function listUsuariosLicencias(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        u.public_id      AS id,
        u.nombre_usuario,
        u.email,
        u.activo,
        u.azure_oid,
        u.tipo_consultor,
        u.ultimo_inicio_sesion,
        r.titulo         AS rol
      FROM usuarios u
        LEFT JOIN roles r ON u.rol_usuario_id = r.id
      ORDER BY u.nombre_usuario ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
}

async function patchUsuarioLicenciaEstado(req, res) {
  const { public_id } = req.params;
  const { activo } = req.body;

  if (typeof activo !== "boolean") {
    return res.status(400).json({ error: "El campo activo debe ser booleano" });
  }

  try {
    const userRes = await pool.query(
      `SELECT id, azure_oid, email, nombre_usuario FROM usuarios WHERE public_id = $1`,
      [public_id]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const user = userRes.rows[0];

    await pool.query(
      `UPDATE usuarios SET activo = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [activo, user.id]
    );

    let entraId = user.azure_oid;

    // Si no tiene azure_oid guardado, intentar encontrarlo por email en Entra
    if (!entraId && user.email) {
      try {
        const token = await getGraphAccessToken();
        const busqueda = await graphGet(
          `/v1.0/users?$filter=mail eq '${user.email}'&$select=id`,
          token
        );
        const entraUser = busqueda?.value?.[0];
        if (entraUser?.id) {
          entraId = entraUser.id;
          // Guardar para futuras operaciones
          await pool.query(
            `UPDATE usuarios SET azure_oid = $1 WHERE id = $2`,
            [entraId, user.id]
          );
        }
      } catch (lookupErr) {
        console.error("No se pudo buscar usuario en Entra por email:", lookupErr.message);
      }
    }

    if (entraId) {
      try {
        const token = await getGraphAccessToken();
        await graphPatch(`/v1.0/users/${entraId}`, token, { accountEnabled: activo });
      } catch (graphErr) {
        console.error("Error actualizando estado en Entra ID:", graphErr.message);
        return res.status(207).json({
          warning: "El usuario se actualizó en la BD pero no se pudo sincronizar con Entra ID. Intenta de nuevo.",
          activo
        });
      }
    }

    res.json({
      mensaje: `Usuario ${activo ? "activado" : "desactivado"} correctamente`,
      entra_sincronizado: !!entraId,
      activo
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar estado del usuario" });
  }
}

async function actualizarRolUsuario(req, res) {
  const { id } = req.params;
  const { rol_id } = req.body || {};
  try {
    if (!rol_id) return res.status(400).json({ error: "Falta rol_id" });

    // CTE para resolver usuario y rol en 1 query
    const result = await pool.query(
      `
      WITH 
        c_usuario AS (SELECT id, nombre_usuario, email FROM usuarios WHERE public_id = $2),
        c_rol AS (SELECT id FROM roles WHERE public_id = $1)
      UPDATE usuarios
      SET rol_usuario_id = (SELECT id FROM c_rol),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM c_usuario)
        AND EXISTS (SELECT 1 FROM c_rol)
      RETURNING public_id AS id, nombre_usuario, email
      `,
      [rol_id, id]
    );

    if (result.rowCount === 0) {
      // Verificar manual (sin error crash) si fue porque no existe el rol o el usuario
      const checkRol = await pool.query("SELECT id FROM roles WHERE public_id = $1", [rol_id]);
      if (checkRol.rowCount === 0) return res.status(404).json({ error: "Rol no encontrado" });

      const checkUser = await pool.query("SELECT id FROM usuarios WHERE public_id = $1", [id]);
      if (checkUser.rowCount === 0) return res.status(404).json({ error: "Usuario no encontrado" });

      return res.status(500).json({ error: "Error desconocido al asignar rol" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar rol de usuario" });
  }
}

module.exports = { listUsuariosRoles, listUsuariosLicencias, patchUsuarioLicenciaEstado, actualizarRolUsuario };
