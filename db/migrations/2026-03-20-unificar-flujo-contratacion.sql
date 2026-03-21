BEGIN;

ALTER TABLE solicitudes_contratacion
  ADD COLUMN IF NOT EXISTS preregistro_id INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_solicitudes_contratacion_preregistro'
  ) THEN
    ALTER TABLE solicitudes_contratacion
      ADD CONSTRAINT fk_solicitudes_contratacion_preregistro
      FOREIGN KEY (preregistro_id) REFERENCES preregistro_personas(id);
  END IF;
END $$;

ALTER TABLE solicitudes_contratacion
  ADD COLUMN IF NOT EXISTS origen_flujo VARCHAR(20) NOT NULL DEFAULT 'coordinacion';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_solicitudes_contratacion_origen_flujo'
  ) THEN
    ALTER TABLE solicitudes_contratacion
      ADD CONSTRAINT ck_solicitudes_contratacion_origen_flujo
      CHECK (origen_flujo IN ('rrhh', 'coordinacion'));
  END IF;
END $$;

UPDATE solicitudes_contratacion sc
SET origen_flujo = CASE
  WHEN LOWER(COALESCE(sc.datos_extra->>'origen', '')) = 'rrhh' THEN 'rrhh'
  ELSE 'coordinacion'
END;

UPDATE solicitudes_contratacion sc
SET preregistro_id = pp.id
FROM preregistro_personas pp
WHERE sc.preregistro_id IS NULL
  AND COALESCE(sc.datos_extra->>'preregistro_id', '') = pp.public_id::text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'solicitudes_contratacion'
      AND column_name = 'moneda'
      AND udt_name <> 'tipo_moneda'
  ) THEN
    ALTER TABLE solicitudes_contratacion
      ALTER COLUMN moneda TYPE tipo_moneda
      USING (
        CASE
          WHEN moneda IS NULL OR BTRIM(moneda) = '' THEN NULL
          WHEN UPPER(BTRIM(moneda)) IN ('COP', 'USD', 'EUR') THEN UPPER(BTRIM(moneda))
          ELSE NULL
        END
      )::tipo_moneda;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contrataciones_preregistro
  ON solicitudes_contratacion(preregistro_id)
  WHERE preregistro_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'tokens_firma_contrato'
  ) THEN
    ALTER TABLE tokens_firma_contrato
      ADD COLUMN IF NOT EXISTS firma_completada_notificada_at TIMESTAMP;

    ALTER TABLE tokens_firma_contrato
      ADD COLUMN IF NOT EXISTS firma_completada_notificada_a VARCHAR(255);
  END IF;
END $$;

COMMIT;
