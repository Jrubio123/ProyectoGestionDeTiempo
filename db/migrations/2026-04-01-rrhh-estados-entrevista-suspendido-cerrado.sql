-- Actualiza catalogo de estados de solicitudes_rrhh segun lineamientos de RRHH:
-- Pendiente, Reclutamiento, Entrevistas, Contratado, Suspendido, Cerrado.
-- Migracion de datos legado:
-- - Entrevista -> Entrevistas
-- - Cancelado -> Cerrado

BEGIN;

ALTER TABLE solicitudes_rrhh
  DROP CONSTRAINT IF EXISTS solicitudes_rrhh_estado_check;

UPDATE solicitudes_rrhh
SET estado = 'Entrevistas'
WHERE estado = 'Entrevista';

UPDATE solicitudes_rrhh
SET estado = 'Cerrado'
WHERE estado = 'Cancelado';

ALTER TABLE solicitudes_rrhh
  ADD CONSTRAINT solicitudes_rrhh_estado_check
  CHECK (estado IN (
    'Pendiente',
    'Reclutamiento',
    'Entrevistas',
    'Contratado',
    'Suspendido',
    'Cerrado'
  ));

COMMIT;
