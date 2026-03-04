DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tipo_aprobacion') THEN
    ALTER TYPE tipo_aprobacion ADD VALUE IF NOT EXISTS 'Revisión';
  END IF;
END$$;
