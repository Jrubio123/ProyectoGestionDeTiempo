BEGIN;

-- Perfil tributario requerido por el motor de retenciones.
ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS es_gran_contribuyente BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS es_autorretenedor BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS es_regimen_simple BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS es_entidad_sin_animo_lucro BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS facturador_electronico BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS acumulado_facturacion_anual NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS declarante_renta BOOLEAN NOT NULL DEFAULT FALSE;

-- Compatibilidad para una base que haya alcanzado a recibir la primera versión
-- del diseño: convierte el régimen único a su bandera equivalente antes de
-- retirar la columna. Después de esto las banderas pueden combinarse libremente.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'personas'
      AND column_name = 'regimen_tributario'
  ) THEN
    EXECUTE $sql$
      UPDATE personas
      SET es_gran_contribuyente = es_gran_contribuyente
            OR LOWER(BTRIM(regimen_tributario)) = 'gran contribuyente',
          es_autorretenedor = es_autorretenedor
            OR LOWER(BTRIM(regimen_tributario)) = 'autorretenedor',
          es_regimen_simple = es_regimen_simple
            OR LOWER(BTRIM(regimen_tributario)) IN ('simple', 'régimen simple', 'regimen simple'),
          es_entidad_sin_animo_lucro = es_entidad_sin_animo_lucro
            OR LOWER(BTRIM(regimen_tributario)) IN ('esal', 'entidad sin ánimo de lucro', 'entidad sin animo de lucro')
    $sql$;
  END IF;
END $$;

ALTER TABLE personas
  DROP COLUMN IF EXISTS regimen_tributario;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'personas_acumulado_facturacion_check'
  ) THEN
    ALTER TABLE personas
      ADD CONSTRAINT personas_acumulado_facturacion_check
      CHECK (acumulado_facturacion_anual >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS proyeccion_pagos (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  mes SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  anio SMALLINT NOT NULL CHECK (anio BETWEEN 2000 AND 2200),
  quincena SMALLINT NOT NULL CHECK (quincena IN (1, 2)),
  trm_oficial NUMERIC(10,2) CHECK (trm_oficial IS NULL OR trm_oficial > 0),
  estado VARCHAR(20) NOT NULL DEFAULT 'Borrador'
    CHECK (estado IN ('Borrador', 'Revisión', 'Aprobado', 'Pagado', 'Cancelado')),
  fecha_pago_programada DATE NOT NULL,
  revisado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  revisado_at TIMESTAMPTZ,
  aprobado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  aprobado_at TIMESTAMPTZ,
  pagado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  pagado_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_proyeccion_pagos_periodo_activa
  ON proyeccion_pagos(anio, mes, quincena)
  WHERE estado <> 'Cancelado';
CREATE INDEX IF NOT EXISTS idx_proyeccion_pagos_estado_periodo
  ON proyeccion_pagos(estado, anio DESC, mes DESC, quincena);
CREATE INDEX IF NOT EXISTS idx_proyeccion_pagos_fecha_pago
  ON proyeccion_pagos(fecha_pago_programada);

ALTER TABLE cuenta_cobro
  ADD COLUMN IF NOT EXISTS ciclo_proyeccion_asignado VARCHAR(20),
  ADD COLUMN IF NOT EXISTS proyeccion_pago_id INTEGER REFERENCES proyeccion_pagos(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cuenta_cobro_ciclo_proyeccion_check'
  ) THEN
    ALTER TABLE cuenta_cobro
      ADD CONSTRAINT cuenta_cobro_ciclo_proyeccion_check
      CHECK (ciclo_proyeccion_asignado IS NULL OR ciclo_proyeccion_asignado IN ('Q1', 'Q2'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cuenta_cobro_proyeccion
  ON cuenta_cobro(proyeccion_pago_id);
CREATE INDEX IF NOT EXISTS idx_cuenta_cobro_pendiente_proyeccion
  ON cuenta_cobro(estado, ciclo_proyeccion_asignado)
  WHERE proyeccion_pago_id IS NULL;

CREATE TABLE IF NOT EXISTS facturas_proveedores (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE RESTRICT,
  numero_factura VARCHAR(100) NOT NULL,
  fecha_emision DATE NOT NULL,
  concepto TEXT NOT NULL,
  subtotal NUMERIC(15,2) NOT NULL CHECK (subtotal >= 0),
  iva NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (iva >= 0),
  tipo_gasto VARCHAR(20) NOT NULL CHECK (tipo_gasto IN ('compra', 'servicio', 'arriendo')),
  estado VARCHAR(20) NOT NULL DEFAULT 'Pendiente'
    CHECK (estado IN ('Pendiente', 'Proyectada', 'Pagada', 'Anulada')),
  proyeccion_pago_id INTEGER REFERENCES proyeccion_pagos(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (persona_id, numero_factura)
);

CREATE INDEX IF NOT EXISTS idx_facturas_proveedores_pendientes
  ON facturas_proveedores(estado, fecha_emision)
  WHERE proyeccion_pago_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_facturas_proveedores_persona
  ON facturas_proveedores(persona_id);

CREATE TABLE IF NOT EXISTS nomina_pagos_manual (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  mes SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  anio SMALLINT NOT NULL CHECK (anio BETWEEN 2000 AND 2200),
  quincena SMALLINT NOT NULL CHECK (quincena IN (1, 2)),
  persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE RESTRICT,
  valor_neto NUMERIC(15,2) NOT NULL CHECK (valor_neto >= 0),
  estado VARCHAR(20) NOT NULL DEFAULT 'Pendiente'
    CHECK (estado IN ('Pendiente', 'Proyectada', 'Pagada', 'Anulada')),
  proyeccion_pago_id INTEGER REFERENCES proyeccion_pagos(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (anio, mes, quincena, persona_id)
);

CREATE INDEX IF NOT EXISTS idx_nomina_pagos_periodo
  ON nomina_pagos_manual(anio, mes, quincena, estado)
  WHERE proyeccion_pago_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_nomina_pagos_persona
  ON nomina_pagos_manual(persona_id);

CREATE TABLE IF NOT EXISTS proyeccion_pagos_detalle (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  proyeccion_id INTEGER NOT NULL REFERENCES proyeccion_pagos(id) ON DELETE CASCADE,
  origen_tipo VARCHAR(30) NOT NULL
    CHECK (origen_tipo IN ('cuenta_cobro', 'factura_proveedor', 'nomina')),
  origen_id INTEGER NOT NULL,
  persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE RESTRICT,
  tipo_pago VARCHAR(30) NOT NULL,
  moneda_origen VARCHAR(3) NOT NULL DEFAULT 'COP',
  valor_origen NUMERIC(15,2) NOT NULL CHECK (valor_origen >= 0),
  trm_aplicada NUMERIC(10,2) CHECK (trm_aplicada IS NULL OR trm_aplicada > 0),
  subtotal NUMERIC(15,2) NOT NULL CHECK (subtotal >= 0),
  iva NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (iva >= 0),
  retenciones_aplicadas JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(retenciones_aplicadas) = 'array'),
  valor_neto NUMERIC(15,2) NOT NULL CHECK (valor_neto >= 0),
  created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (proyeccion_id, origen_tipo, origen_id)
);

CREATE INDEX IF NOT EXISTS idx_proyeccion_detalle_proyeccion
  ON proyeccion_pagos_detalle(proyeccion_id, origen_tipo);
CREATE INDEX IF NOT EXISTS idx_proyeccion_detalle_persona
  ON proyeccion_pagos_detalle(persona_id);

CREATE TABLE IF NOT EXISTS proyeccion_pagos_auditoria (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  proyeccion_id INTEGER NOT NULL REFERENCES proyeccion_pagos(id) ON DELETE CASCADE,
  detalle_id INTEGER REFERENCES proyeccion_pagos_detalle(id) ON DELETE SET NULL,
  evento VARCHAR(50) NOT NULL,
  estado_anterior VARCHAR(20),
  estado_nuevo VARCHAR(20),
  datos JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proyeccion_auditoria_lote
  ON proyeccion_pagos_auditoria(proyeccion_id, created_at);

COMMIT;
