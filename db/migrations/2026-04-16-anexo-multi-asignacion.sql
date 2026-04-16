-- Permite que una persona tenga varias asignaciones activas en el anexo tecnico.
-- Las asignaciones por horas/capacitacion tambien pueden estar asociadas a cliente.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  WHERE con.conrelid = 'anexo_tecnico_items'::regclass
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%tipo_asignacion%'
    AND pg_get_constraintdef(con.oid) LIKE '%cliente_id%'
    AND pg_get_constraintdef(con.oid) LIKE '%horas%'
    AND pg_get_constraintdef(con.oid) LIKE '%cliente_id IS NULL%'
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE anexo_tecnico_items DROP CONSTRAINT %I', cname);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'anexo_tecnico_items'::regclass
      AND conname = 'anexo_tecnico_items_cliente_por_tipo_check'
  ) THEN
    ALTER TABLE anexo_tecnico_items
      ADD CONSTRAINT anexo_tecnico_items_cliente_por_tipo_check
      CHECK (
        (tipo_asignacion IN ('full_time', 'medio_tiempo', 'proyecto') AND cliente_id IS NOT NULL)
        OR tipo_asignacion IN ('horas', 'capacitacion')
      );
  END IF;
END $$;
