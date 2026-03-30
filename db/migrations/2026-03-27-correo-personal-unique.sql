-- Migración: prevenir que el mismo correo personal pertenezca a dos personas distintas
-- Fecha: 2026-03-27
--
-- Regla de negocio:
--   correo_personal debe ser único POR PERSONA (numero_documento).
--   Mismo correo + mismo documento → permitido (recontrataciones del mismo colaborador).
--   Mismo correo + distinto documento → bloqueado (dos personas distintas con el mismo correo).
--
-- Implementación: índice único compuesto sobre (correo_personal, numero_documento).
-- Un UNIQUE(correo_personal) simple NO sirve porque rompería las recontrataciones.
--
-- NOTA: antes de aplicar, verificar cruces existentes:
--   SELECT correo_personal, COUNT(DISTINCT numero_documento) AS personas
--   FROM preregistro_personas
--   WHERE correo_personal IS NOT NULL
--   GROUP BY correo_personal
--   HAVING COUNT(DISTINCT numero_documento) > 1;
--
-- Si existen filas, resolverlas manualmente antes de correr esta migración.

-- 1. Eliminar índices anteriores (si existen)
DROP INDEX IF EXISTS idx_preregistro_correo_personal;
DROP INDEX IF EXISTS uq_preregistro_correo_por_documento;

-- 2. Índice único compuesto: bloquea mismo correo para distintos documentos,
--    pero permite al mismo colaborador aparecer en múltiples contrataciones.
CREATE UNIQUE INDEX uq_preregistro_correo_por_documento
    ON preregistro_personas (correo_personal, numero_documento)
    WHERE correo_personal IS NOT NULL AND numero_documento IS NOT NULL;
