BEGIN;

-- Compatibilidad con back actual:
-- preregistro-routes.js usa columnas de texto legado
-- (responsable_supervisor y tipo_cuenta) además de las nuevas *_id.
ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS responsable_supervisor VARCHAR(150);

ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS tipo_cuenta VARCHAR(50);

COMMIT;
