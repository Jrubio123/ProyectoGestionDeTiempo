BEGIN;

ALTER TABLE vacaciones_solicitudes
  ADD COLUMN IF NOT EXISTS dias_disfrutados SMALLINT,
  ADD COLUMN IF NOT EXISTS dias_compensados SMALLINT;

UPDATE vacaciones_solicitudes
SET dias_disfrutados = COALESCE(dias_disfrutados, dias_habiles),
    dias_compensados = COALESCE(dias_compensados, 0)
WHERE dias_disfrutados IS NULL OR dias_compensados IS NULL;

ALTER TABLE vacaciones_solicitudes
  ALTER COLUMN dias_disfrutados SET NOT NULL,
  ALTER COLUMN dias_compensados SET DEFAULT 0,
  ALTER COLUMN dias_compensados SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vacaciones_solicitudes'::regclass
      AND conname = 'vacaciones_dias_disfrutados_check'
  ) THEN
    ALTER TABLE vacaciones_solicitudes
      ADD CONSTRAINT vacaciones_dias_disfrutados_check CHECK (dias_disfrutados > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vacaciones_solicitudes'::regclass
      AND conname = 'vacaciones_dias_compensados_check'
  ) THEN
    ALTER TABLE vacaciones_solicitudes
      ADD CONSTRAINT vacaciones_dias_compensados_check CHECK (dias_compensados >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vacaciones_solicitudes'::regclass
      AND conname = 'vacaciones_dias_suma_check'
  ) THEN
    ALTER TABLE vacaciones_solicitudes
      ADD CONSTRAINT vacaciones_dias_suma_check
      CHECK (dias_habiles = dias_disfrutados + dias_compensados);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vacaciones_solicitudes'::regclass
      AND conname = 'vacaciones_dias_compensados_max_check'
  ) THEN
    ALTER TABLE vacaciones_solicitudes
      ADD CONSTRAINT vacaciones_dias_compensados_max_check
      CHECK (dias_compensados * 2 <= dias_habiles);
  END IF;
END $$;

COMMENT ON COLUMN vacaciones_solicitudes.dias_disfrutados
  IS 'Días hábiles que generan ausencia efectiva.';
COMMENT ON COLUMN vacaciones_solicitudes.dias_compensados
  IS 'Días reconocidos en dinero; máximo la mitad entera del total solicitado.';

COMMIT;
