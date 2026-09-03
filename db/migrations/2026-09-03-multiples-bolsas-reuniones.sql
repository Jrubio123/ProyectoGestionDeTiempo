BEGIN;

ALTER TABLE bolsas_reuniones_capacidad
  ADD COLUMN IF NOT EXISTS nombre VARCHAR(200);

UPDATE bolsas_reuniones_capacidad
SET nombre = 'Reuniones'
WHERE nombre IS NULL OR BTRIM(nombre) = '';

ALTER TABLE bolsas_reuniones_capacidad
  ALTER COLUMN nombre SET NOT NULL;

ALTER TABLE bolsas_reuniones_capacidad
  DROP CONSTRAINT IF EXISTS uq_bolsa_reuniones_persona_semana;

CREATE INDEX IF NOT EXISTS idx_bolsas_reuniones_persona_semana
  ON bolsas_reuniones_capacidad(persona_id, semana_inicio, created_at);

COMMIT;
