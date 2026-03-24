ALTER TABLE anexo_tecnico_items
  ADD COLUMN IF NOT EXISTS usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS modulo_id INT REFERENCES modulo(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS estado_firma VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES usuarios(id) ON DELETE SET NULL;

DO $$
BEGIN
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

UPDATE anexo_tecnico_items
SET estado_firma = 'pendiente'
WHERE estado_firma IS NULL;

UPDATE anexo_tecnico_items ati
SET usuario_id = sc.persona_usuario_id
FROM solicitudes_contratacion sc
WHERE ati.usuario_id IS NULL
  AND ati.solicitud_contratacion_id = sc.id
  AND sc.persona_usuario_id IS NOT NULL;

UPDATE anexo_tecnico_items ati
SET usuario_id = pp.id_usuario_creado
FROM preregistro_personas pp
WHERE ati.usuario_id IS NULL
  AND ati.preregistro_id = pp.id
  AND pp.id_usuario_creado IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_estado_firma ON anexo_tecnico_items(estado_firma);
CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_usuario ON anexo_tecnico_items(usuario_id);
CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_modulo ON anexo_tecnico_items(modulo_id);

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

CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_token ON tokens_firma_anexo_individual(token);
CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_usuario ON tokens_firma_anexo_individual(usuario_id);
CREATE INDEX IF NOT EXISTS idx_tokens_firma_anexo_estado ON tokens_firma_anexo_individual(estado);
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
    DROP TRIGGER IF EXISTS update_tokens_firma_anexo_individual_updated_at ON tokens_firma_anexo_individual;
    CREATE TRIGGER update_tokens_firma_anexo_individual_updated_at
    BEFORE UPDATE ON tokens_firma_anexo_individual
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

COMMENT ON TABLE tokens_firma_anexo_individual IS 'Procesos de firma individual para anexos tecnicos por usuario';
