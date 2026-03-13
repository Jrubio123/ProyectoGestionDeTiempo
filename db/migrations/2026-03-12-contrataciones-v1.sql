ALTER TABLE clientes
ADD COLUMN IF NOT EXISTS requiere_confirmacion_cliente BOOLEAN DEFAULT false;

UPDATE clientes
SET requiere_confirmacion_cliente = true
WHERE LOWER(COALESCE(titulo, '')) LIKE '%holcim%';

CREATE TABLE IF NOT EXISTS solicitudes_contratacion (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    tipo_solicitud VARCHAR(20) NOT NULL
        CHECK (tipo_solicitud IN ('Nuevo', 'Extension', 'Retiro')),
    estado VARCHAR(50) NOT NULL DEFAULT 'Pendiente'
        CHECK (estado IN ('Pendiente', 'En Proceso', 'Pendiente Confirmación Cliente', 'Pendiente Revision TH', 'Completado', 'Cancelado')),

    coordinador_solicitante_id INT NOT NULL REFERENCES usuarios(id),
    persona_usuario_id INT REFERENCES usuarios(id),
    supervisor_id INT REFERENCES usuarios(id),
    cliente_id INT REFERENCES clientes(id),
    tipo_documento_id INT REFERENCES documento_identidad(id),

    nombre VARCHAR(150) NOT NULL,
    apellidos VARCHAR(150) NOT NULL,
    numero_documento VARCHAR(50),
    perfil VARCHAR(120),

    correo_personal VARCHAR(255),
    correo_empresarial VARCHAR(255),
    telefono VARCHAR(50),
    ubicacion VARCHAR(120),

    grupo_app_tiempos VARCHAR(150),
    grupo_distribucion VARCHAR(150),

    moneda VARCHAR(10)
        CHECK (moneda IN ('COP', 'USD')),
    tarifa_hora NUMERIC(15,2),
    tarifa_mes NUMERIC(15,2),
    tarifa_medio_tiempo NUMERIC(15,2),
    tarifa_capacitacion NUMERIC(15,2),

    modalidad_contrato VARCHAR(50)
        CHECK (modalidad_contrato IN ('Full time', 'Medio tiempo', 'Por horas')),

    fecha_inicio DATE,
    fecha_fin DATE,
    fecha_extension_desde DATE,
    fecha_extension_hasta DATE,
    fecha_retiro DATE,

    necesidad_ti TEXT,
    observaciones TEXT,
    datos_extra JSONB DEFAULT '{}'::jsonb,

    requiere_confirmacion_cliente BOOLEAN DEFAULT false,
    correo_enviado_mesa BOOLEAN DEFAULT false,
    correo_enviado_th BOOLEAN DEFAULT false,
    correo_confirmacion_coordinador BOOLEAN DEFAULT false,
    revisado_th_por INT REFERENCES usuarios(id),
    fecha_revision_th TIMESTAMP,
    observaciones_th TEXT,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contrataciones_tipo ON solicitudes_contratacion(tipo_solicitud);
CREATE INDEX IF NOT EXISTS idx_contrataciones_estado ON solicitudes_contratacion(estado);
CREATE INDEX IF NOT EXISTS idx_contrataciones_coordinador ON solicitudes_contratacion(coordinador_solicitante_id);
CREATE INDEX IF NOT EXISTS idx_contrataciones_cliente ON solicitudes_contratacion(cliente_id);
CREATE INDEX IF NOT EXISTS idx_contrataciones_documento ON solicitudes_contratacion(numero_documento);
CREATE INDEX IF NOT EXISTS idx_contrataciones_created ON solicitudes_contratacion(created_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'update_updated_at_column'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS update_solicitudes_contratacion_updated_at ON solicitudes_contratacion';
    EXECUTE 'CREATE TRIGGER update_solicitudes_contratacion_updated_at
             BEFORE UPDATE ON solicitudes_contratacion
             FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()';
  END IF;
END$$;
