-- ============================================================================
-- Migración: personas como núcleo + trazabilidad de solicitante en anexo
-- Fecha: 2026-04-16
-- Descripción:
--   - Agrega solicitante_id y rol_solicitante a anexo_tecnico_items
--     para saber quién (y desde qué área) generó cada asignación,
--     independientemente de cuántos clientes/modalidades tenga un consultor.
--   - Backfill de solicitante_id desde solicitudes_contratacion existentes.
--   - No agrega columnas nuevas a personas: la tabla ya tiene todos los
--     campos del Excel de TH, incluyendo modulo_otro y cliente_otro.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. TRAZABILIDAD DE SOLICITANTE EN ANEXO TÉCNICO
-- ============================================================================

ALTER TABLE anexo_tecnico_items
  ADD COLUMN IF NOT EXISTS solicitante_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rol_solicitante  TEXT;

CREATE INDEX IF NOT EXISTS idx_anexo_solicitante ON anexo_tecnico_items(solicitante_id);

-- ============================================================================
-- 2. BACKFILL: poblar solicitante_id desde la solicitud de contratación origen
--    y rol_solicitante desde el rol del usuario en ese momento
-- ============================================================================

UPDATE anexo_tecnico_items ati
SET
  solicitante_id  = sc.coordinador_solicitante_id,
  rol_solicitante = r.titulo
FROM solicitudes_contratacion sc
JOIN usuarios u    ON u.id = sc.coordinador_solicitante_id
JOIN roles r       ON r.id = u.rol_usuario_id
WHERE ati.solicitud_contratacion_id = sc.id
  AND sc.coordinador_solicitante_id IS NOT NULL
  AND ati.solicitante_id IS NULL;

COMMIT;
