CREATE TABLE IF NOT EXISTS entregas_servicio_enlaces (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    entrega_servicio_id INTEGER NOT NULL REFERENCES entregas_servicio(id) ON DELETE CASCADE,
    titulo VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_entrega_servicio_enlace UNIQUE (entrega_servicio_id, url)
);

CREATE INDEX IF NOT EXISTS idx_entregas_servicio_enlaces_entrega
    ON entregas_servicio_enlaces(entrega_servicio_id);

-- Conserva los enlaces registrados antes de retirar la carga de archivos.
INSERT INTO entregas_servicio_enlaces (public_id, entrega_servicio_id, titulo, url, created_at)
SELECT public_id, entrega_servicio_id, nombre_archivo, web_url, created_at
FROM entregas_servicio_documentos
WHERE origen = 'LINK_EXTERNO'
ON CONFLICT (entrega_servicio_id, url) DO NOTHING;
