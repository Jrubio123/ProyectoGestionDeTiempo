ALTER TABLE entregas_servicio_proyecto
    ADD COLUMN IF NOT EXISTS forma_pago TEXT;

UPDATE entregas_servicio_proyecto
SET forma_pago = 'Pendiente por definir'
WHERE forma_pago IS NULL;

ALTER TABLE entregas_servicio_proyecto
    ALTER COLUMN forma_pago SET NOT NULL,
    DROP COLUMN IF EXISTS valor_forma_pago,
    DROP COLUMN IF EXISTS moneda_forma_pago;
