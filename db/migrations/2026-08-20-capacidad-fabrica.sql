BEGIN;

ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS pertenece_fabrica BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS azure_oid VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_azure_oid
  ON personas(azure_oid)
  WHERE NULLIF(BTRIM(azure_oid), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_personas_pertenece_fabrica
  ON personas(pertenece_fabrica)
  WHERE pertenece_fabrica = TRUE;

CREATE TABLE IF NOT EXISTS categorias_esfuerzo_capacidad (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  codigo VARCHAR(40) NOT NULL UNIQUE,
  nombre VARCHAR(100) NOT NULL UNIQUE,
  porcentaje_predeterminado NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (porcentaje_predeterminado >= 0 AND porcentaje_predeterminado <= 100),
  orden SMALLINT NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO categorias_esfuerzo_capacidad
  (codigo, nombre, porcentaje_predeterminado, orden)
VALUES
  ('DESARROLLO', 'Desarrollo', 55, 10),
  ('PRUEBAS', 'Pruebas', 10, 20),
  ('DOCUMENTACION', 'Documentación', 10, 30),
  ('SOPORTE', 'Soporte', 5, 40),
  ('ESTIMACION', 'Estimación', 5, 50),
  ('REUNIONES', 'Reuniones', 5, 60),
  ('AJUSTES', 'Ajustes', 5, 70),
  ('GARANTIA', 'Garantía', 5, 80)
ON CONFLICT (codigo) DO UPDATE SET
  nombre = EXCLUDED.nombre,
  orden = EXCLUDED.orden,
  updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS estados_requerimiento_capacidad (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  codigo VARCHAR(50) NOT NULL UNIQUE,
  nombre VARCHAR(120) NOT NULL UNIQUE,
  consume_capacidad BOOLEAN NOT NULL DEFAULT FALSE,
  categoria_codigo VARCHAR(40) REFERENCES categorias_esfuerzo_capacidad(codigo),
  clasificacion VARCHAR(30) NOT NULL
    CHECK (clasificacion IN ('espera', 'activo', 'pausado', 'completado', 'eliminado')),
  es_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  permite_reactivacion BOOLEAN NOT NULL DEFAULT TRUE,
  orden SMALLINT NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (consume_capacidad = TRUE AND categoria_codigo IS NOT NULL)
    OR consume_capacidad = FALSE
  )
);

INSERT INTO estados_requerimiento_capacidad
  (codigo, nombre, consume_capacidad, categoria_codigo, clasificacion, es_terminal, permite_reactivacion, orden)
VALUES
  ('PLANIFICADO', 'Planificada', FALSE, NULL, 'activo', FALSE, TRUE, 5),
  ('EN_ESTIMACION', 'En estimación', TRUE, 'ESTIMACION', 'activo', FALSE, TRUE, 10),
  ('EN_APROBACION', 'En aprobación', FALSE, NULL, 'espera', FALSE, TRUE, 20),
  ('APROBADO', 'Aprobado', FALSE, NULL, 'espera', FALSE, TRUE, 30),
  ('EN_DESARROLLO', 'En desarrollo', TRUE, 'DESARROLLO', 'activo', FALSE, TRUE, 40),
  ('EN_PRUEBAS', 'En pruebas', FALSE, NULL, 'espera', FALSE, TRUE, 50),
  ('EN_AJUSTES', 'En ajustes', TRUE, 'AJUSTES', 'activo', FALSE, TRUE, 60),
  ('PRUEBAS_EXITOSAS', 'Pruebas exitosas', FALSE, NULL, 'espera', FALSE, TRUE, 70),
  ('CERRADO', 'Cerrado', FALSE, NULL, 'completado', TRUE, FALSE, 80),
  ('GARANTIA', 'Garantía', TRUE, 'GARANTIA', 'activo', FALSE, TRUE, 90),
  ('EN_ESPERA_CLIENTE', 'En espera cliente', FALSE, NULL, 'espera', FALSE, TRUE, 100),
  ('PENDIENTE_PASO_PRD', 'Pendiente paso a PRD', FALSE, NULL, 'espera', FALSE, TRUE, 110),
  ('REMOVED', 'Removed', FALSE, NULL, 'eliminado', TRUE, FALSE, 120),
  ('CANCELADO', 'Cancelado', FALSE, NULL, 'pausado', FALSE, TRUE, 130)
ON CONFLICT (codigo) DO UPDATE SET
  nombre = EXCLUDED.nombre,
  consume_capacidad = EXCLUDED.consume_capacidad,
  categoria_codigo = EXCLUDED.categoria_codigo,
  clasificacion = EXCLUDED.clasificacion,
  es_terminal = EXCLUDED.es_terminal,
  permite_reactivacion = EXCLUDED.permite_reactivacion,
  orden = EXCLUDED.orden,
  updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS configuracion_capacidad_fabrica (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  horas_semanales NUMERIC(6,2) NOT NULL DEFAULT 42
    CHECK (horas_semanales > 0 AND horas_semanales <= 168),
  updated_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO configuracion_capacidad_fabrica (id, horas_semanales)
VALUES (1, 42)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS personas_fabrica_historial (
  id BIGSERIAL PRIMARY KEY,
  persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  pertenece_fabrica BOOLEAN NOT NULL,
  valido_desde TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valido_hasta TIMESTAMPTZ,
  registrado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  registrado_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_fabrica_version_abierta
  ON personas_fabrica_historial(persona_id)
  WHERE valido_hasta IS NULL;
CREATE INDEX IF NOT EXISTS idx_personas_fabrica_corte
  ON personas_fabrica_historial(persona_id, valido_desde, valido_hasta);

INSERT INTO personas_fabrica_historial (persona_id, pertenece_fabrica, valido_desde)
SELECT p.id, p.pertenece_fabrica, CURRENT_TIMESTAMP
FROM personas p
WHERE p.pertenece_fabrica = TRUE
  AND NOT EXISTS (
    SELECT 1
    FROM personas_fabrica_historial h
    WHERE h.persona_id = p.id AND h.valido_hasta IS NULL
  );

CREATE TABLE IF NOT EXISTS requerimientos_capacidad (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  origen VARCHAR(20) NOT NULL CHECK (origen IN ('AZURE_DEVOPS', 'MANUAL')),
  external_id BIGINT,
  organizacion_azure VARCHAR(255),
  azure_project_id VARCHAR(100),
  azure_project_name VARCHAR(255),
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE RESTRICT,
  cliente_nombre_origen VARCHAR(255),
  tipo_registro VARCHAR(20) NOT NULL DEFAULT 'REQUERIMIENTO'
    CHECK (tipo_registro IN ('REQUERIMIENTO', 'ACTIVIDAD')),
  categoria_actividad_codigo VARCHAR(40)
    REFERENCES categorias_esfuerzo_capacidad(codigo),
  tipo VARCHAR(120) NOT NULL,
  titulo TEXT NOT NULL,
  estado_id INTEGER NOT NULL REFERENCES estados_requerimiento_capacidad(id),
  estado_origen VARCHAR(120),
  effort_total NUMERIC(10,2) CHECK (effort_total IS NULL OR effort_total >= 0),
  prioridad SMALLINT CHECK (prioridad IS NULL OR prioridad > 0),
  persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  responsable_azure_id VARCHAR(128),
  responsable_correo VARCHAR(255),
  responsable_nombre VARCHAR(255),
  fecha_inicio DATE,
  fecha_fin DATE,
  azure_url TEXT,
  source_created_at TIMESTAMPTZ,
  source_changed_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  modified_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_requerimiento_capacidad_origen_externo
    UNIQUE (origen, organizacion_azure, external_id),
  CONSTRAINT ck_requerimiento_manual_effort
    CHECK (origen <> 'MANUAL' OR effort_total IS NOT NULL),
  CONSTRAINT ck_requerimiento_capacidad_origen CHECK (
    (origen = 'AZURE_DEVOPS' AND external_id IS NOT NULL
      AND organizacion_azure IS NOT NULL AND tipo_registro = 'REQUERIMIENTO')
    OR (origen = 'MANUAL' AND (tipo_registro = 'ACTIVIDAD' OR cliente_id IS NOT NULL))
  ),
  CONSTRAINT ck_requerimiento_actividad CHECK (
    (tipo_registro = 'REQUERIMIENTO' AND categoria_actividad_codigo IS NULL)
    OR (tipo_registro = 'ACTIVIDAD' AND origen = 'MANUAL'
      AND categoria_actividad_codigo IS NOT NULL AND effort_total > 0
      AND fecha_inicio IS NOT NULL AND fecha_fin = fecha_inicio)
  )
);

CREATE INDEX IF NOT EXISTS idx_requerimientos_capacidad_persona
  ON requerimientos_capacidad(persona_id);
CREATE INDEX IF NOT EXISTS idx_requerimientos_capacidad_estado
  ON requerimientos_capacidad(estado_id);
CREATE INDEX IF NOT EXISTS idx_requerimientos_capacidad_origen
  ON requerimientos_capacidad(origen);
CREATE INDEX IF NOT EXISTS idx_requerimientos_capacidad_fecha_fin
  ON requerimientos_capacidad(fecha_fin);
CREATE INDEX IF NOT EXISTS idx_requerimientos_capacidad_tipo_registro
  ON requerimientos_capacidad(tipo_registro);
CREATE INDEX IF NOT EXISTS idx_requerimientos_capacidad_actividad_fecha
  ON requerimientos_capacidad(fecha_inicio)
  WHERE tipo_registro = 'ACTIVIDAD';

CREATE TABLE IF NOT EXISTS requerimiento_distribucion_capacidad (
  id BIGSERIAL PRIMARY KEY,
  requerimiento_id BIGINT NOT NULL REFERENCES requerimientos_capacidad(id) ON DELETE CASCADE,
  categoria_id INTEGER NOT NULL REFERENCES categorias_esfuerzo_capacidad(id) ON DELETE RESTRICT,
  porcentaje NUMERIC(5,2) NOT NULL CHECK (porcentaje >= 0 AND porcentaje <= 100),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (requerimiento_id, categoria_id)
);

CREATE INDEX IF NOT EXISTS idx_requerimiento_distribucion_requerimiento
  ON requerimiento_distribucion_capacidad(requerimiento_id);

CREATE TABLE IF NOT EXISTS requerimientos_capacidad_historial (
  id BIGSERIAL PRIMARY KEY,
  requerimiento_id BIGINT NOT NULL REFERENCES requerimientos_capacidad(id) ON DELETE CASCADE,
  evento VARCHAR(30) NOT NULL
    CHECK (evento IN ('CREADO', 'SINCRONIZADO', 'ESTADO', 'PLANIFICACION', 'ASIGNACION', 'ARCHIVADO')),
  estado_id INTEGER NOT NULL REFERENCES estados_requerimiento_capacidad(id),
  persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  effort_total NUMERIC(10,2),
  prioridad SMALLINT,
  fecha_inicio DATE,
  fecha_fin DATE,
  porcentajes_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  datos_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  valido_desde TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valido_hasta TIMESTAMPTZ,
  source_changed_at TIMESTAMPTZ,
  registrado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  registrado_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_requerimiento_historial_version_abierta
  ON requerimientos_capacidad_historial(requerimiento_id)
  WHERE valido_hasta IS NULL;
CREATE INDEX IF NOT EXISTS idx_requerimiento_historial_corte
  ON requerimientos_capacidad_historial(requerimiento_id, valido_desde, valido_hasta);
CREATE INDEX IF NOT EXISTS idx_requerimiento_historial_persona
  ON requerimientos_capacidad_historial(persona_id, valido_desde);

ALTER TABLE requerimientos_capacidad
  ALTER COLUMN effort_total DROP NOT NULL;
ALTER TABLE requerimientos_capacidad_historial
  ALTER COLUMN effort_total DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_requerimiento_manual_effort'
      AND conrelid = 'requerimientos_capacidad'::regclass
  ) THEN
    ALTER TABLE requerimientos_capacidad
      ADD CONSTRAINT ck_requerimiento_manual_effort
      CHECK (origen <> 'MANUAL' OR effort_total IS NOT NULL);
  END IF;
END
$$;

COMMENT ON COLUMN personas.pertenece_fabrica IS
  'Indica si la persona participa en el cálculo de capacidad del equipo interno de Fábrica.';
COMMENT ON COLUMN personas.azure_oid IS
  'Identificador estable de la persona en Microsoft Entra ID, incluso si todavía no tiene usuario del aplicativo.';
COMMENT ON TABLE requerimientos_capacidad IS
  'Versión vigente de requerimientos Azure DevOps y manuales usados para capacidad de Fábrica.';
COMMENT ON TABLE requerimientos_capacidad_historial IS
  'Versiones históricas para reconstruir la carga al corte de una semana.';

COMMIT;
