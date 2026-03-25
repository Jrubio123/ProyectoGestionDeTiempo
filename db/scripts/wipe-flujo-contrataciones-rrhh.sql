-- =============================================================================
-- Vaciar datos operativos: RRHH (vacantes), preregistro, contrataciones,
-- anexos técnicos y tokens de firma (contrato + anexo individual).
--
-- NO borra tablas "madre" / core: usuarios, clientes, modulo, roles, bancos,
-- documento_identidad, consultorias, tarifa_consultor, registro_asignaciones,
-- cuenta_cobro, reporte_horas, usuario_licencias_backup, etc.
--
-- Un solo TRUNCATE con CASCADE: Postgres vacía todas las tablas listadas y las
-- que tengan FK hacia ellas (sin tocar tablas referenciadas desde fuera, p.ej. usuarios).
-- Ejecutar solo en entornos donde aceptes perder TODO este histórico.
-- =============================================================================

BEGIN;

TRUNCATE TABLE
  tokens_firma_anexo_individual,
  tokens_firma_contrato,
  anexo_tecnico_items,
  solicitudes_contratacion,
  preregistro_personas,
  solicitudes_rrhh
RESTART IDENTITY CASCADE;

COMMIT;
