BEGIN;

INSERT INTO estados_requerimiento_capacidad
  (codigo, nombre, consume_capacidad, categoria_codigo, clasificacion,
   es_terminal, permite_reactivacion, orden)
VALUES
  ('PLANIFICADO', 'Planificada', FALSE, NULL, 'activo', FALSE, TRUE, 5)
ON CONFLICT (codigo) DO UPDATE SET
  nombre = EXCLUDED.nombre,
  consume_capacidad = EXCLUDED.consume_capacidad,
  categoria_codigo = EXCLUDED.categoria_codigo,
  clasificacion = EXCLUDED.clasificacion,
  es_terminal = EXCLUDED.es_terminal,
  permite_reactivacion = EXCLUDED.permite_reactivacion,
  orden = EXCLUDED.orden,
  activo = TRUE,
  updated_at = CURRENT_TIMESTAMP;

ALTER TABLE requerimientos_capacidad
  ADD COLUMN IF NOT EXISTS tipo_registro VARCHAR(20) NOT NULL DEFAULT 'REQUERIMIENTO',
  ADD COLUMN IF NOT EXISTS categoria_actividad_codigo VARCHAR(40)
    REFERENCES categorias_esfuerzo_capacidad(codigo);

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'requerimientos_capacidad'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%origen%'
      AND pg_get_constraintdef(oid) ILIKE '%cliente_id%'
      AND pg_get_constraintdef(oid) ILIKE '%AZURE_DEVOPS%'
  LOOP
    EXECUTE format(
      'ALTER TABLE requerimientos_capacidad DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END
$$;

ALTER TABLE requerimientos_capacidad
  DROP CONSTRAINT IF EXISTS ck_requerimiento_tipo_registro,
  DROP CONSTRAINT IF EXISTS ck_requerimiento_actividad,
  ADD CONSTRAINT ck_requerimiento_tipo_registro
    CHECK (tipo_registro IN ('REQUERIMIENTO', 'ACTIVIDAD')),
  ADD CONSTRAINT ck_requerimiento_capacidad_origen
    CHECK (
      (origen = 'AZURE_DEVOPS'
        AND external_id IS NOT NULL
        AND organizacion_azure IS NOT NULL
        AND tipo_registro = 'REQUERIMIENTO')
      OR
      (origen = 'MANUAL'
        AND (tipo_registro = 'ACTIVIDAD' OR cliente_id IS NOT NULL))
    ),
  ADD CONSTRAINT ck_requerimiento_actividad
    CHECK (
      (tipo_registro = 'REQUERIMIENTO' AND categoria_actividad_codigo IS NULL)
      OR
      (tipo_registro = 'ACTIVIDAD'
        AND origen = 'MANUAL'
        AND categoria_actividad_codigo IS NOT NULL
        AND effort_total > 0
        AND fecha_inicio IS NOT NULL
        AND fecha_fin = fecha_inicio)
    );

CREATE INDEX IF NOT EXISTS idx_requerimientos_capacidad_tipo_registro
  ON requerimientos_capacidad(tipo_registro);
CREATE INDEX IF NOT EXISTS idx_requerimientos_capacidad_actividad_fecha
  ON requerimientos_capacidad(fecha_inicio)
  WHERE tipo_registro = 'ACTIVIDAD';

COMMENT ON COLUMN requerimientos_capacidad.tipo_registro IS
  'Diferencia requerimientos completos de actividades manuales puntuales para planeacion semanal.';
COMMENT ON COLUMN requerimientos_capacidad.categoria_actividad_codigo IS
  'Categoria que recibe el 100% de las horas cuando el registro es una actividad puntual.';

COMMIT;
