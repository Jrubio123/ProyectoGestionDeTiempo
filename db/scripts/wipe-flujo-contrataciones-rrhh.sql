-- =============================================================================
-- Limpieza segura del flujo RRHH -> contratacion -> firma.
--
-- Borra:
--   - solicitudes_rrhh
--   - preregistro_personas
--   - solicitudes_contratacion
--   - anexo_tecnico_items
--   - tokens_firma_contrato
--   - tokens_firma_anexo_individual
--   - personas
--
-- No borra tablas base: usuarios, clientes, roles, bancos, modulo, etc.
--
-- Nota:
--   No usar TRUNCATE ... CASCADE sobre preregistro_personas porque puede arrastrar
--   personas por la FK personas.preregistro_id.
-- =============================================================================

BEGIN;

SELECT 'antes_tokens_firma_anexo_individual' AS tabla, COUNT(*) AS total FROM tokens_firma_anexo_individual
UNION ALL SELECT 'antes_tokens_firma_contrato', COUNT(*) FROM tokens_firma_contrato
UNION ALL SELECT 'antes_anexo_tecnico_items', COUNT(*) FROM anexo_tecnico_items
UNION ALL SELECT 'antes_solicitudes_contratacion', COUNT(*) FROM solicitudes_contratacion
UNION ALL SELECT 'antes_personas', COUNT(*) FROM personas
UNION ALL SELECT 'antes_preregistro_personas', COUNT(*) FROM preregistro_personas
UNION ALL SELECT 'antes_solicitudes_rrhh', COUNT(*) FROM solicitudes_rrhh;

-- Desvincula usuarios para permitir borrar las personas creadas por el flujo.
UPDATE usuarios
SET persona_id = NULL
WHERE persona_id IS NOT NULL;

-- Tablas hoja: se pueden truncar sin tocar personas/usuarios.
TRUNCATE TABLE
  tokens_firma_anexo_individual,
  tokens_firma_contrato,
  anexo_tecnico_items
RESTART IDENTITY;

-- Tablas del flujo: DELETE ordenado para respetar FKs externas.
DELETE FROM solicitudes_contratacion;
DELETE FROM personas;
DELETE FROM preregistro_personas;
DELETE FROM solicitudes_rrhh;

ALTER SEQUENCE IF EXISTS solicitudes_contratacion_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS personas_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS preregistro_personas_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS solicitudes_rrhh_id_seq RESTART WITH 1;

SELECT 'despues_tokens_firma_anexo_individual' AS tabla, COUNT(*) AS total FROM tokens_firma_anexo_individual
UNION ALL SELECT 'despues_tokens_firma_contrato', COUNT(*) FROM tokens_firma_contrato
UNION ALL SELECT 'despues_anexo_tecnico_items', COUNT(*) FROM anexo_tecnico_items
UNION ALL SELECT 'despues_solicitudes_contratacion', COUNT(*) FROM solicitudes_contratacion
UNION ALL SELECT 'despues_personas', COUNT(*) FROM personas
UNION ALL SELECT 'despues_preregistro_personas', COUNT(*) FROM preregistro_personas
UNION ALL SELECT 'despues_solicitudes_rrhh', COUNT(*) FROM solicitudes_rrhh;

COMMIT;
