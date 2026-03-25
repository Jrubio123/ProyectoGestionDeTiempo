BEGIN;

ALTER TABLE anexo_tecnico_items
  ADD COLUMN IF NOT EXISTS usuario_id INT,
  ADD COLUMN IF NOT EXISTS modulo_id INT,
  ADD COLUMN IF NOT EXISTS estado_firma VARCHAR(20),
  ADD COLUMN IF NOT EXISTS updated_by INT;

UPDATE anexo_tecnico_items
SET estado_firma = 'pendiente'
WHERE estado_firma IS NULL
   OR BTRIM(estado_firma) = '';

ALTER TABLE anexo_tecnico_items
  ALTER COLUMN estado_firma SET DEFAULT 'pendiente';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_anexo_tecnico_items_usuario'
  ) THEN
    ALTER TABLE anexo_tecnico_items
      ADD CONSTRAINT fk_anexo_tecnico_items_usuario
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_anexo_tecnico_items_modulo'
  ) THEN
    ALTER TABLE anexo_tecnico_items
      ADD CONSTRAINT fk_anexo_tecnico_items_modulo
      FOREIGN KEY (modulo_id) REFERENCES modulo(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_anexo_tecnico_items_updated_by'
  ) THEN
    ALTER TABLE anexo_tecnico_items
      ADD CONSTRAINT fk_anexo_tecnico_items_updated_by
      FOREIGN KEY (updated_by) REFERENCES usuarios(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'anexo_tecnico_items_estado_firma_check'
  ) THEN
    ALTER TABLE anexo_tecnico_items
      ADD CONSTRAINT anexo_tecnico_items_estado_firma_check
      CHECK (estado_firma IN ('pendiente', 'enviado', 'firmado'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_estado_firma
  ON anexo_tecnico_items(estado_firma);

CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_usuario
  ON anexo_tecnico_items(usuario_id);

CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_modulo
  ON anexo_tecnico_items(modulo_id);

CREATE TABLE IF NOT EXISTS tokens_firma_anexo_individual (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  token VARCHAR(64) UNIQUE NOT NULL,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  anexo_item_ids INT[] NOT NULL,
  correo_firmante VARCHAR(255) NOT NULL,
  nombre_persona VARCHAR(200) NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'enviado'
    CHECK (estado IN ('enviado', 'firmado', 'rechazado', 'cancelado')),
  request_id VARCHAR(150) UNIQUE,
  contract_id VARCHAR(200) UNIQUE,
  signature_id VARCHAR(150),
  url_firma TEXT,
  onedrive_url TEXT,
  onedrive_carpeta TEXT,
  onedrive_carpeta_url TEXT,
  firmado_at TIMESTAMP,
  cancelado_at TIMESTAMP,
  cancelado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
  firma_notificada_at TIMESTAMP,
  firma_notificada_a TEXT,
  generado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE tokens_firma_anexo_individual
  ADD COLUMN IF NOT EXISTS public_id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS token VARCHAR(64),
  ADD COLUMN IF NOT EXISTS usuario_id INT,
  ADD COLUMN IF NOT EXISTS anexo_item_ids INT[],
  ADD COLUMN IF NOT EXISTS correo_firmante VARCHAR(255),
  ADD COLUMN IF NOT EXISTS nombre_persona VARCHAR(200),
  ADD COLUMN IF NOT EXISTS estado VARCHAR(20),
  ADD COLUMN IF NOT EXISTS request_id VARCHAR(150),
  ADD COLUMN IF NOT EXISTS contract_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS signature_id VARCHAR(150),
  ADD COLUMN IF NOT EXISTS url_firma TEXT,
  ADD COLUMN IF NOT EXISTS onedrive_url TEXT,
  ADD COLUMN IF NOT EXISTS onedrive_carpeta TEXT,
  ADD COLUMN IF NOT EXISTS onedrive_carpeta_url TEXT,
  ADD COLUMN IF NOT EXISTS firmado_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cancelado_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cancelado_por INT,
  ADD COLUMN IF NOT EXISTS firma_notificada_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS firma_notificada_a TEXT,
  ADD COLUMN IF NOT EXISTS generado_por INT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

UPDATE tokens_firma_anexo_individual
SET public_id = gen_random_uuid()
WHERE public_id IS NULL;

UPDATE tokens_firma_anexo_individual
SET estado = 'enviado'
WHERE estado IS NULL
   OR BTRIM(estado) = '';

ALTER TABLE tokens_firma_anexo_individual
  ALTER COLUMN public_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN estado SET DEFAULT 'enviado',
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_tokens_firma_anexo_usuario'
  ) THEN
    ALTER TABLE tokens_firma_anexo_individual
      ADD CONSTRAINT fk_tokens_firma_anexo_usuario
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_tokens_firma_anexo_cancelado_por'
  ) THEN
    ALTER TABLE tokens_firma_anexo_individual
      ADD CONSTRAINT fk_tokens_firma_anexo_cancelado_por
      FOREIGN KEY (cancelado_por) REFERENCES usuarios(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_tokens_firma_anexo_generado_por'
  ) THEN
    ALTER TABLE tokens_firma_anexo_individual
      ADD CONSTRAINT fk_tokens_firma_anexo_generado_por
      FOREIGN KEY (generado_por) REFERENCES usuarios(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tokens_firma_anexo_individual_estado_check'
  ) THEN
    ALTER TABLE tokens_firma_anexo_individual
      ADD CONSTRAINT tokens_firma_anexo_individual_estado_check
      CHECK (estado IN ('enviado', 'firmado', 'rechazado', 'cancelado'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_token
  ON tokens_firma_anexo_individual(token);

CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_usuario
  ON tokens_firma_anexo_individual(usuario_id);

CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_estado
  ON tokens_firma_anexo_individual(estado);

CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_request
  ON tokens_firma_anexo_individual(request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_contract
  ON tokens_firma_anexo_individual(contract_id)
  WHERE contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_usuario_enviado
  ON tokens_firma_anexo_individual(usuario_id, estado)
  WHERE estado = 'enviado';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'update_updated_at_column'
  ) THEN
    DROP TRIGGER IF EXISTS update_tokens_firma_anexo_individual_updated_at
      ON tokens_firma_anexo_individual;

    CREATE TRIGGER update_tokens_firma_anexo_individual_updated_at
    BEFORE UPDATE ON tokens_firma_anexo_individual
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

COMMIT;
