CREATE TABLE IF NOT EXISTS tokens_firma_contrato (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    token VARCHAR(64) UNIQUE NOT NULL,
    solicitud_id INT REFERENCES solicitudes_contratacion(id) ON DELETE SET NULL,
    preregistro_id INT REFERENCES preregistro_personas(id) ON DELETE SET NULL,
    nombre_persona VARCHAR(200) NOT NULL,
    correo_personal VARCHAR(255) NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'en_proceso', 'completado', 'expirado')),
    checks_completados JSONB NOT NULL DEFAULT '{"pdf1":false,"pdf2":false,"pdf3":false,"pdf4":false,"pdf5":false}',
    docs_firma JSONB NOT NULL DEFAULT '[]',
    generado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tokens_firma_token ON tokens_firma_contrato(token);
CREATE INDEX IF NOT EXISTS idx_tokens_firma_estado ON tokens_firma_contrato(estado);
CREATE INDEX IF NOT EXISTS idx_tokens_firma_correo ON tokens_firma_contrato(correo_personal);
CREATE INDEX IF NOT EXISTS idx_tokens_firma_expires ON tokens_firma_contrato(expires_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    DROP TRIGGER IF EXISTS update_tokens_firma_contrato_updated_at ON tokens_firma_contrato;
    CREATE TRIGGER update_tokens_firma_contrato_updated_at
    BEFORE UPDATE ON tokens_firma_contrato
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

COMMENT ON TABLE tokens_firma_contrato IS 'Tokens de acceso para el proceso publico de revision y firma de contratos';
COMMENT ON COLUMN tokens_firma_contrato.checks_completados IS 'Estado de lectura de cada PDF informativo {pdf1, pdf2, pdf3, pdf4, pdf5}';
COMMENT ON COLUMN tokens_firma_contrato.docs_firma IS 'Array de documentos de firma con request_id ClickSign, estado y URL OneDrive';
