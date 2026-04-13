BEGIN;

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS factura_en_colombia BOOLEAN;

ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS factura_en_colombia BOOLEAN;

COMMIT;
