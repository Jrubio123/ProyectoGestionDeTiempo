BEGIN;

ALTER TABLE tokens_firma_contrato
  ADD COLUMN IF NOT EXISTS firma_completada_notificacion_pendiente_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS firma_completada_notificacion_intentos INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS firma_completada_notificacion_error TEXT;

UPDATE tokens_firma_contrato
SET firma_completada_notificacion_pendiente_at = COALESCE(
      firma_completada_notificacion_pendiente_at,
      updated_at,
      created_at,
      NOW()
    )
WHERE estado = 'completado'
  AND firma_completada_notificada_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tokens_firma_notificacion_pendiente
  ON tokens_firma_contrato(firma_completada_notificacion_pendiente_at)
  WHERE estado = 'completado' AND firma_completada_notificada_at IS NULL;

COMMENT ON COLUMN tokens_firma_contrato.firma_completada_notificacion_pendiente_at
  IS 'Inicio de la espera para notificar; permite aguardar los archivos OneDrive sin retrasar el cierre legal.';

COMMIT;
