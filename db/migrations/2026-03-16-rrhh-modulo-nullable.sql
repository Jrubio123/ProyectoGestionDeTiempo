-- Permite que modulo_id sea NULL en solicitudes_rrhh
-- para soportar el caso "Otros" donde el coordinador describe libremente el perfil.

ALTER TABLE solicitudes_rrhh
  ALTER COLUMN modulo_id DROP NOT NULL;
