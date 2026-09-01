BEGIN;

INSERT INTO roles (titulo, descripcion, activo)
VALUES ('Fábrica', 'Integrante interno cuya capacidad semanal es medida', TRUE)
ON CONFLICT (titulo) DO UPDATE
SET descripcion = EXCLUDED.descripcion,
    activo = TRUE,
    updated_at = CURRENT_TIMESTAMP;

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS rol_previo_fabrica_id INTEGER REFERENCES roles(id) ON DELETE SET NULL;

WITH rol_fabrica AS (
  SELECT id FROM roles WHERE titulo = 'Fábrica' LIMIT 1
)
UPDATE usuarios u
SET rol_previo_fabrica_id = u.rol_usuario_id,
    rol_usuario_id = rf.id,
    updated_at = CURRENT_TIMESTAMP
FROM personas p, rol_fabrica rf
WHERE u.persona_id = p.id
  AND p.pertenece_fabrica = TRUE
  AND COALESCE((
    SELECT LOWER(BTRIM(actual.titulo)) FROM roles actual
    WHERE actual.id = u.rol_usuario_id
  ), '') NOT IN (
    'administrador', 'coordinador', 'talento humano', 'fábrica', 'fabrica'
  );

ALTER TABLE categorias_esfuerzo_capacidad
  ADD COLUMN IF NOT EXISTS aplica_distribucion BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS aplica_actividad BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS usa_bolsa BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO categorias_esfuerzo_capacidad
  (codigo, nombre, porcentaje_predeterminado, orden, activo,
   aplica_distribucion, aplica_actividad, usa_bolsa)
VALUES
  ('DESARROLLO_PRUEBAS', 'Desarrollo y pruebas', 85, 10, TRUE, TRUE, FALSE, FALSE),
  ('AJUSTES_GARANTIA', 'Ajustes y garantía', 0, 40, TRUE, FALSE, TRUE, FALSE)
ON CONFLICT (codigo) DO UPDATE
SET nombre = EXCLUDED.nombre,
    porcentaje_predeterminado = EXCLUDED.porcentaje_predeterminado,
    orden = EXCLUDED.orden,
    activo = TRUE,
    aplica_distribucion = EXCLUDED.aplica_distribucion,
    aplica_actividad = EXCLUDED.aplica_actividad,
    usa_bolsa = EXCLUDED.usa_bolsa,
    updated_at = CURRENT_TIMESTAMP;

UPDATE categorias_esfuerzo_capacidad
SET porcentaje_predeterminado = 15,
    aplica_distribucion = TRUE,
    aplica_actividad = FALSE,
    usa_bolsa = FALSE,
    activo = TRUE,
    orden = 20,
    updated_at = CURRENT_TIMESTAMP
WHERE codigo = 'DOCUMENTACION';

UPDATE categorias_esfuerzo_capacidad
SET aplica_distribucion = FALSE,
    aplica_actividad = codigo IN ('SOPORTE', 'ESTIMACION', 'REUNIONES'),
    usa_bolsa = codigo = 'REUNIONES',
    activo = codigo IN ('SOPORTE', 'ESTIMACION', 'REUNIONES'),
    updated_at = CURRENT_TIMESTAMP
WHERE codigo IN ('DESARROLLO', 'PRUEBAS', 'SOPORTE', 'ESTIMACION', 'REUNIONES', 'AJUSTES', 'GARANTIA');

WITH existentes AS (
  SELECT d.requerimiento_id,
         SUM(d.porcentaje) FILTER (WHERE c.codigo IN ('DESARROLLO', 'PRUEBAS')) AS desarrollo_pruebas,
         SUM(d.porcentaje) FILTER (WHERE c.codigo = 'DOCUMENTACION') AS documentacion
  FROM requerimiento_distribucion_capacidad d
  JOIN categorias_esfuerzo_capacidad c ON c.id = d.categoria_id
  GROUP BY d.requerimiento_id
), normalizados AS (
  SELECT requerimiento_id,
         CASE
           WHEN COALESCE(desarrollo_pruebas, 0) + COALESCE(documentacion, 0) > 0
             THEN ROUND(COALESCE(desarrollo_pruebas, 0) * 100 /
                        (COALESCE(desarrollo_pruebas, 0) + COALESCE(documentacion, 0)), 2)
           ELSE 85
         END AS desarrollo_pruebas
  FROM existentes
)
INSERT INTO requerimiento_distribucion_capacidad (requerimiento_id, categoria_id, porcentaje)
SELECT n.requerimiento_id, c.id, n.desarrollo_pruebas
FROM normalizados n
JOIN categorias_esfuerzo_capacidad c ON c.codigo = 'DESARROLLO_PRUEBAS'
WHERE NOT EXISTS (
  SELECT 1
  FROM requerimiento_distribucion_capacidad actual
  WHERE actual.requerimiento_id = n.requerimiento_id
    AND actual.categoria_id = c.id
)
ON CONFLICT (requerimiento_id, categoria_id) DO UPDATE
SET porcentaje = EXCLUDED.porcentaje,
    updated_at = CURRENT_TIMESTAMP;

WITH desarrollo AS (
  SELECT d.requerimiento_id, d.porcentaje
  FROM requerimiento_distribucion_capacidad d
  JOIN categorias_esfuerzo_capacidad c ON c.id = d.categoria_id
  WHERE c.codigo = 'DESARROLLO_PRUEBAS'
)
INSERT INTO requerimiento_distribucion_capacidad (requerimiento_id, categoria_id, porcentaje)
SELECT d.requerimiento_id, c.id, 100 - d.porcentaje
FROM desarrollo d
JOIN categorias_esfuerzo_capacidad c ON c.codigo = 'DOCUMENTACION'
ON CONFLICT (requerimiento_id, categoria_id) DO UPDATE
SET porcentaje = EXCLUDED.porcentaje,
    updated_at = CURRENT_TIMESTAMP;

WITH distribucion_v2 AS (
  SELECT d.requerimiento_id,
         MAX(d.porcentaje) FILTER (WHERE c.codigo = 'DESARROLLO_PRUEBAS') AS desarrollo_pruebas,
         MAX(d.porcentaje) FILTER (WHERE c.codigo = 'DOCUMENTACION') AS documentacion
  FROM requerimiento_distribucion_capacidad d
  JOIN categorias_esfuerzo_capacidad c ON c.id = d.categoria_id
  WHERE c.codigo IN ('DESARROLLO_PRUEBAS', 'DOCUMENTACION')
  GROUP BY d.requerimiento_id
)
UPDATE requerimientos_capacidad_historial h
SET porcentajes_snapshot = jsonb_build_object(
      'DESARROLLO_PRUEBAS', COALESCE(v.desarrollo_pruebas, 85),
      'DOCUMENTACION', COALESCE(v.documentacion, 15)
    )
FROM distribucion_v2 v
WHERE h.requerimiento_id = v.requerimiento_id
  AND h.valido_hasta IS NULL;

UPDATE estados_requerimiento_capacidad
SET consume_capacidad = codigo IN ('EN_DESARROLLO', 'EN_PRUEBAS'),
    categoria_codigo = CASE
      WHEN codigo IN ('EN_DESARROLLO', 'EN_PRUEBAS') THEN 'DESARROLLO_PRUEBAS'
      ELSE NULL
    END,
    clasificacion = CASE
      WHEN codigo IN ('EN_DESARROLLO', 'EN_PRUEBAS') THEN 'activo'
      ELSE clasificacion
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE codigo IN ('EN_ESTIMACION', 'EN_DESARROLLO', 'EN_PRUEBAS', 'EN_AJUSTES', 'GARANTIA');

-- Las semanas anteriores conservan el modelo que estaba vigente cuando se
-- tomó la foto; las versiones abiertas empiezan a usar el modelo nuevo.
UPDATE requerimientos_capacidad_historial h
SET datos_snapshot = h.datos_snapshot || jsonb_build_object(
      'consume_capacidad', CASE
        WHEN h.valido_hasta IS NULL THEN e.consume_capacidad
        ELSE e.codigo IN ('EN_ESTIMACION', 'EN_DESARROLLO', 'EN_AJUSTES', 'GARANTIA')
      END,
      'categoria_capacidad', CASE
        WHEN h.valido_hasta IS NULL THEN e.categoria_codigo
        WHEN e.codigo = 'EN_ESTIMACION' THEN 'ESTIMACION'
        WHEN e.codigo = 'EN_DESARROLLO' THEN 'DESARROLLO'
        WHEN e.codigo = 'EN_AJUSTES' THEN 'AJUSTES'
        WHEN e.codigo = 'GARANTIA' THEN 'GARANTIA'
        ELSE NULL
      END
    )
FROM estados_requerimiento_capacidad e
WHERE e.id = h.estado_id;

CREATE TABLE IF NOT EXISTS bolsas_reuniones_capacidad
(
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE RESTRICT,
  coordinador_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  semana_inicio DATE NOT NULL,
  semana_fin DATE NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'ABIERTA'
    CHECK (estado IN ('ABIERTA', 'CERRADA')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_bolsa_reuniones_persona_semana UNIQUE (persona_id, semana_inicio),
  CONSTRAINT ck_bolsa_reuniones_semana CHECK (semana_fin = semana_inicio + 4)
);

CREATE INDEX IF NOT EXISTS idx_bolsas_reuniones_semana
  ON bolsas_reuniones_capacidad(semana_inicio, persona_id);

CREATE TABLE IF NOT EXISTS actividades_capacidad
(
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  titulo VARCHAR(500) NOT NULL,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  categoria_codigo VARCHAR(40) NOT NULL REFERENCES categorias_esfuerzo_capacidad(codigo),
  fecha DATE NOT NULL,
  horas NUMERIC(8,2) NOT NULL CHECK (horas > 0 AND horas <= 168),
  origen VARCHAR(20) NOT NULL CHECK (origen IN ('AUTORREGISTRO', 'COORDINADOR', 'MIGRACION')),
  estado VARCHAR(20) NOT NULL DEFAULT 'ACTIVA' CHECK (estado IN ('ACTIVA', 'CANCELADA')),
  creado_por INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  cancelado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  cancelado_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_actividades_capacidad_fecha
  ON actividades_capacidad(fecha, categoria_codigo);

CREATE TABLE IF NOT EXISTS actividad_capacidad_responsables
(
  id BIGSERIAL PRIMARY KEY,
  actividad_id BIGINT NOT NULL REFERENCES actividades_capacidad(id) ON DELETE RESTRICT,
  persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE RESTRICT,
  bolsa_id BIGINT REFERENCES bolsas_reuniones_capacidad(id) ON DELETE RESTRICT,
  horas NUMERIC(8,2) NOT NULL CHECK (horas > 0 AND horas <= 168),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_actividad_capacidad_responsable UNIQUE (actividad_id, persona_id)
);

CREATE INDEX IF NOT EXISTS idx_actividad_responsables_persona
  ON actividad_capacidad_responsables(persona_id, actividad_id);

CREATE TABLE IF NOT EXISTS bolsa_reuniones_movimientos
(
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  bolsa_id BIGINT NOT NULL REFERENCES bolsas_reuniones_capacidad(id) ON DELETE RESTRICT,
  actividad_responsable_id BIGINT REFERENCES actividad_capacidad_responsables(id) ON DELETE RESTRICT,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('ASIGNACION', 'AJUSTE', 'CONSUMO', 'REVERSO')),
  horas_delta NUMERIC(8,2) NOT NULL CHECK (horas_delta <> 0),
  motivo VARCHAR(500),
  registrado_por INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_movimiento_consumo_responsable
  ON bolsa_reuniones_movimientos(actividad_responsable_id, tipo)
  WHERE actividad_responsable_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bolsa_movimientos_bolsa_fecha
  ON bolsa_reuniones_movimientos(bolsa_id, created_at);

-- El calendario deja de ser fuente de capacidad. Esta migración es posterior
-- a la que creó la tabla, por lo que también limpia instalaciones existentes.
DROP TABLE IF EXISTS actividades_calendario_capacidad;

COMMIT;
