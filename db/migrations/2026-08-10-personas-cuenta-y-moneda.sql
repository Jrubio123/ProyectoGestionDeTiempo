BEGIN;

ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS moneda_cobro tipo_moneda;

-- Prioriza la relación ya validada que pudiera existir únicamente en usuarios.
UPDATE personas persona
SET tipo_cuenta_id = usuario.tipo_cuenta_id,
    updated_at = NOW()
FROM usuarios usuario
WHERE usuario.persona_id = persona.id
  AND persona.tipo_cuenta_id IS NULL
  AND usuario.tipo_cuenta_id IS NOT NULL;

-- Toma la referencia de catálogo que ya exista en el preregistro.
UPDATE personas persona
SET tipo_cuenta_id = preregistro.tipo_cuenta_id,
    updated_at = NOW()
FROM preregistro_personas preregistro
WHERE preregistro.id = persona.preregistro_id
  AND persona.tipo_cuenta_id IS NULL
  AND preregistro.tipo_cuenta_id IS NOT NULL;

-- Recupera el tipo de cuenta que quedó como texto en preregistro/datos_extra.
WITH fuente AS (
  SELECT
    p.id AS persona_id,
    COALESCE(
      NULLIF(BTRIM(pp.tipo_cuenta), ''),
      NULLIF(BTRIM(sc.datos_extra->>'tipo_cuenta'), '')
    ) AS tipo_cuenta_nombre
  FROM personas p
  LEFT JOIN preregistro_personas pp ON pp.id = p.preregistro_id
  LEFT JOIN LATERAL (
    SELECT solicitud.datos_extra
    FROM solicitudes_contratacion solicitud
    WHERE solicitud.estado <> 'Cancelado'
      AND (
        (p.preregistro_id IS NOT NULL AND solicitud.preregistro_id = p.preregistro_id)
        OR NULLIF(BTRIM(solicitud.numero_documento), '') = NULLIF(BTRIM(p.numero_documento), '')
      )
    ORDER BY solicitud.updated_at DESC NULLS LAST, solicitud.id DESC
    LIMIT 1
  ) sc ON TRUE
  WHERE p.tipo_cuenta_id IS NULL
), resuelta AS (
  SELECT
    fuente.persona_id,
    tipo_cuenta.id AS tipo_cuenta_id
  FROM fuente
  JOIN LATERAL (
    SELECT catalogo.id
    FROM tipo_cuenta_bancaria catalogo
    WHERE catalogo.activo = true
      AND (
        (
          LOWER(fuente.tipo_cuenta_nombre) LIKE '%ahorro%'
          AND LOWER(catalogo.titulo) LIKE '%ahorro%'
        )
        OR (
          LOWER(fuente.tipo_cuenta_nombre) LIKE '%corrient%'
          AND LOWER(catalogo.titulo) LIKE '%corrient%'
        )
        OR LOWER(BTRIM(catalogo.titulo)) = LOWER(BTRIM(fuente.tipo_cuenta_nombre))
      )
    ORDER BY catalogo.id
    LIMIT 1
  ) tipo_cuenta ON fuente.tipo_cuenta_nombre IS NOT NULL
)
UPDATE personas persona
SET tipo_cuenta_id = resuelta.tipo_cuenta_id,
    updated_at = NOW()
FROM resuelta
WHERE persona.id = resuelta.persona_id
  AND persona.tipo_cuenta_id IS NULL;

-- Mantiene sincronizada la copia bancaria de usuarios existentes.
UPDATE usuarios usuario
SET tipo_cuenta_id = persona.tipo_cuenta_id,
    updated_at = NOW()
FROM personas persona
WHERE usuario.persona_id = persona.id
  AND usuario.tipo_cuenta_id IS NULL
  AND persona.tipo_cuenta_id IS NOT NULL;

-- Consolida cargo/perfil y responsable que antes quedaban solamente en la solicitud.
WITH relacion_fuente AS (
  SELECT
    p.id AS persona_id,
    sc.perfil,
    sc.supervisor_nombre
  FROM personas p
  LEFT JOIN usuarios u ON u.persona_id = p.id
  LEFT JOIN LATERAL (
    SELECT
      solicitud.perfil,
      COALESCE(supervisor.nombre_usuario, solicitud.datos_extra->>'supervisor_nombre') AS supervisor_nombre
    FROM solicitudes_contratacion solicitud
    LEFT JOIN usuarios supervisor ON supervisor.id = solicitud.supervisor_id
    WHERE solicitud.estado <> 'Cancelado'
      AND (
        solicitud.persona_usuario_id = u.id
        OR (p.preregistro_id IS NOT NULL AND solicitud.preregistro_id = p.preregistro_id)
        OR NULLIF(BTRIM(solicitud.numero_documento), '') = NULLIF(BTRIM(p.numero_documento), '')
      )
    ORDER BY solicitud.updated_at DESC NULLS LAST, solicitud.id DESC
    LIMIT 1
  ) sc ON TRUE
)
UPDATE personas persona
SET cargo = COALESCE(persona.cargo, NULLIF(BTRIM(relacion_fuente.perfil), '')),
    jefe_inmediato = COALESCE(persona.jefe_inmediato, NULLIF(BTRIM(relacion_fuente.supervisor_nombre), '')),
    updated_at = NOW()
FROM relacion_fuente
WHERE persona.id = relacion_fuente.persona_id
  AND (
    (persona.cargo IS NULL AND NULLIF(BTRIM(relacion_fuente.perfil), '') IS NOT NULL)
    OR (persona.jefe_inmediato IS NULL AND NULLIF(BTRIM(relacion_fuente.supervisor_nombre), '') IS NOT NULL)
  );

-- Moneda contractual/cobro para personas con o sin usuario.
WITH moneda_fuente AS (
  SELECT
    p.id AS persona_id,
    COALESCE(
      u.moneda_cobro::text,
      sc.moneda::text
    ) AS moneda
  FROM personas p
  LEFT JOIN usuarios u ON u.persona_id = p.id
  LEFT JOIN LATERAL (
    SELECT solicitud.moneda
    FROM solicitudes_contratacion solicitud
    WHERE solicitud.estado <> 'Cancelado'
      AND (
        solicitud.persona_usuario_id = u.id
        OR (p.preregistro_id IS NOT NULL AND solicitud.preregistro_id = p.preregistro_id)
        OR NULLIF(BTRIM(solicitud.numero_documento), '') = NULLIF(BTRIM(p.numero_documento), '')
      )
    ORDER BY solicitud.updated_at DESC NULLS LAST, solicitud.id DESC
    LIMIT 1
  ) sc ON TRUE
)
UPDATE personas persona
SET moneda_cobro = moneda_fuente.moneda::tipo_moneda,
    updated_at = NOW()
FROM moneda_fuente
WHERE persona.id = moneda_fuente.persona_id
  AND persona.moneda_cobro IS NULL
  AND moneda_fuente.moneda IN ('COP', 'USD', 'EUR');

COMMIT;
