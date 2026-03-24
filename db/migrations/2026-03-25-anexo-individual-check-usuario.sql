-- Permite filas del anexo técnico individual (TH) ancladas solo a usuario_id,
-- sin solicitud_contratacion ni preregistro.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  WHERE con.conrelid = 'anexo_tecnico_items'::regclass
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%solicitud_contratacion_id%'
    AND pg_get_constraintdef(con.oid) LIKE '%preregistro_id%'
    AND pg_get_constraintdef(con.oid) NOT LIKE '%usuario_id%'
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE anexo_tecnico_items DROP CONSTRAINT %I', cname);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'anexo_tecnico_items_origen_proceso_check'
  ) THEN
    ALTER TABLE anexo_tecnico_items
      ADD CONSTRAINT anexo_tecnico_items_origen_proceso_check
      CHECK (
        solicitud_contratacion_id IS NOT NULL
        OR preregistro_id IS NOT NULL
        OR usuario_id IS NOT NULL
      );
  END IF;
END $$;
