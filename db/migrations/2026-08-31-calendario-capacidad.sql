BEGIN;

CREATE TABLE IF NOT EXISTS actividades_calendario_capacidad (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  coordinador_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  graph_event_id VARCHAR(512) NOT NULL,
  graph_ical_uid VARCHAR(512),
  categoria_codigo VARCHAR(40) NOT NULL DEFAULT 'REUNIONES'
    REFERENCES categorias_esfuerzo_capacidad(codigo),
  titulo TEXT NOT NULL,
  organizador_nombre VARCHAR(255),
  organizador_correo VARCHAR(255) NOT NULL,
  inicio TIMESTAMPTZ NOT NULL,
  fin TIMESTAMPTZ NOT NULL,
  horas NUMERIC(10,2) NOT NULL CHECK (horas > 0),
  estado_respuesta VARCHAR(30),
  mostrar_como VARCHAR(30),
  sensibilidad VARCHAR(30),
  tipo_evento VARCHAR(30),
  series_master_id VARCHAR(512),
  web_url TEXT,
  source_changed_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  sincronizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_actividad_calendario_persona_evento UNIQUE (persona_id, graph_event_id),
  CONSTRAINT ck_actividad_calendario_fechas CHECK (fin > inicio),
  CONSTRAINT ck_actividad_calendario_categoria CHECK (categoria_codigo = 'REUNIONES')
);

CREATE INDEX IF NOT EXISTS idx_actividad_calendario_persona_fechas
  ON actividades_calendario_capacidad(persona_id, inicio, fin);
CREATE INDEX IF NOT EXISTS idx_actividad_calendario_coordinador
  ON actividades_calendario_capacidad(coordinador_id);
CREATE INDEX IF NOT EXISTS idx_actividad_calendario_activa
  ON actividades_calendario_capacidad(persona_id, activo)
  WHERE activo = TRUE;

COMMENT ON TABLE actividades_calendario_capacidad IS
  'Reuniones de Microsoft 365 creadas por coordinadores y sincronizadas para la capacidad semanal de Fabrica.';
COMMENT ON COLUMN actividades_calendario_capacidad.graph_event_id IS
  'Identificador inmutable solicitado a Microsoft Graph para actualizar el evento sin duplicarlo.';
COMMENT ON COLUMN actividades_calendario_capacidad.categoria_codigo IS
  'Los eventos de calendario se clasifican automaticamente como REUNIONES.';

COMMIT;
