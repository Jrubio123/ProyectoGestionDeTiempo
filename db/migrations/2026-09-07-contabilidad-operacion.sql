BEGIN;

ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS es_economia_naranja BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS moneda_cobro tipo_moneda;

UPDATE personas p
SET moneda_cobro = u.moneda_cobro
FROM usuarios u
WHERE u.persona_id = p.id
  AND p.moneda_cobro IS NULL
  AND u.moneda_cobro IS NOT NULL;

ALTER TABLE documento_identidad
  ADD COLUMN IF NOT EXISTS codigo_bancario VARCHAR(10);

UPDATE documento_identidad
SET codigo_bancario = CASE UPPER(BTRIM(codigo))
  WHEN 'CC' THEN '1'
  WHEN 'CE' THEN '2'
  WHEN 'NIT' THEN '3'
  WHEN 'TI' THEN '4'
  WHEN 'PA' THEN '5'
  WHEN 'DNI' THEN '6'
  ELSE codigo_bancario
END
WHERE codigo_bancario IS NULL;

INSERT INTO documento_identidad (titulo, codigo, codigo_bancario, activo)
VALUES
  ('Tarjeta de Identidad', 'TI', '4', TRUE),
  ('DNI', 'DNI', '6', TRUE)
ON CONFLICT (titulo) DO UPDATE
SET codigo_bancario = EXCLUDED.codigo_bancario,
    activo = TRUE,
    updated_at = CURRENT_TIMESTAMP;

ALTER TABLE facturas_proveedores
  ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE,
  ADD COLUMN IF NOT EXISTS anticipo NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tiene_iva BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ciudad_servicio VARCHAR(120),
  ADD COLUMN IF NOT EXISTS moneda VARCHAR(3) NOT NULL DEFAULT 'COP',
  ADD COLUMN IF NOT EXISTS documento_soporte JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS fecha_pago_preferida DATE;

ALTER TABLE facturas_proveedores
  ALTER COLUMN tipo_gasto TYPE VARCHAR(40),
  DROP CONSTRAINT IF EXISTS facturas_proveedores_tipo_gasto_check;

UPDATE facturas_proveedores SET tiene_iva = TRUE WHERE iva > 0 AND tiene_iva = FALSE;
UPDATE facturas_proveedores SET tipo_gasto = 'arrendamiento_inmueble' WHERE tipo_gasto = 'arriendo';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'personas' AND column_name = 'moneda_cobro'
  ) THEN
    EXECUTE $sql$
      UPDATE facturas_proveedores fp
      SET moneda = COALESCE(NULLIF(p.moneda_cobro::text, ''), 'USD')
      FROM personas p
      WHERE p.id = fp.persona_id AND p.factura_en_colombia = FALSE
    $sql$;
  ELSE
    UPDATE facturas_proveedores fp
    SET moneda = 'USD'
    FROM personas p
    WHERE p.id = fp.persona_id AND p.factura_en_colombia = FALSE;
  END IF;
END $$;

ALTER TABLE facturas_proveedores
  ADD CONSTRAINT facturas_proveedores_tipo_gasto_check
  CHECK (tipo_gasto IN (
    'consultor', 'honorarios', 'compra', 'servicio',
    'arrendamiento_inmueble', 'arrendamiento_mueble'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS uq_facturas_proveedor_numero_normalizado
  ON facturas_proveedores(persona_id, LOWER(BTRIM(numero_factura)));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facturas_proveedores_anticipo_check') THEN
    ALTER TABLE facturas_proveedores
      ADD CONSTRAINT facturas_proveedores_anticipo_check
      CHECK (anticipo >= 0 AND anticipo <= subtotal + iva);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facturas_proveedores_moneda_check') THEN
    ALTER TABLE facturas_proveedores
      ADD CONSTRAINT facturas_proveedores_moneda_check
      CHECK (moneda IN ('COP', 'USD', 'EUR'));
  END IF;
END $$;

ALTER TABLE proyeccion_pagos_detalle
  ADD COLUMN IF NOT EXISTS anticipo NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tipo_documento_pago VARCHAR(30),
  ADD COLUMN IF NOT EXISTS datos_beneficiario_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS regla_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS calculo_origen VARCHAR(20) NOT NULL DEFAULT 'Automatico',
  ADD COLUMN IF NOT EXISTS motivo_ajuste VARCHAR(500);

UPDATE proyeccion_pagos_detalle d
SET tipo_documento_pago = CASE
      WHEN d.origen_tipo = 'nomina' THEN 'nomina'
      WHEN d.origen_tipo = 'factura_proveedor' THEN 'factura_electronica'
      WHEN p.facturador_electronico THEN 'factura_electronica'
      ELSE 'cuenta_cobro'
    END,
    datos_beneficiario_snapshot = jsonb_build_object(
      'persona_id', p.public_id::text,
      'tipo_documento', di.titulo,
      'tipo_documento_bancario', di.codigo_bancario,
      'numero_documento', p.numero_documento,
      'nombre', BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)),
      'email', COALESCE(p.correo_electronico, p.correo_silver),
      'banco', b.titulo,
      'codigo_banco', b.codigo_conversor,
      'codigo_bancolombia', b.codigo_bancolombia,
      'tipo_cuenta', tcb.titulo,
      'tipo_transaccion', tcb.tipo_transaccion,
      'numero_cuenta', p.numero_cuenta
    )
FROM personas p
LEFT JOIN documento_identidad di ON di.id = p.tipo_documento_id
LEFT JOIN bancos b ON b.id = p.banco_id
LEFT JOIN tipo_cuenta_bancaria tcb ON tcb.id = p.tipo_cuenta_id
WHERE p.id = d.persona_id
  AND (d.tipo_documento_pago IS NULL OR d.datos_beneficiario_snapshot = '{}'::jsonb);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proyeccion_detalle_anticipo_check') THEN
    ALTER TABLE proyeccion_pagos_detalle
      ADD CONSTRAINT proyeccion_detalle_anticipo_check CHECK (anticipo >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proyeccion_detalle_calculo_origen_check') THEN
    ALTER TABLE proyeccion_pagos_detalle
      ADD CONSTRAINT proyeccion_detalle_calculo_origen_check
      CHECK (calculo_origen IN ('Automatico', 'Manual'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS contabilidad_reglas_retencion (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  concepto VARCHAR(40) NOT NULL,
  tipo_documento_pago VARCHAR(30) NOT NULL DEFAULT 'cualquiera',
  nombre VARCHAR(120) NOT NULL,
  base_minima NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (base_minima >= 0),
  porcentaje_fuente_declarante NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (porcentaje_fuente_declarante BETWEEN 0 AND 100),
  porcentaje_fuente_no_declarante NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (porcentaje_fuente_no_declarante BETWEEN 0 AND 100),
  porcentaje_iva NUMERIC(7,4) NOT NULL DEFAULT 19 CHECK (porcentaje_iva BETWEEN 0 AND 100),
  porcentaje_reteiva NUMERIC(7,4) NOT NULL DEFAULT 15 CHECK (porcentaje_reteiva BETWEEN 0 AND 100),
  base_reteica NUMERIC(15,2) NOT NULL DEFAULT 785610 CHECK (base_reteica >= 0),
  porcentaje_reteica NUMERIC(7,4) NOT NULL DEFAULT 0.18 CHECK (porcentaje_reteica BETWEEN 0 AND 100),
  vigencia_desde DATE NOT NULL DEFAULT CURRENT_DATE,
  vigencia_hasta DATE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde)
);

ALTER TABLE contabilidad_reglas_retencion
  ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contabilidad_reglas_vigentes
  ON contabilidad_reglas_retencion(concepto, tipo_documento_pago, activo, vigencia_desde DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contabilidad_reglas_inicio
  ON contabilidad_reglas_retencion(concepto, tipo_documento_pago, vigencia_desde);

INSERT INTO contabilidad_reglas_retencion (
  concepto, tipo_documento_pago, nombre, base_minima,
  porcentaje_fuente_declarante, porcentaje_fuente_no_declarante, vigencia_desde
) VALUES
  ('consultor', 'cuenta_cobro', 'Consultor con cuenta de cobro', 1750905, 3.5, 3.5, DATE '2026-09-07'),
  ('consultor', 'factura_electronica', 'Consultor con factura electrónica', 1, 3.5, 3.5, DATE '2026-09-07'),
  ('honorarios', 'cualquiera', 'Honorarios intelectuales', 1, 11, 10, DATE '2026-09-07'),
  ('compra', 'cualquiera', 'Compras', 524000, 2.5, 3.5, DATE '2026-09-07'),
  ('servicio', 'cualquiera', 'Servicios generales', 105000, 4, 6, DATE '2026-09-07'),
  ('arrendamiento_inmueble', 'cualquiera', 'Arrendamiento de inmueble', 1, 3.5, 3.5, DATE '2026-09-07'),
  ('arrendamiento_mueble', 'cualquiera', 'Arrendamiento de mueble', 524000, 4, 4, DATE '2026-09-07')
ON CONFLICT (concepto, tipo_documento_pago, vigencia_desde) DO NOTHING;

COMMIT;
