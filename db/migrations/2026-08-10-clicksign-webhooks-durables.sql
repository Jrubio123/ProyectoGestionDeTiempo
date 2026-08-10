CREATE TABLE IF NOT EXISTS clicksign_webhook_eventos (
    id BIGSERIAL PRIMARY KEY,
    event_key VARCHAR(64) NOT NULL UNIQUE,
    payload JSONB NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'procesando', 'procesado', 'error')),
    intentos INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
    siguiente_intento_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ultimo_error TEXT,
    recibido_at TIMESTAMP NOT NULL DEFAULT NOW(),
    procesado_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clicksign_webhook_pendientes
    ON clicksign_webhook_eventos (siguiente_intento_at, id)
    WHERE estado IN ('pendiente', 'error');

COMMENT ON TABLE clicksign_webhook_eventos IS
    'Bandeja durable e idempotente de webhooks Click&Sign; el evento se persiste antes de responder HTTP 200';
