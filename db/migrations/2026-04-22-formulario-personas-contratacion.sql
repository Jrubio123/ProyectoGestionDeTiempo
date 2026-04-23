BEGIN;

-- Campos que reemplazan el antiguo formulario externo de base de datos.
ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS lugar_nacimiento VARCHAR(150),
  ADD COLUMN IF NOT EXISTS lugar_expedicion VARCHAR(150),
  ADD COLUMN IF NOT EXISTS nacionalidad VARCHAR(100),
  ADD COLUMN IF NOT EXISTS estado_civil VARCHAR(30),
  ADD COLUMN IF NOT EXISTS barrio VARCHAR(120),
  ADD COLUMN IF NOT EXISTS pais_residencia VARCHAR(100),
  ADD COLUMN IF NOT EXISTS edades_hijos TEXT,
  ADD COLUMN IF NOT EXISTS visa_paises TEXT,
  ADD COLUMN IF NOT EXISTS acepta_tratamiento_datos BOOLEAN,
  ADD COLUMN IF NOT EXISTS tratamiento_datos_aceptado_at TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'personas_estado_civil_check'
  ) THEN
    ALTER TABLE personas
      ADD CONSTRAINT personas_estado_civil_check
      CHECK (
        estado_civil IS NULL
        OR estado_civil IN ('Soltero', 'Casado', 'Unión libre', 'Separado', 'Viudo')
      );
  END IF;
END $$;

INSERT INTO documento_identidad (titulo, codigo, activo)
VALUES ('Otras', 'OT', true)
ON CONFLICT (titulo) DO UPDATE
SET
  codigo = COALESCE(documento_identidad.codigo, EXCLUDED.codigo),
  activo = true,
  updated_at = CURRENT_TIMESTAMP;

DROP VIEW IF EXISTS v_usuarios_completo;

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
    p.pais_residencia,
    p.barrio,
    p.titulo_profesional,
    p.sexo,
    p.fecha_nacimiento,
    p.lugar_nacimiento,
    p.lugar_expedicion,
    p.nacionalidad,
    p.estado_civil,

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
    p.edades_hijos,
    p.visa_paises,
    p.acepta_tratamiento_datos,
    p.tratamiento_datos_aceptado_at,

    -- Contrato
    p.tipo_contrato,
    p.modalidad,

    -- Modulo
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
COMMENT ON COLUMN personas.lugar_nacimiento IS 'Lugar de nacimiento reportado en el formulario publico de contratacion';
COMMENT ON COLUMN personas.lugar_expedicion IS 'Lugar de expedicion del documento de identidad';
COMMENT ON COLUMN personas.pais_residencia IS 'Pais de residencia separado del departamento';
COMMENT ON COLUMN personas.edades_hijos IS 'Edades de hijos registradas como texto libre, separadas por punto y coma cuando aplica';
COMMENT ON COLUMN personas.visa_paises IS 'Paises de los que la persona reporta tener visa';
COMMENT ON COLUMN personas.acepta_tratamiento_datos IS 'Consentimiento de manejo de informacion en el formulario publico de contratacion';

COMMIT;
