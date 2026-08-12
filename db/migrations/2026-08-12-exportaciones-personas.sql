BEGIN;

CREATE TABLE IF NOT EXISTS exportaciones_personas_auditoria
(
    id BIGSERIAL PRIMARY KEY,
    usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    tipo_exportacion VARCHAR(20) NOT NULL
        CHECK (tipo_exportacion IN ('operativa', 'completa')),
    filtro_rol VARCHAR(255) NOT NULL DEFAULT 'Todos',
    total_registros INTEGER NOT NULL DEFAULT 0 CHECK (total_registros >= 0),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_exportaciones_personas_usuario
    ON exportaciones_personas_auditoria(usuario_id, created_at DESC);

COMMIT;
