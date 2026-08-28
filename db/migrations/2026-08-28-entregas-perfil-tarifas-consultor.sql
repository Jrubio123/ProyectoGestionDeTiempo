BEGIN;

-- El perfil pertenece al cliente y no a cada entrega.
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS perfil_cliente VARCHAR(20);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'clientes_perfil_cliente_check'
          AND conrelid = 'clientes'::regclass
    ) THEN
        ALTER TABLE clientes
            ADD CONSTRAINT clientes_perfil_cliente_check
            CHECK (perfil_cliente IS NULL OR perfil_cliente IN ('CLAVE', 'NO_CLAVE', 'POR_DEFINIR'));
    END IF;
END $$;

-- Para clientes con entregas previas se conserva el perfil de la entrega más reciente.
WITH perfil_reciente AS (
    SELECT DISTINCT ON (cliente_id)
        cliente_id,
        perfil_cliente
    FROM entregas_servicio
    WHERE perfil_cliente IN ('CLAVE', 'NO_CLAVE', 'POR_DEFINIR')
    ORDER BY cliente_id, created_at DESC, id DESC
)
UPDATE clientes c
SET perfil_cliente = pr.perfil_cliente
FROM perfil_reciente pr
WHERE c.id = pr.cliente_id
  AND c.perfil_cliente IS NULL;

-- Se preservan las columnas antiguas para que un despliegue gradual no rompa el backend anterior.
ALTER TABLE entregas_servicio
    ALTER COLUMN perfil_cliente DROP NOT NULL,
    ALTER COLUMN analisis_adaptabilidad DROP NOT NULL;

ALTER TABLE entregas_servicio_consultores
    ADD COLUMN IF NOT EXISTS tarifa_consultoria NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS moneda_tarifa_consultoria VARCHAR(3) NOT NULL DEFAULT 'COP';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'entrega_consultor_tarifa_check'
          AND conrelid = 'entregas_servicio_consultores'::regclass
    ) THEN
        ALTER TABLE entregas_servicio_consultores
            ADD CONSTRAINT entrega_consultor_tarifa_check
            CHECK (tarifa_consultoria IS NULL OR tarifa_consultoria >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'entrega_consultor_moneda_tarifa_check'
          AND conrelid = 'entregas_servicio_consultores'::regclass
    ) THEN
        ALTER TABLE entregas_servicio_consultores
            ADD CONSTRAINT entrega_consultor_moneda_tarifa_check
            CHECK (moneda_tarifa_consultoria IN ('COP', 'USD', 'EUR'));
    END IF;
END $$;

-- Los proyectos anteriores tenían una tarifa global; se replica en sus consultores.
UPDATE entregas_servicio_consultores ec
SET tarifa_consultoria = p.tarifa_consultoria,
    moneda_tarifa_consultoria = p.moneda_tarifa_consultoria
FROM entregas_servicio_proyecto p
WHERE p.entrega_servicio_id = ec.entrega_servicio_id
  AND ec.tarifa_consultoria IS NULL
  AND p.tarifa_consultoria IS NOT NULL;

-- En outsourcing, la tarifa histórica representa el costo del consultor.
UPDATE entregas_servicio_consultores ec
SET tarifa_consultoria = o.tarifa,
    moneda_tarifa_consultoria = o.moneda
FROM entregas_servicio_outsourcing o
WHERE o.entrega_servicio_id = ec.entrega_servicio_id
  AND ec.tarifa_consultoria IS NULL;

-- La tarifa global del proyecto deja de ser obligatoria para entregas nuevas.
ALTER TABLE entregas_servicio_proyecto
    ALTER COLUMN tarifa_consultoria DROP NOT NULL;

ALTER TABLE entregas_servicio_outsourcing
    ALTER COLUMN tarifa DROP NOT NULL;

COMMIT;
