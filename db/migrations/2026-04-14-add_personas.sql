-- ============================================================================
-- Migración 001: Tabla personas
-- Fecha: 2026-04-14
-- Descripción:
--   - Crea los ENUMs tipo_sexo y tipo_contrato
--   - Crea la tabla personas (fuente de verdad de datos personales)
--   - Agrega persona_id a usuarios
--   - Migra datos existentes de usuarios → personas
--   - Crea la vista v_usuarios_completo
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. NUEVOS TIPOS ENUM
-- ============================================================================

CREATE TYPE tipo_sexo AS ENUM (
    'Hombre',
    'Mujer',
    'Otro'
);

CREATE TYPE tipo_contrato AS ENUM (
    'Full time',
    'Indefinido',
    'Por horas',
    'Aprendizaje'
);

-- ============================================================================
-- 2. TABLA PERSONAS
-- ============================================================================

CREATE TABLE personas (
    id         SERIAL PRIMARY KEY,
    public_id  UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    -- Identificación
    numero_documento  VARCHAR(50) UNIQUE,
    tipo_documento_id INTEGER REFERENCES documento_identidad(id),
    estado            VARCHAR(20) NOT NULL DEFAULT 'activo'
                        CHECK (estado IN ('activo', 'inactivo')),

    -- Datos personales
    nombre             VARCHAR(200),
    apellidos          VARCHAR(200),
    fecha_nacimiento   DATE,
    sexo               tipo_sexo,

    -- Contacto principal
    numero_contacto      VARCHAR(50),
    correo_electronico   VARCHAR(255),
    direccion_residencia TEXT,
    ciudad_residencia    VARCHAR(100),
    departamento_pais    VARCHAR(100),

    -- Profesional
    titulo_profesional TEXT,
    tipo_persona       tipo_persona,
    factura_en_colombia BOOLEAN,

    -- Contacto de emergencia
    nombre_contacto_emergencia   VARCHAR(200),
    telefono_contacto_emergencia VARCHAR(50),
    parentesco                   VARCHAR(100),

    -- Datos bancarios
    banco_id       INTEGER REFERENCES bancos(id),
    tipo_cuenta_id INTEGER REFERENCES tipo_cuenta_bancaria(id),
    numero_cuenta  VARCHAR(50),

    -- Composición familiar
    composicion_familiar VARCHAR(100),
    hijos                INTEGER DEFAULT 0,
    personas_a_cargo     INTEGER DEFAULT 0,

    -- Seguridad social
    eps  VARCHAR(100),
    afp  VARCHAR(100),
    arl  VARCHAR(100),

    -- Contrato (snapshot del estado actual)
    tipo_contrato tipo_contrato,
    modalidad     VARCHAR(50),

    -- Módulo asignado (catálogo o libre)
    modulo_id   INTEGER REFERENCES modulo(id),
    modulo_otro VARCHAR(150),

    -- Cliente asignado (catálogo o libre)
    cliente_id   INTEGER REFERENCES clientes(id),
    cliente_otro VARCHAR(200),

    -- Vínculo con preregistro de origen
    preregistro_id INTEGER REFERENCES preregistro_personas(id) ON DELETE SET NULL,

    -- Auditoría
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
);

CREATE INDEX idx_personas_documento  ON personas(numero_documento);
CREATE INDEX idx_personas_correo     ON personas(correo_electronico);
CREATE INDEX idx_personas_estado     ON personas(estado);
CREATE INDEX idx_personas_cliente    ON personas(cliente_id);
CREATE INDEX idx_personas_modulo     ON personas(modulo_id);
CREATE INDEX idx_personas_preregistro ON personas(preregistro_id);
CREATE INDEX idx_personas_nombre_trgm ON personas USING gin(nombre gin_trgm_ops);

COMMENT ON TABLE personas IS 'Datos permanentes de personas (físicas o jurídicas) vinculadas al sistema';

-- ============================================================================
-- 3. VINCULAR USUARIOS CON PERSONAS
-- ============================================================================

ALTER TABLE usuarios ADD COLUMN persona_id INTEGER REFERENCES personas(id);
CREATE UNIQUE INDEX idx_usuarios_persona ON usuarios(persona_id) WHERE persona_id IS NOT NULL;

-- ============================================================================
-- 4. MIGRAR DATOS EXISTENTES: usuarios → personas
-- ============================================================================

-- Crear persona por cada usuario que tenga cédula registrada
INSERT INTO personas (
    numero_documento,
    tipo_documento_id,
    nombre,
    numero_contacto,
    direccion_residencia,
    ciudad_residencia,
    tipo_persona,
    factura_en_colombia,
    banco_id,
    tipo_cuenta_id,
    numero_cuenta,
    created_by
)
SELECT
    u.cedula,
    u.tipo_documento_id,
    u.nombre_usuario,
    u.telefono,
    u.direccion,
    u.ciudad,
    u.tipo_persona,
    u.factura_en_colombia,
    u.banco_id,
    u.tipo_cuenta_id,
    u.nro_cuenta_bancaria,
    u.id
FROM usuarios u
WHERE u.cedula IS NOT NULL
  AND TRIM(u.cedula) <> ''
ON CONFLICT (numero_documento) DO NOTHING;

-- Vincular usuarios con sus personas recién creadas.
-- Cuando dos usuarios comparten la misma cédula (dato duplicado en BD origen),
-- solo se vincula el de menor id para no romper el índice único persona_id.
UPDATE usuarios u
SET persona_id = p.id
FROM personas p
WHERE u.cedula = p.numero_documento
  AND u.persona_id IS NULL
  AND u.id = (
    SELECT MIN(u2.id)
    FROM usuarios u2
    WHERE u2.cedula = p.numero_documento
      AND u2.cedula IS NOT NULL
      AND TRIM(u2.cedula) <> ''
  );

-- Vincular por preregistro: elegir el más reciente no anulado para evitar ambigüedad
-- cuando una misma persona tiene varios preregistros (recontrataciones).
UPDATE personas p
SET preregistro_id = (
  SELECT pp.id
  FROM preregistro_personas pp
  WHERE pp.numero_documento = p.numero_documento
    AND pp.estado NOT IN ('Anulado')
    AND pp.numero_documento IS NOT NULL
  ORDER BY pp.updated_at DESC NULLS LAST
  LIMIT 1
)
WHERE p.numero_documento IS NOT NULL
  AND p.preregistro_id IS NULL;

-- ============================================================================
-- 5. VISTA COMPLETA v_usuarios_completo
-- ============================================================================

CREATE OR REPLACE VIEW v_usuarios_completo AS
SELECT
    u.id,
    u.public_id,
    u.nombre_usuario,
    u.email,
    u.azure_oid,
    u.activo,
    u.tipo_consultor,
    u.moneda_cobro,
    u.foto_url,
    u.observaciones,
    u.ultimo_inicio_sesion,
    u.persona_id,

    r.titulo                AS rol,
    cp.nombre_usuario       AS consultor_principal,

    -- Persona
    p.public_id             AS persona_public_id,
    p.estado                AS persona_estado,
    p.numero_documento,
    p.tipo_documento_id,
    di.titulo               AS tipo_documento,
    di.codigo               AS tipo_documento_codigo,
    p.tipo_persona,
    p.factura_en_colombia,
    p.nombre                AS persona_nombre,
    p.apellidos             AS persona_apellidos,
    p.numero_contacto       AS telefono,
    p.correo_electronico,
    p.direccion_residencia  AS direccion,
    p.ciudad_residencia     AS ciudad,
    p.departamento_pais,
    p.titulo_profesional,
    p.sexo,
    p.fecha_nacimiento,

    -- Contacto emergencia
    p.nombre_contacto_emergencia,
    p.telefono_contacto_emergencia,
    p.parentesco,

    -- Seguridad social
    p.eps,
    p.afp,
    p.arl,

    -- Familiar
    p.composicion_familiar,
    p.hijos,
    p.personas_a_cargo,

    -- Contrato
    p.tipo_contrato,
    p.modalidad,

    -- Módulo
    p.modulo_id,
    m.titulo                AS modulo_titulo,
    p.modulo_otro,

    -- Cliente
    p.cliente_id,
    cl.titulo               AS cliente_titulo,
    p.cliente_otro,

    -- Bancario
    p.banco_id,
    b.titulo                AS banco,
    p.tipo_cuenta_id,
    tcb.titulo              AS tipo_cuenta,
    p.numero_cuenta         AS nro_cuenta_bancaria,

    p.preregistro_id

FROM usuarios u
LEFT JOIN roles r                 ON u.rol_usuario_id   = r.id
LEFT JOIN personas p              ON u.persona_id       = p.id
LEFT JOIN documento_identidad di  ON p.tipo_documento_id = di.id
LEFT JOIN bancos b                ON p.banco_id         = b.id
LEFT JOIN tipo_cuenta_bancaria tcb ON p.tipo_cuenta_id  = tcb.id
LEFT JOIN modulo m                ON p.modulo_id        = m.id
LEFT JOIN clientes cl             ON p.cliente_id       = cl.id
LEFT JOIN usuarios cp             ON u.id_consultor_principal = cp.id;

COMMENT ON VIEW v_usuarios_completo IS 'Vista completa de usuarios con datos de persona, bancarios y de contrato';

COMMIT;
