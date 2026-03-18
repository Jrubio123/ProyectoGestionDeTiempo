CREATE TABLE IF NOT EXISTS anexo_tecnico_items (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    solicitud_contratacion_id INT REFERENCES solicitudes_contratacion(id) ON DELETE SET NULL,
    preregistro_id INT REFERENCES preregistro_personas(id) ON DELETE SET NULL,

    nombre_persona VARCHAR(200) NOT NULL,
    numero_documento VARCHAR(50),
    correo_personal VARCHAR(255),

    tipo_asignacion VARCHAR(20) NOT NULL
        CHECK (tipo_asignacion IN ('full_time', 'medio_tiempo', 'horas', 'capacitacion', 'proyecto')),
    cliente_id INT REFERENCES clientes(id) ON DELETE SET NULL,
    cliente_nombre VARCHAR(200),

    moneda VARCHAR(10) CHECK (moneda IN ('COP', 'USD', 'EUR')),
    valor_tarifa NUMERIC(15,2) NOT NULL CHECK (valor_tarifa >= 0),
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE NOT NULL,
    fecha_fin_calculada BOOLEAN NOT NULL DEFAULT false,

    origen VARCHAR(20) NOT NULL DEFAULT 'manual'
        CHECK (origen IN ('manual', 'automatico')),
    estado VARCHAR(20) NOT NULL DEFAULT 'activo'
        CHECK (estado IN ('activo', 'finalizado', 'cancelado')),
    creado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    CHECK (solicitud_contratacion_id IS NOT NULL OR preregistro_id IS NOT NULL),
    CHECK (
      (tipo_asignacion IN ('full_time', 'medio_tiempo', 'proyecto') AND cliente_id IS NOT NULL)
      OR (tipo_asignacion IN ('horas', 'capacitacion') AND cliente_id IS NULL)
    ),
    CHECK (
      (tipo_asignacion IN ('full_time', 'medio_tiempo', 'proyecto') AND fecha_fin >= fecha_inicio)
      OR (
        tipo_asignacion IN ('horas', 'capacitacion')
        AND EXTRACT(YEAR FROM fecha_fin) = EXTRACT(YEAR FROM fecha_inicio)
        AND EXTRACT(MONTH FROM fecha_fin) = 12
        AND EXTRACT(DAY FROM fecha_fin) = 31
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_doc ON anexo_tecnico_items(numero_documento);
CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_correo ON anexo_tecnico_items(correo_personal);
CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_estado ON anexo_tecnico_items(estado);
CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_solicitud ON anexo_tecnico_items(solicitud_contratacion_id) WHERE solicitud_contratacion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_preregistro ON anexo_tecnico_items(preregistro_id) WHERE preregistro_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_anexo_tecnico_items_fecha ON anexo_tecnico_items(fecha_inicio, fecha_fin);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    DROP TRIGGER IF EXISTS update_anexo_tecnico_items_updated_at ON anexo_tecnico_items;
    CREATE TRIGGER update_anexo_tecnico_items_updated_at
    BEFORE UPDATE ON anexo_tecnico_items
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

COMMENT ON TABLE anexo_tecnico_items IS 'Historial acumulado de filas del Anexo Tecnico por persona';
COMMENT ON COLUMN anexo_tecnico_items.tipo_asignacion IS 'full_time, medio_tiempo, horas, capacitacion o proyecto';
COMMENT ON COLUMN anexo_tecnico_items.fecha_fin_calculada IS 'true cuando la fecha_fin se calculó automáticamente (31 de diciembre)';
