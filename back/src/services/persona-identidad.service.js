async function findCorreoPersonaConflict(
  db,
  { correo, numeroDocumento, excludePreregistroId = null, excludeSolicitudId = null } = {}
) {
  const email = String(correo || "").trim().toLowerCase();
  const documento = String(numeroDocumento || "").trim() || null;
  if (!email) return null;

  const result = await db.query(
    `
    SELECT fuente
    FROM (
      SELECT 'personas'::text AS fuente
      FROM personas p
      WHERE LOWER(BTRIM(COALESCE(p.correo_electronico, ''))) = $1
        AND (
          $2::text IS NULL
          OR NULLIF(BTRIM(COALESCE(p.numero_documento, '')), '')
              IS DISTINCT FROM NULLIF(BTRIM(COALESCE($2::text, '')), '')
        )

      UNION ALL

      SELECT 'preregistro_personas'::text AS fuente
      FROM preregistro_personas pp
      WHERE LOWER(BTRIM(COALESCE(pp.correo_personal, ''))) = $1
        AND ($3::int IS NULL OR pp.id <> $3)
        AND COALESCE(pp.estado, '') <> 'Anulado'
        AND (
          $2::text IS NULL
          OR NULLIF(BTRIM(COALESCE(pp.numero_documento, '')), '')
              IS DISTINCT FROM NULLIF(BTRIM(COALESCE($2::text, '')), '')
        )

      UNION ALL

      SELECT 'solicitudes_contratacion'::text AS fuente
      FROM solicitudes_contratacion sc
      WHERE LOWER(BTRIM(COALESCE(sc.correo_personal, ''))) = $1
        AND ($4::int IS NULL OR sc.id <> $4)
        AND COALESCE(sc.estado, '') <> 'Cancelado'
        AND (
          $2::text IS NULL
          OR NULLIF(BTRIM(COALESCE(sc.numero_documento, '')), '')
              IS DISTINCT FROM NULLIF(BTRIM(COALESCE($2::text, '')), '')
        )

      UNION ALL

      SELECT 'usuarios'::text AS fuente
      FROM usuarios u
      LEFT JOIN personas up ON up.id = u.persona_id
      WHERE LOWER(BTRIM(COALESCE(u.email, ''))) = $1
        AND (
          $2::text IS NULL
          OR NULLIF(BTRIM(COALESCE(up.numero_documento, u.cedula, '')), '')
              IS DISTINCT FROM NULLIF(BTRIM(COALESCE($2::text, '')), '')
        )
    ) conflictos
    LIMIT 1
    `,
    [email, documento, excludePreregistroId, excludeSolicitudId]
  );

  return result.rows[0] || null;
}

module.exports = {
  findCorreoPersonaConflict
};
