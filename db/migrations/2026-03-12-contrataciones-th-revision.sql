-- Agrega estado 'Pendiente Revision TH' al flujo de contrataciones
-- y columnas de seguimiento para la revision de TH.

ALTER TABLE solicitudes_contratacion
  DROP CONSTRAINT IF EXISTS solicitudes_contratacion_estado_check;

ALTER TABLE solicitudes_contratacion
  ADD CONSTRAINT solicitudes_contratacion_estado_check
  CHECK (estado IN (
    'Pendiente',
    'En Proceso',
    'Pendiente Confirmación Cliente',
    'Pendiente Revision TH',
    'Completado',
    'Cancelado'
  ));

ALTER TABLE solicitudes_contratacion
  ADD COLUMN IF NOT EXISTS revisado_th_por    INT REFERENCES usuarios(id),
  ADD COLUMN IF NOT EXISTS fecha_revision_th  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS observaciones_th   TEXT;
