BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'grupo_usuario_tipo') THEN
    CREATE TYPE grupo_usuario_tipo AS ENUM ('ADMIN', 'COORDINADOR', 'CONSULTOR', 'CONTABILIDAD', 'COMERCIAL', 'Otro');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'grupo_distribucion_tipo') THEN
    CREATE TYPE grupo_distribucion_tipo AS ENUM ('Todos Silver', 'Vinculados', 'Responsable');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cargo_tipo') THEN
    CREATE TYPE cargo_tipo AS ENUM (
      'Analista Comercial',
      'Analista de Soporte',
      'Auxiliar Administrativa',
      'Auxiliar Administrativa y de Talento Humano',
      'Auxiliar Contable',
      'Consultor .Net',
      'Consultor ABAP',
      'Consultor ABAP CPI',
      'Consultor ABAP FIORI',
      'Consultor ABAP ISH',
      'Consultor ABAP TM',
      'Consultor ABAP WORKFLOW',
      'Consultor Basis',
      'Consultor BI',
      'Consultor BPC',
      'Consultor Business One',
      'Consultor CO',
      'Consultor CS',
      'Consultor DS',
      'Consultor EWM',
      'Consultor FI',
      'Consultor FICO',
      'Consultor FM',
      'Consultor GRC',
      'Consultor HCM',
      'Consultor Integración',
      'Consultor ISH',
      'Consultor LETRA',
      'Consultor MM',
      'Consultor PM',
      'Consultor PP',
      'Consultor PP QM',
      'Consultor PS',
      'Consultor QM',
      'Consultor RE',
      'Consultor SD',
      'Consultor SD LETRA',
      'Consultor SQL',
      'Consultor TM',
      'Consultor TRM',
      'Consultor WM',
      'Consultor Workflow',
      'Coordinadora de mesa de servicios',
      'Coordinadora de Proyectos',
      'Coordinadora de Servicios',
      'Gerente Comercial',
      'Gerente de Estrategia e Innovación',
      'Gerente de Servicios',
      'Líder Administrativa y de Talento Humano',
      'Líder de Fabrica',
      'Líder de Reclutamiento',
      'Consultor Power BI',
      'Consultor IBP'
    );
  END IF;
END $$;

INSERT INTO roles (titulo, descripcion, activo)
SELECT 'Talento Humano', 'Usuario de Talento Humano para onboarding y aprobacion de preregistros', true
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE LOWER(titulo) = LOWER('Talento Humano')
);

INSERT INTO documento_identidad (titulo, codigo, activo)
VALUES
  ('Cédula de Ciudadanía', 'CC', true),
  ('Cédula de Extranjería', 'CE', true),
  ('Pasaporte', 'PA', true),
  ('NIT', 'NIT', true)
ON CONFLICT (titulo) DO NOTHING;

CREATE TABLE IF NOT EXISTS preregistro_personas (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    id_solicitud_rrhh INT NOT NULL REFERENCES solicitudes_rrhh(id),

    nombre VARCHAR(100) NOT NULL,
    apellidos VARCHAR(100) NOT NULL,
    tipo_documento_id INT NOT NULL REFERENCES documento_identidad(id),
    numero_documento VARCHAR(50) NOT NULL,
    telefono VARCHAR(30),
    correo_personal VARCHAR(150) NOT NULL,
    pais_ubicacion VARCHAR(100),
    ciudad VARCHAR(100),

    cargo cargo_tipo,
    responsable_supervisor_id INT REFERENCES usuarios(id),
    fecha_fin DATE,
    moneda tipo_moneda,
    pais_pago VARCHAR(100),
    tarifa_hora NUMERIC(15,2),
    tarifa_mes NUMERIC(15,2),
    tarifa_medio_tiempo NUMERIC(15,2),
    tarifa_capacitacion NUMERIC(15,2),
    vpn_corona BOOLEAN DEFAULT FALSE,
    necesita_s_user BOOLEAN DEFAULT FALSE,
    grupo_usuario grupo_usuario_tipo,
    grupo_usuario_otro VARCHAR(150),
    grupo_distribucion grupo_distribucion_tipo,
    observaciones TEXT,

    direccion TEXT,
    tipo_persona tipo_persona,
    banco_id INT REFERENCES bancos(id),
    tipo_cuenta_id INT REFERENCES tipo_cuenta_bancaria(id),
    numero_cuenta VARCHAR(50),
    correo_silver VARCHAR(150) UNIQUE,

    estado VARCHAR(50) NOT NULL DEFAULT 'Pendiente Coordinador'
        CHECK (estado IN (
            'Pendiente Coordinador',
            'Pendiente Revision TH',
            'Pendiente Correo Silver',
            'Completado',
            'Anulado'
        )),

    creado_por INT NOT NULL REFERENCES usuarios(id),
    completado_coordinador_por INT REFERENCES usuarios(id),
    completado_th_por INT REFERENCES usuarios(id),
    aprobado_por INT REFERENCES usuarios(id),
    anulado_por INT REFERENCES usuarios(id),

    motivo_anulacion TEXT,
    id_usuario_creado INT REFERENCES usuarios(id),

    fecha_completado_coordinador TIMESTAMP,
    fecha_completado_th TIMESTAMP,
    fecha_aprobacion TIMESTAMP,
    fecha_anulacion TIMESTAMP,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    CHECK (
      (grupo_usuario = 'Otro' AND grupo_usuario_otro IS NOT NULL)
      OR (grupo_usuario IS NULL)
      OR (grupo_usuario <> 'Otro' AND grupo_usuario_otro IS NULL)
    )
);

ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS tipo_documento_id INT REFERENCES documento_identidad(id);
ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS cargo cargo_tipo;
ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS responsable_supervisor_id INT REFERENCES usuarios(id);
ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS moneda tipo_moneda;
ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS grupo_usuario grupo_usuario_tipo;
ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS grupo_usuario_otro VARCHAR(150);
ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS grupo_distribucion grupo_distribucion_tipo;
ALTER TABLE preregistro_personas
  ADD COLUMN IF NOT EXISTS tipo_cuenta_id INT REFERENCES tipo_cuenta_bancaria(id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'preregistro_personas'
      AND column_name = 'tipo_documento'
  ) THEN
    UPDATE preregistro_personas p
    SET tipo_documento_id = di.id
    FROM documento_identidad di
    WHERE p.tipo_documento_id IS NULL
      AND (
        (LOWER(COALESCE(p.tipo_documento, '')) LIKE '%ciudadania%' AND LOWER(di.titulo) = LOWER('Cédula de Ciudadanía')) OR
        (LOWER(COALESCE(p.tipo_documento, '')) LIKE '%extranjeria%' AND LOWER(di.titulo) = LOWER('Cédula de Extranjería')) OR
        (LOWER(COALESCE(p.tipo_documento, '')) LIKE '%pasaporte%' AND LOWER(di.titulo) = LOWER('Pasaporte')) OR
        (LOWER(COALESCE(p.tipo_documento, '')) = 'nit' AND LOWER(di.titulo) = LOWER('NIT'))
      );

    ALTER TABLE preregistro_personas
      ALTER COLUMN tipo_documento DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'preregistro_personas'
      AND column_name = 'tipo_cuenta'
  ) THEN
    UPDATE preregistro_personas p
    SET tipo_cuenta_id = tc.id
    FROM tipo_cuenta_bancaria tc
    WHERE p.tipo_cuenta_id IS NULL
      AND LOWER(tc.titulo) LIKE LOWER(COALESCE(p.tipo_cuenta, '') || '%');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_preregistro_solicitud
    ON preregistro_personas(id_solicitud_rrhh);

CREATE INDEX IF NOT EXISTS idx_preregistro_estado
    ON preregistro_personas(estado);

CREATE INDEX IF NOT EXISTS idx_preregistro_documento
    ON preregistro_personas(numero_documento);

CREATE INDEX IF NOT EXISTS idx_preregistro_correo_personal
    ON preregistro_personas(correo_personal);

CREATE INDEX IF NOT EXISTS idx_preregistro_correo_silver
    ON preregistro_personas(correo_silver)
    WHERE correo_silver IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_preregistro_usuario_creado
    ON preregistro_personas(id_usuario_creado)
    WHERE id_usuario_creado IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_preregistro_updated
    ON preregistro_personas(updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_preregistro_solicitud_activa
    ON preregistro_personas(id_solicitud_rrhh)
    WHERE estado <> 'Anulado';

COMMIT;
