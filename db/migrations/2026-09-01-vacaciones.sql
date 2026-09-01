BEGIN;

CREATE TABLE IF NOT EXISTS vacaciones_solicitudes (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  solicitante_usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  solicitante_persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  solicitante_nombre VARCHAR(255) NOT NULL,
  solicitante_correo VARCHAR(320) NOT NULL,
  jefe_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  jefe_persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  jefe_azure_oid VARCHAR(64),
  jefe_nombre VARCHAR(255) NOT NULL,
  jefe_correo VARCHAR(320) NOT NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NOT NULL,
  dias_habiles SMALLINT NOT NULL CHECK (dias_habiles > 0),
  fecha_regreso DATE NOT NULL,
  observaciones TEXT,
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'cancelada')),
  comentario_decision TEXT,
  decidido_at TIMESTAMPTZ,
  decidido_por_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  decidido_por_correo VARCHAR(320),
  created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (fecha_fin >= fecha_inicio),
  CHECK (fecha_regreso > fecha_fin)
);

CREATE INDEX IF NOT EXISTS idx_vacaciones_solicitante
  ON vacaciones_solicitudes(solicitante_usuario_id, fecha_inicio DESC);
CREATE INDEX IF NOT EXISTS idx_vacaciones_jefe
  ON vacaciones_solicitudes(jefe_usuario_id, estado, fecha_inicio);
CREATE INDEX IF NOT EXISTS idx_vacaciones_jefe_correo
  ON vacaciones_solicitudes(LOWER(jefe_correo), estado);
CREATE INDEX IF NOT EXISTS idx_vacaciones_vigencia
  ON vacaciones_solicitudes(estado, fecha_inicio, fecha_fin);

CREATE TABLE IF NOT EXISTS vacaciones_aprobacion_tokens (
  id BIGSERIAL PRIMARY KEY,
  solicitud_id BIGINT NOT NULL REFERENCES vacaciones_solicitudes(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expira_at TIMESTAMPTZ NOT NULL,
  usado_at TIMESTAMPTZ,
  accion_usada VARCHAR(20) CHECK (accion_usada IS NULL OR accion_usada IN ('aprobar', 'rechazar')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vacaciones_token_pendiente
  ON vacaciones_aprobacion_tokens(solicitud_id)
  WHERE usado_at IS NULL;

CREATE TABLE IF NOT EXISTS vacaciones_destinatarios (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  origen VARCHAR(30) NOT NULL CHECK (origen IN ('personas', 'microsoft365', 'configuracion')),
  persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  azure_oid VARCHAR(64),
  nombre VARCHAR(255) NOT NULL,
  correo VARCHAR(320) NOT NULL,
  cargo VARCHAR(255),
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vacaciones_destinatario_correo
  ON vacaciones_destinatarios(LOWER(correo));

CREATE TABLE IF NOT EXISTS vacaciones_auditoria (
  id BIGSERIAL PRIMARY KEY,
  solicitud_id BIGINT NOT NULL REFERENCES vacaciones_solicitudes(id) ON DELETE CASCADE,
  evento VARCHAR(40) NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  actor_correo VARCHAR(320),
  datos JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vacaciones_auditoria_solicitud
  ON vacaciones_auditoria(solicitud_id, created_at);

CREATE TABLE IF NOT EXISTS vacaciones_notificaciones (
  id BIGSERIAL PRIMARY KEY,
  solicitud_id BIGINT NOT NULL REFERENCES vacaciones_solicitudes(id) ON DELETE CASCADE,
  tipo VARCHAR(40) NOT NULL,
  destinatarios TEXT[] NOT NULL,
  estado VARCHAR(20) NOT NULL CHECK (estado IN ('enviado', 'error')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vacaciones_notificaciones_solicitud
  ON vacaciones_notificaciones(solicitud_id, created_at);

COMMIT;

