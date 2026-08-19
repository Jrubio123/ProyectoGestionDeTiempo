DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tipo_estado_mesa') THEN
    ALTER TYPE tipo_estado_mesa ADD VALUE IF NOT EXISTS 'Transferido Silver';
    ALTER TYPE tipo_estado_mesa ADD VALUE IF NOT EXISTS 'Transferido Corona';
  END IF;
END$$;
