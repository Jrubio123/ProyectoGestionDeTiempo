-- Debe ejecutarse después de 2026-08-25-entregas-servicio.sql.
BEGIN;

ALTER TABLE entregas_servicio_consultores
  DROP CONSTRAINT entregas_servicio_consultores_pkey;

ALTER TABLE entregas_servicio_consultores
  ADD COLUMN id BIGSERIAL,
  ADD COLUMN public_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN nombre_externo VARCHAR(255),
  ADD COLUMN telefono_externo VARCHAR(50),
  ALTER COLUMN consultor_id DROP NOT NULL;

ALTER TABLE entregas_servicio_consultores
  ADD CONSTRAINT entregas_servicio_consultores_pkey PRIMARY KEY (id),
  ADD CONSTRAINT entregas_servicio_consultores_public_id_unique UNIQUE (public_id),
  ADD CONSTRAINT entregas_servicio_consultor_origen_check CHECK (
    (consultor_id IS NOT NULL AND nombre_externo IS NULL AND telefono_externo IS NULL)
    OR (
      consultor_id IS NULL
      AND NULLIF(BTRIM(nombre_externo), '') IS NOT NULL
      AND NULLIF(BTRIM(telefono_externo), '') IS NOT NULL
    )
  );

CREATE UNIQUE INDEX uq_entrega_consultor_usuario
  ON entregas_servicio_consultores(entrega_servicio_id, consultor_id)
  WHERE consultor_id IS NOT NULL;

CREATE UNIQUE INDEX uq_entrega_consultor_externo
  ON entregas_servicio_consultores(
    entrega_servicio_id,
    LOWER(BTRIM(nombre_externo)),
    BTRIM(telefono_externo)
  )
  WHERE consultor_id IS NULL;

COMMIT;
