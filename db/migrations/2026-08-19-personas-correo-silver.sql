BEGIN;

ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS correo_silver VARCHAR(255);

WITH correos_vinculados AS (
  SELECT
    u.persona_id,
    LOWER(BTRIM(u.email)) AS correo_silver,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(BTRIM(u.email))
      ORDER BY u.id
    ) AS posicion
  FROM usuarios u
  WHERE u.persona_id IS NOT NULL
    AND NULLIF(BTRIM(u.email), '') IS NOT NULL
)
UPDATE personas p
SET correo_silver = cv.correo_silver,
    updated_at = CURRENT_TIMESTAMP
FROM correos_vinculados cv
WHERE p.id = cv.persona_id
  AND cv.posicion = 1
  AND NULLIF(BTRIM(p.correo_silver), '') IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_correo_silver_lower
  ON personas (LOWER(BTRIM(correo_silver)))
  WHERE NULLIF(BTRIM(correo_silver), '') IS NOT NULL;

COMMENT ON COLUMN personas.correo_silver IS
  'Correo corporativo de Silver usado para vincular la persona con su identidad Microsoft.';

COMMIT;
