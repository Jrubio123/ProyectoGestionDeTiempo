BEGIN;

ALTER TABLE bolsas_reuniones_capacidad
  ADD COLUMN IF NOT EXISTS eliminado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eliminado_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS motivo_eliminacion VARCHAR(500);

ALTER TABLE bolsas_reuniones_capacidad
  DROP CONSTRAINT IF EXISTS bolsas_reuniones_capacidad_estado_check;

ALTER TABLE bolsas_reuniones_capacidad
  ADD CONSTRAINT bolsas_reuniones_capacidad_estado_check
  CHECK (estado IN ('ABIERTA', 'CERRADA', 'ELIMINADA'));

ALTER TABLE actividades_capacidad
  ADD COLUMN IF NOT EXISTS consume_bolsa BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE actividades_capacidad a
SET consume_bolsa = TRUE
WHERE EXISTS (
  SELECT 1
  FROM actividad_capacidad_responsables ar
  WHERE ar.actividad_id = a.id AND ar.bolsa_id IS NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bolsas_reuniones_historial
  ON bolsas_reuniones_capacidad(persona_id, semana_inicio DESC, estado);

COMMIT;
