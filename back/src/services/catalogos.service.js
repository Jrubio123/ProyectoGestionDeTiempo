const { pool } = require("../db");

// ============== MODULOS (publico) ==============
/**
 * Lista modulos activos para uso publico
 */
async function listModulosPublicos(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        id,
        public_id,
        titulo
      FROM modulo
      WHERE activo = true
      ORDER BY titulo ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener módulos" });
  }
}

// ============== MONEDAS ==============
/**
 * Lista las monedas disponibles del sistema
 */
async function listMonedas(req, res) {
  try {
    const result = await pool.query(
      `
      SELECT unnest(enum_range(NULL::tipo_moneda))::text AS id
      `
    );
    res.json((result.rows || []).map((row) => ({ id: row.id, titulo: row.id })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener monedas" });
  }
}

// ============== MODULOS (admin) ==============
/**
 * Lista modulos para administracion
 */
async function listModulosAdmin(req, res) {
  try {
    const result = await pool.query(
      `
      SELECT
        public_id AS id,
        titulo,
        nombre_completo,
        descripcion,
        activo,
        created_at,
        updated_at
      FROM modulo
      ORDER BY titulo ASC
      `
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar módulos" });
  }
}

/**
 * Crea un nuevo modulo administrativo
 */
async function createModulo(req, res) {
  const titulo = String(req.body?.titulo || "").trim();
  const nombreCompleto = String(req.body?.nombre_completo || "").trim() || null;
  const descripcion = String(req.body?.descripcion || "").trim() || null;
  const activo = req.body?.activo === undefined ? true : Boolean(req.body?.activo);
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });
    const dup = await pool.query(
      "SELECT id FROM modulo WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) LIMIT 1",
      [titulo]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe un módulo con ese título" });
    }
    const result = await pool.query(
      `
      INSERT INTO modulo (titulo, nombre_completo, descripcion, activo)
      VALUES ($1, $2, $3, $4)
      RETURNING public_id AS id, titulo, nombre_completo, descripcion, activo, created_at, updated_at
      `,
      [titulo, nombreCompleto, descripcion, activo]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear módulo" });
  }
}

/**
 * Actualiza un modulo existente
 */
async function updateModulo(req, res) {
  const { id } = req.params;
  const titulo = String(req.body?.titulo || "").trim();
  const nombreCompleto = String(req.body?.nombre_completo || "").trim() || null;
  const descripcion = String(req.body?.descripcion || "").trim() || null;
  const activo = req.body?.activo;
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });

    // CTE para resolver el id interno, validar duplicados y hacer update en un viaje
    const result = await pool.query(
      `
      WITH 
        c_modulo AS (SELECT id, titulo FROM modulo WHERE public_id = $5),
        c_dup AS (
          SELECT id 
          FROM modulo 
          WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) 
            AND id != (SELECT id FROM c_modulo)
          LIMIT 1
        )
      UPDATE modulo
      SET titulo = $1,
          nombre_completo = $2,
          descripcion = $3,
          activo = COALESCE($4::boolean, activo),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM c_modulo)
        AND NOT EXISTS (SELECT 1 FROM c_dup)
      RETURNING public_id AS id, titulo, nombre_completo, descripcion, activo, created_at, updated_at
      `,
      [titulo, nombreCompleto, descripcion, activo === undefined ? null : Boolean(activo), id]
    );

    if (result.rowCount === 0) {
      // Verificar manual (sin error crash) si fue por duplicado o porque no existe el modulo
      const dupCheck = await pool.query("SELECT id FROM modulo WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1))", [titulo]);
      if (dupCheck.rowCount > 0 && dupCheck.rows[0].id) {
        return res.status(400).json({ error: "Ya existe un módulo con ese título" });
      }
      return res.status(404).json({ error: "Módulo no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar módulo" });
  }
}

/**
 * Desactiva un modulo existente
 */
async function deleteModulo(req, res) {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `
      UPDATE modulo
      SET activo = false,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM modulo WHERE public_id = $1)
      RETURNING public_id AS id
      `,
      [id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Módulo no encontrado" });
    res.json(result.rows[0] || { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar módulo" });
  }
}

// ============== ROLES (admin) ==============
/**
 * Lista roles para administracion
 */
async function listRolesAdmin(req, res) {
  try {
    const result = await pool.query(
      `
      SELECT
        public_id AS id,
        titulo,
        descripcion,
        activo,
        created_at,
        updated_at
      FROM roles
      ORDER BY titulo ASC
      `
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar roles" });
  }
}

/**
 * Crea un nuevo rol
 */
async function createRol(req, res) {
  const titulo = String(req.body?.titulo || "").trim();
  const descripcion = String(req.body?.descripcion || "").trim() || null;
  const activo = req.body?.activo === undefined ? true : Boolean(req.body?.activo);
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });
    const dup = await pool.query(
      "SELECT id FROM roles WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) LIMIT 1",
      [titulo]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe un rol con ese título" });
    }
    const result = await pool.query(
      `
      INSERT INTO roles (titulo, descripcion, activo)
      VALUES ($1, $2, $3)
      RETURNING public_id AS id, titulo, descripcion, activo, created_at, updated_at
      `,
      [titulo, descripcion, activo]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear rol" });
  }
}

/**
 * Actualiza un rol existente
 */
async function updateRol(req, res) {
  const { id } = req.params;
  const titulo = String(req.body?.titulo || "").trim();
  const descripcion = String(req.body?.descripcion || "").trim() || null;
  const activo = req.body?.activo;
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });

    // CTE para resolver el id interno, validar duplicados y hacer update en un viaje
    const result = await pool.query(
      `
      WITH 
        c_rol AS (SELECT id, titulo FROM roles WHERE public_id = $4),
        c_dup AS (
          SELECT id 
          FROM roles 
          WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) 
            AND id != (SELECT id FROM c_rol)
          LIMIT 1
        )
      UPDATE roles
      SET titulo = $1,
          descripcion = $2,
          activo = COALESCE($3::boolean, activo),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM c_rol)
        AND NOT EXISTS (SELECT 1 FROM c_dup)
      RETURNING public_id AS id, titulo, descripcion, activo, created_at, updated_at
      `,
      [titulo, descripcion, activo === undefined ? null : Boolean(activo), id]
    );

    if (result.rowCount === 0) {
      // Verificar manual si fue por duplicado o porque no existe el rol
      const dupCheck = await pool.query("SELECT id FROM roles WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1))", [titulo]);
      if (dupCheck.rowCount > 0 && dupCheck.rows[0].id) {
        return res.status(400).json({ error: "Ya existe un rol con ese título" });
      }
      return res.status(404).json({ error: "Rol no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar rol" });
  }
}

/**
 * Desactiva un rol si no esta en uso
 */
async function deleteRol(req, res) {
  const { id } = req.params;
  try {
    // Para roles, tenemos una validación adicional si está en uso. Podemos hacer un CTE.
    const result = await pool.query(
      `
      WITH 
        c_rol AS (SELECT id FROM roles WHERE public_id = $1),
        c_uso AS (SELECT id FROM usuarios WHERE rol_usuario_id = (SELECT id FROM c_rol) LIMIT 1)
      UPDATE roles
      SET activo = false,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM c_rol)
        AND NOT EXISTS (SELECT 1 FROM c_uso)
      RETURNING public_id AS id, 
                (EXISTS (SELECT 1 FROM c_uso)) AS en_uso,
                (SELECT id FROM c_rol) AS existe_rol
      `,
      [id]
    );

    if (result.rowCount === 0) {
      // Diferenciar el error si rowCount fue 0 por no existir o por estar en uso
      const checkOriginal = await pool.query(
        "SELECT id FROM roles WHERE public_id = $1", [id]
      );
      if (checkOriginal.rowCount === 0) return res.status(404).json({ error: "Rol no encontrado" });

      const checkUso = await pool.query(
        "SELECT id FROM usuarios WHERE rol_usuario_id = $1 LIMIT 1", [checkOriginal.rows[0].id]
      );
      if (checkUso.rowCount > 0) return res.status(400).json({ error: "No se puede eliminar: el rol está asignado a usuarios" });

      return res.status(500).json({ error: "Error lógico desconocido al eliminar" });
    }

    res.json(result.rows[0] || { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar rol" });
  }
}

// ============== BANCOS (admin) ==============
/**
 * Lista bancos para administracion
 */
async function listBancosAdmin(req, res) {
  try {
    const result = await pool.query(
      `
      SELECT
        public_id AS id,
        titulo,
        codigo_bancolombia,
        codigo_conversor,
        activo,
        created_at,
        updated_at
      FROM bancos
      ORDER BY titulo ASC
      `
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar bancos" });
  }
}

/**
 * Crea un nuevo banco
 */
async function createBanco(req, res) {
  const titulo = String(req.body?.titulo || "").trim();
  const codigoBancolombia = String(req.body?.codigo_bancolombia || "").trim() || null;
  const codigoConversor = String(req.body?.codigo_conversor || "").trim() || null;
  const activo = req.body?.activo === undefined ? true : Boolean(req.body?.activo);
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });
    const dup = await pool.query(
      "SELECT id FROM bancos WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) LIMIT 1",
      [titulo]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe un banco con ese título" });
    }
    const result = await pool.query(
      `
      INSERT INTO bancos (titulo, codigo_bancolombia, codigo_conversor, activo)
      VALUES ($1, $2, $3, $4)
      RETURNING public_id AS id, titulo, codigo_bancolombia, codigo_conversor, activo, created_at, updated_at
      `,
      [titulo, codigoBancolombia, codigoConversor, activo]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear banco" });
  }
}

/**
 * Actualiza un banco existente
 */
async function updateBanco(req, res) {
  const { id } = req.params;
  const titulo = String(req.body?.titulo || "").trim();
  const codigoBancolombia = String(req.body?.codigo_bancolombia || "").trim() || null;
  const codigoConversor = String(req.body?.codigo_conversor || "").trim() || null;
  const activo = req.body?.activo;
  try {
    if (!titulo) return res.status(400).json({ error: "El título es obligatorio" });

    // CTE para resolver el id interno, validar duplicados y hacer update en un viaje
    const result = await pool.query(
      `
      WITH 
        c_banco AS (SELECT id, titulo FROM bancos WHERE public_id = $5),
        c_dup AS (
          SELECT id 
          FROM bancos 
          WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1)) 
            AND id != (SELECT id FROM c_banco)
          LIMIT 1
        )
      UPDATE bancos
      SET titulo = $1,
          codigo_bancolombia = $2,
          codigo_conversor = $3,
          activo = COALESCE($4::boolean, activo),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM c_banco)
        AND NOT EXISTS (SELECT 1 FROM c_dup)
      RETURNING public_id AS id, titulo, codigo_bancolombia, codigo_conversor, activo, created_at, updated_at
      `,
      [titulo, codigoBancolombia, codigoConversor, activo === undefined ? null : Boolean(activo), id]
    );

    if (result.rowCount === 0) {
      // Verificar manual si fue por duplicado o porque no existe el banco
      const dupCheck = await pool.query("SELECT id FROM bancos WHERE LOWER(TRIM(titulo)) = LOWER(TRIM($1))", [titulo]);
      if (dupCheck.rowCount > 0 && dupCheck.rows[0].id) {
        return res.status(400).json({ error: "Ya existe un banco con ese título" });
      }
      return res.status(404).json({ error: "Banco no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar banco" });
  }
}

/**
 * Desactiva un banco si no esta asignado
 */
async function deleteBanco(req, res) {
  const { id } = req.params;
  try {
    // Para bancos, validación adicional de usuarios. CTE para proteger e invalidar si está en uso
    const result = await pool.query(
      `
      WITH 
        c_banco AS (SELECT id FROM bancos WHERE public_id = $1),
        c_uso AS (SELECT id FROM usuarios WHERE banco_id = (SELECT id FROM c_banco) LIMIT 1)
      UPDATE bancos
      SET activo = false,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM c_banco)
        AND NOT EXISTS (SELECT 1 FROM c_uso)
      RETURNING public_id AS id, 
                (EXISTS (SELECT 1 FROM c_uso)) AS en_uso,
                (SELECT id FROM c_banco) AS existe_banco
      `,
      [id]
    );

    if (result.rowCount === 0) {
      // Diferenciar el error si rowCount fue 0
      const checkOriginal = await pool.query(
        "SELECT id FROM bancos WHERE public_id = $1", [id]
      );
      if (checkOriginal.rowCount === 0) return res.status(404).json({ error: "Banco no encontrado" });

      const checkUso = await pool.query(
        "SELECT id FROM usuarios WHERE banco_id = $1 LIMIT 1", [checkOriginal.rows[0].id]
      );
      if (checkUso.rowCount > 0) return res.status(400).json({ error: "No se puede eliminar: el banco está asignado a usuarios" });

      return res.status(500).json({ error: "Error lógico desconocido al eliminar" });
    }

    res.json(result.rows[0] || { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar banco" });
  }
}

module.exports = {
  listModulosPublicos,
  listMonedas,
  listModulosAdmin,
  createModulo,
  updateModulo,
  deleteModulo,
  listRolesAdmin,
  createRol,
  updateRol,
  deleteRol,
  listBancosAdmin,
  createBanco,
  updateBanco,
  deleteBanco
};
