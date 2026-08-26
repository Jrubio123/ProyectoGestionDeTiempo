ALTER TABLE entregas_servicio_proyecto
    ADD COLUMN IF NOT EXISTS tarifa_consultoria NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS moneda_tarifa_consultoria VARCHAR(3) NOT NULL DEFAULT 'COP';

ALTER TABLE entregas_servicio_proyecto
    ALTER COLUMN tarifas_consultoria DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entrega_proyecto_tarifa_consultoria_check'
    ) THEN
        ALTER TABLE entregas_servicio_proyecto
            ADD CONSTRAINT entrega_proyecto_tarifa_consultoria_check
            CHECK (tarifa_consultoria IS NULL OR tarifa_consultoria >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entrega_proyecto_moneda_tarifa_check'
    ) THEN
        ALTER TABLE entregas_servicio_proyecto
            ADD CONSTRAINT entrega_proyecto_moneda_tarifa_check
            CHECK (moneda_tarifa_consultoria IN ('COP', 'USD', 'EUR'));
    END IF;
END $$;
