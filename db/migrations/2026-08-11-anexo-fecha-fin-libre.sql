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
      AND pg_get_constraintdef(con.oid) ILIKE '%fecha_fin%'
      AND pg_get_constraintdef(con.oid) ILIKE '%EXTRACT%'
  LOOP
    EXECUTE format(
      'ALTER TABLE anexo_tecnico_items DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE anexo_tecnico_items
  DROP CONSTRAINT IF EXISTS anexo_tecnico_items_fechas_check;

ALTER TABLE anexo_tecnico_items
  ADD CONSTRAINT anexo_tecnico_items_fechas_check
  CHECK (fecha_fin >= fecha_inicio);

COMMENT ON COLUMN anexo_tecnico_items.fecha_fin_calculada IS
  'true cuando fecha_fin se asignó automáticamente al 31 de diciembre; la fecha sigue siendo editable';

COMMIT;
