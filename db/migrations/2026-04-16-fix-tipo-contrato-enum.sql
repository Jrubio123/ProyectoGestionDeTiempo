-- ============================================================================
-- Migracion: ajustar ENUM tipo_contrato en personas
-- Fecha: 2026-04-16
-- Descripcion:
--   - Migra 'Indefinido' -> 'Vinculado' (equivalente en lenguaje RR.HH. colombiano)
--   - Renombra 'Aprendizaje' -> 'Aprendiz'
--   - Agrega 'Vinculado'
--   - Elimina 'Indefinido' del tipo (recrea el ENUM sin ese valor)
--
-- Valores finales: 'Full time', 'Por horas', 'Aprendiz', 'Vinculado'
--
-- Separacion de conceptos:
--   personas.tipo_contrato -> naturaleza del contrato (cualquier persona)
--   anexo_tecnico_items.tipo_asignacion -> como se factura/asigna un consultor
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS v_usuarios_completo;

-- PostgreSQL no permite eliminar valores de un ENUM. Para evitar problemas
-- usando valores nuevos dentro de la misma transaccion, primero se convierte
-- temporalmente la columna a texto, luego se normalizan los datos y se recrea
-- el ENUM final.
ALTER TABLE personas ALTER COLUMN tipo_contrato TYPE VARCHAR(50);

-- 1. Migrar 'Indefinido' -> 'Vinculado'
--    (en RR.HH. colombiano, contrato indefinido = vinculado directo con prestaciones)
UPDATE personas SET tipo_contrato = 'Vinculado' WHERE tipo_contrato = 'Indefinido';

-- 2. Renombrar 'Aprendizaje' -> 'Aprendiz'
UPDATE personas SET tipo_contrato = 'Aprendiz' WHERE tipo_contrato = 'Aprendizaje';

-- 3. Recrear el ENUM limpio sin 'Indefinido'
DROP TYPE tipo_contrato;
CREATE TYPE tipo_contrato AS ENUM ('Full time', 'Por horas', 'Aprendiz', 'Vinculado');
ALTER TABLE personas ALTER COLUMN tipo_contrato TYPE tipo_contrato USING tipo_contrato::tipo_contrato;

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

COMMIT;
