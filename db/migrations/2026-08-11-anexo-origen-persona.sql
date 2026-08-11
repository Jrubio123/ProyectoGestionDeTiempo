BEGIN;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'anexo_tecnico_items'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%solicitud_contratacion_id%'
      AND pg_get_constraintdef(con.oid) ILIKE '%preregistro_id%'
  LOOP
    EXECUTE format(
      'ALTER TABLE anexo_tecnico_items DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE anexo_tecnico_items
  ADD CONSTRAINT anexo_tecnico_items_origen_proceso_check
  CHECK (
    solicitud_contratacion_id IS NOT NULL
    OR preregistro_id IS NOT NULL
    OR usuario_id IS NOT NULL
    OR NULLIF(BTRIM(numero_documento), '') IS NOT NULL
  );

COMMIT;
