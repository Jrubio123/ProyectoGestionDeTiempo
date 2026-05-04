BEGIN;
ALTER TABLE solicitudes_contratacion ADD COLUMN IF NOT EXISTS crear_usuario_sistema BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE preregistro_personas ADD COLUMN IF NOT EXISTS crear_usuario_sistema BOOLEAN NOT NULL DEFAULT true;
COMMIT;
