BEGIN;

CREATE TABLE IF NOT EXISTS entregas_servicio_consultores_modulos (
    entrega_consultor_id BIGINT NOT NULL
        REFERENCES entregas_servicio_consultores(id) ON DELETE CASCADE,
    entrega_modulo_id INTEGER NOT NULL
        REFERENCES entregas_servicio_modulos(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entrega_consultor_id, entrega_modulo_id)
);

CREATE INDEX IF NOT EXISTS idx_entrega_consultor_modulo_modulo
    ON entregas_servicio_consultores_modulos(entrega_modulo_id);

COMMIT;
