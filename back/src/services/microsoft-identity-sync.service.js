class MicrosoftIdentitySyncError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.name = "MicrosoftIdentitySyncError";
    this.statusCode = statusCode;
  }
}

function normalizeCorporateEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function buildPersonNames({ givenName, surname, displayName, email }) {
  const firstName = normalizeText(givenName);
  const lastName = normalizeText(surname);
  if (firstName || lastName) {
    return { firstName: firstName || lastName, lastName };
  }

  return {
    firstName: normalizeText(displayName) || email,
    lastName: null
  };
}

function assertSingle(rows, message) {
  if ((rows || []).length > 1) {
    throw new MicrosoftIdentitySyncError(message, 409);
  }
  return rows?.[0] || null;
}

function assertCompatibleAzureOid(user, oid) {
  if (user?.azure_oid && user.azure_oid !== oid) {
    throw new MicrosoftIdentitySyncError(
      "El correo Silver ya está asociado a otra identidad de Microsoft.",
      409
    );
  }
}

async function findUser(db, oid, email) {
  const result = await db.query(
    `
    SELECT
      u.id,
      u.public_id,
      u.nombre_usuario,
      u.email,
      u.rol_usuario_id,
      u.tipo_consultor,
      u.azure_oid,
      u.activo,
      u.persona_id,
      r.titulo AS rol
    FROM usuarios u
    LEFT JOIN roles r ON r.id = u.rol_usuario_id
    WHERE u.azure_oid = $1
       OR LOWER(BTRIM(u.email)) = $2
    ORDER BY CASE WHEN u.azure_oid = $1 THEN 0 ELSE 1 END, u.id
    FOR UPDATE OF u
    `,
    [oid, email]
  );

  return assertSingle(
    result.rows,
    "Existen varios usuarios asociados a la misma identidad de Microsoft."
  );
}

async function findPersonById(db, personId) {
  if (!personId) return null;
  const result = await db.query(
    `SELECT id, public_id, correo_silver
     FROM personas
     WHERE id = $1
     FOR UPDATE`,
    [personId]
  );
  return result.rows[0] || null;
}

async function findPersonByCorporateEmail(db, email) {
  const result = await db.query(
    `SELECT id, public_id, correo_silver
     FROM personas
     WHERE LOWER(BTRIM(correo_silver)) = $1
     ORDER BY id
     FOR UPDATE`,
    [email]
  );

  return assertSingle(
    result.rows,
    "Existen varias personas con el mismo correo Silver."
  );
}

async function findUserLinkedToPerson(db, personId, excludeUserId = null) {
  const result = await db.query(
    `SELECT id, public_id, nombre_usuario, email, rol_usuario_id, tipo_consultor,
            azure_oid, activo, persona_id
     FROM usuarios
     WHERE persona_id = $1
       AND ($2::int IS NULL OR id <> $2)
     FOR UPDATE`,
    [personId, excludeUserId]
  );

  return assertSingle(
    result.rows,
    "La persona ya está asociada a otro usuario del sistema."
  );
}

async function createPerson(db, identity) {
  const result = await db.query(
    `INSERT INTO personas (nombre, apellidos, correo_silver, estado)
     VALUES ($1, $2, $3, 'activo')
     RETURNING id, public_id, correo_silver`,
    [identity.firstName, identity.lastName, identity.email]
  );
  return result.rows[0];
}

async function syncPerson(db, personId, identity) {
  const result = await db.query(
    `UPDATE personas
     SET correo_silver = $1,
         nombre = CASE
           WHEN NULLIF(BTRIM(COALESCE(nombre, '')), '') IS NULL THEN $2
           ELSE nombre
         END,
         apellidos = CASE
           WHEN NULLIF(BTRIM(COALESCE(apellidos, '')), '') IS NULL THEN $3
           ELSE apellidos
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4
     RETURNING id, public_id, correo_silver`,
    [identity.email, identity.firstName, identity.lastName, personId]
  );
  return result.rows[0];
}

async function createUser(db, personId, identity, defaultRoleId) {
  const result = await db.query(
    `WITH usuario_creado AS (
       INSERT INTO usuarios (
         nombre_usuario,
         email,
         rol_usuario_id,
         activo,
         telefono,
         created_by,
         azure_oid,
         persona_id,
         ultimo_inicio_sesion
       )
       VALUES ($1, $2, $3, true, $4, 'ms_sso', $5, $6, CURRENT_TIMESTAMP)
       RETURNING id, public_id, nombre_usuario, email, rol_usuario_id,
                 tipo_consultor, azure_oid, activo, persona_id
     )
     SELECT uc.*, r.titulo AS rol
     FROM usuario_creado uc
     LEFT JOIN roles r ON r.id = uc.rol_usuario_id`,
    [
      identity.displayName,
      identity.email,
      defaultRoleId,
      identity.phone,
      identity.oid,
      personId
    ]
  );
  return result.rows[0];
}

async function syncUser(db, userId, personId, identity) {
  const result = await db.query(
    `WITH usuario_actualizado AS (
       UPDATE usuarios
       SET azure_oid = $1,
           email = $2,
           nombre_usuario = $3,
           telefono = COALESCE($4, telefono),
           persona_id = $5,
           ultimo_inicio_sesion = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING id, public_id, nombre_usuario, email, rol_usuario_id,
                 tipo_consultor, azure_oid, activo, persona_id
     )
     SELECT ua.*, r.titulo AS rol
     FROM usuario_actualizado ua
     LEFT JOIN roles r ON r.id = ua.rol_usuario_id`,
    [
      identity.oid,
      identity.email,
      identity.displayName,
      identity.phone,
      personId,
      userId
    ]
  );
  return result.rows[0];
}

async function syncMicrosoftIdentity(db, input) {
  const oid = normalizeText(input?.oid);
  const email = normalizeCorporateEmail(input?.email);
  const displayName = normalizeText(input?.displayName) || email;
  const defaultRoleId = Number(input?.defaultRoleId) || null;

  if (!oid || !email || !defaultRoleId) {
    throw new MicrosoftIdentitySyncError(
      "La identidad de Microsoft no tiene los datos requeridos.",
      400
    );
  }

  const names = buildPersonNames({
    givenName: input?.givenName,
    surname: input?.surname,
    displayName,
    email
  });
  const identity = {
    oid,
    email,
    displayName,
    phone: normalizeText(input?.phone),
    firstName: names.firstName,
    lastName: names.lastName
  };

  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `microsoft-sso:${oid}`
  ]);

  let user = await findUser(db, oid, email);
  if (user) {
    assertCompatibleAzureOid(user, oid);
    if (!user.activo) {
      throw new MicrosoftIdentitySyncError(
        "Tu cuenta está desactivada. Contacta al administrador.",
        403
      );
    }
  }

  let person = user?.persona_id
    ? await findPersonById(db, user.persona_id)
    : await findPersonByCorporateEmail(db, email);

  if (!person) {
    person = await createPerson(db, identity);
  } else {
    const linkedUser = await findUserLinkedToPerson(db, person.id, user?.id || null);
    if (linkedUser) {
      assertCompatibleAzureOid(linkedUser, oid);
      if (!linkedUser.activo) {
        throw new MicrosoftIdentitySyncError(
          "Tu cuenta está desactivada. Contacta al administrador.",
          403
        );
      }
      if (user && linkedUser.id !== user.id) {
        throw new MicrosoftIdentitySyncError(
          "La identidad de Microsoft y la persona pertenecen a usuarios diferentes.",
          409
        );
      }
      user = linkedUser;
    }
    person = await syncPerson(db, person.id, identity);
  }

  const syncedUser = user
    ? await syncUser(db, user.id, person.id, identity)
    : await createUser(db, person.id, identity, defaultRoleId);

  if (!syncedUser?.id) {
    throw new MicrosoftIdentitySyncError(
      "No se pudo crear o sincronizar el usuario de Microsoft.",
      500
    );
  }

  return syncedUser;
}

module.exports = {
  MicrosoftIdentitySyncError,
  normalizeCorporateEmail,
  syncMicrosoftIdentity
};
