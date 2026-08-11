BEGIN;

ALTER TABLE tokens_firma_anexo_individual
  ADD COLUMN IF NOT EXISTS archivo_estado VARCHAR(20) DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS archivo_error TEXT,
  ADD COLUMN IF NOT EXISTS archivo_origen TEXT,
  ADD COLUMN IF NOT EXISTS archivo_file_id TEXT,
  ADD COLUMN IF NOT EXISTS archivo_file_group TEXT,
  ADD COLUMN IF NOT EXISTS archivo_file_type TEXT,
  ADD COLUMN IF NOT EXISTS archivo_file_name TEXT,
  ADD COLUMN IF NOT EXISTS archivo_catalogo_origen TEXT,
  ADD COLUMN IF NOT EXISTS archivo_catalogo JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS archivo_catalogo_actualizado_en TIMESTAMP,
  ADD COLUMN IF NOT EXISTS archivo_intentos INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ultimo_intento_archivo_en TIMESTAMP;

UPDATE tokens_firma_anexo_individual
SET archivo_estado = CASE
  WHEN NULLIF(BTRIM(onedrive_url), '') IS NOT NULL THEN 'subido'
  ELSE 'pendiente'
END
WHERE archivo_estado IS NULL
   OR BTRIM(archivo_estado) = '';

COMMIT;
