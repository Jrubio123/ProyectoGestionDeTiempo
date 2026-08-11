BEGIN;

ALTER TABLE tokens_firma_anexo_individual
  ADD COLUMN IF NOT EXISTS invitacion_enviada_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS invitacion_enviada_a TEXT,
  ADD COLUMN IF NOT EXISTS invitacion_error TEXT;

COMMENT ON COLUMN tokens_firma_anexo_individual.invitacion_enviada_at IS
  'Fecha en que la aplicación envió al firmante el enlace de Click&Sign';
COMMENT ON COLUMN tokens_firma_anexo_individual.invitacion_enviada_a IS
  'Correo personal al que se envió el enlace de firma';
COMMENT ON COLUMN tokens_firma_anexo_individual.invitacion_error IS
  'Último error al intentar enviar el enlace de firma';

COMMIT;
