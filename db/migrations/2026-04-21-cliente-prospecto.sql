BEGIN;

-- Permite registrar solicitudes RRHH para clientes prospecto que aún no están en catálogo.
ALTER TABLE solicitudes_rrhh
  ALTER COLUMN cliente_id DROP NOT NULL;

ALTER TABLE solicitudes_rrhh
  ADD COLUMN IF NOT EXISTS cliente_nombre_otro TEXT;

-- Índice para facilitar búsqueda de prospectos
CREATE INDEX IF NOT EXISTS idx_rrhh_cliente_nombre_otro
  ON solicitudes_rrhh(cliente_nombre_otro)
  WHERE cliente_nombre_otro IS NOT NULL;

COMMIT;
