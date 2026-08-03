BEGIN;

ALTER TABLE tokens_firma_anexo_individual
  ADD COLUMN IF NOT EXISTS persona_id INT REFERENCES personas(id) ON DELETE CASCADE;

UPDATE tokens_firma_anexo_individual t
SET persona_id = u.persona_id
FROM usuarios u
WHERE t.usuario_id = u.id
  AND t.persona_id IS NULL
  AND u.persona_id IS NOT NULL;

ALTER TABLE tokens_firma_anexo_individual
  ALTER COLUMN usuario_id DROP NOT NULL;

ALTER TABLE tokens_firma_anexo_individual
  DROP CONSTRAINT IF EXISTS tokens_firma_anexo_identidad_check;

ALTER TABLE tokens_firma_anexo_individual
  ADD CONSTRAINT tokens_firma_anexo_identidad_check
  CHECK (usuario_id IS NOT NULL OR persona_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_persona
  ON tokens_firma_anexo_individual(persona_id);

CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_persona_enviado
  ON tokens_firma_anexo_individual(persona_id, estado)
  WHERE persona_id IS NOT NULL AND estado = 'enviado';

COMMIT;
