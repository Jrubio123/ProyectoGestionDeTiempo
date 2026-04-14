-- ============================================================================
-- Migración: Actualizar v_consultores_activos para usar tabla personas
-- Fecha: 2026-04-14
-- Ejecutar DESPUÉS de 2026-04-14-add_personas.sql
-- ============================================================================

CREATE OR REPLACE VIEW v_consultores_activos AS
SELECT
    u.id,
    u.nombre_usuario,
    u.email,
    COALESCE(p.numero_documento, u.cedula)           AS cedula,
    COALESCE(p.numero_contacto, u.telefono)          AS telefono,
    r.titulo as rol,
    u.tipo_consultor,
    u.moneda_cobro,
    COALESCE(b_p.titulo, b_u.titulo)                 AS banco,
    COALESCE(p.numero_cuenta, u.nro_cuenta_bancaria) AS nro_cuenta_bancaria,
    COALESCE(tc_p.titulo, tc_u.titulo)               AS tipo_cuenta,
    cp.nombre_usuario as consultor_principal,
    u.activo
FROM usuarios u
    LEFT JOIN roles r                   ON u.rol_usuario_id  = r.id
    LEFT JOIN personas p                ON u.persona_id      = p.id
    LEFT JOIN bancos b_p                ON p.banco_id        = b_p.id
    LEFT JOIN bancos b_u                ON u.banco_id        = b_u.id
    LEFT JOIN tipo_cuenta_bancaria tc_p ON p.tipo_cuenta_id  = tc_p.id
    LEFT JOIN tipo_cuenta_bancaria tc_u ON u.tipo_cuenta_id  = tc_u.id
    LEFT JOIN usuarios cp               ON u.id_consultor_principal = cp.id
WHERE u.activo = true
    AND r.titulo IN ('Consultor', 'Consultor Principal');
