-- Alinea el vocabulario de estado entre solicitudes_contratacion y preregistro_personas
-- para casos originados en RRHH, de modo que el flujo post-convergencia use los
-- mismos estados operativos en ambos lados.

BEGIN;

ALTER TABLE solicitudes_contratacion
  DROP CONSTRAINT IF EXISTS solicitudes_contratacion_estado_check;

UPDATE solicitudes_contratacion sc
SET
  estado = CASE pp.estado
    WHEN 'Pendiente Coordinador' THEN 'Pendiente Coordinador'
    WHEN 'Pendiente Revision TH' THEN 'Pendiente Revision TH'
    WHEN 'Pendiente Correo Silver' THEN 'Pendiente Correo Silver'
    WHEN 'Completado' THEN 'Completado'
    WHEN 'Anulado' THEN 'Cancelado'
    ELSE sc.estado
  END,
  updated_at = NOW()
FROM preregistro_personas pp
WHERE sc.preregistro_id = pp.id
  AND COALESCE(sc.origen_flujo, '') = 'rrhh'
  AND pp.estado IN (
    'Pendiente Coordinador',
    'Pendiente Revision TH',
    'Pendiente Correo Silver',
    'Completado',
    'Anulado'
  )
  AND sc.estado IS DISTINCT FROM CASE pp.estado
    WHEN 'Pendiente Coordinador' THEN 'Pendiente Coordinador'
    WHEN 'Pendiente Revision TH' THEN 'Pendiente Revision TH'
    WHEN 'Pendiente Correo Silver' THEN 'Pendiente Correo Silver'
    WHEN 'Completado' THEN 'Completado'
    WHEN 'Anulado' THEN 'Cancelado'
    ELSE sc.estado
  END;

UPDATE solicitudes_contratacion
SET
  estado = 'Pendiente Coordinador',
  updated_at = NOW()
WHERE COALESCE(origen_flujo, '') = 'rrhh'
  AND estado = 'Pendiente';

ALTER TABLE solicitudes_contratacion
  ADD CONSTRAINT solicitudes_contratacion_estado_check
  CHECK (estado IN (
    'Pendiente',
    'Pendiente Coordinador',
    'En Proceso',
    'Pendiente Confirmación Cliente',
    'Pendiente Revision TH',
    'Pendiente Correo Silver',
    'Completado',
    'Cancelado'
  ));

COMMIT;
