ALTER TABLE entregas_servicio_proyecto
    ADD COLUMN IF NOT EXISTS valor_forma_pago NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS moneda_forma_pago VARCHAR(3) NOT NULL DEFAULT 'COP';

UPDATE entregas_servicio_proyecto
SET valor_forma_pago = 0
WHERE valor_forma_pago IS NULL;

UPDATE entregas_servicio_proyecto
SET tarifa_consultoria = 0
WHERE tarifa_consultoria IS NULL;

ALTER TABLE entregas_servicio_proyecto
    ALTER COLUMN valor_forma_pago SET NOT NULL,
    ALTER COLUMN tarifa_consultoria SET NOT NULL,
    DROP COLUMN IF EXISTS forma_pago,
    DROP COLUMN IF EXISTS tarifas_consultoria;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entrega_proyecto_valor_forma_pago_check'
    ) THEN
        ALTER TABLE entregas_servicio_proyecto
            ADD CONSTRAINT entrega_proyecto_valor_forma_pago_check
            CHECK (valor_forma_pago >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entrega_proyecto_moneda_forma_pago_check'
    ) THEN
        ALTER TABLE entregas_servicio_proyecto
            ADD CONSTRAINT entrega_proyecto_moneda_forma_pago_check
            CHECK (moneda_forma_pago IN ('COP', 'USD', 'EUR'));
    END IF;
END $$;
