BEGIN;

DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'anexo_tecnico_items'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%tipo_asignacion%'
      AND pg_get_constraintdef(oid) ILIKE '%cliente_id%'
  LOOP
    EXECUTE format('ALTER TABLE anexo_tecnico_items DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;

ALTER TABLE anexo_tecnico_items
  ADD CONSTRAINT anexo_tecnico_items_cliente_por_tipo_check
  CHECK (
    (
      tipo_asignacion IN ('full_time', 'medio_tiempo', 'proyecto')
      AND (cliente_id IS NOT NULL OR NULLIF(BTRIM(cliente_nombre), '') IS NOT NULL)
    )
    OR tipo_asignacion IN ('horas', 'capacitacion')
  );

COMMIT;
