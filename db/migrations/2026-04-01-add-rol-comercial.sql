-- Agrega el rol "Comercial" y el estado "Pendiente Comercial" al flujo de preregistro/contrataciones.
-- El rol Comercial procesa solicitudes RRHH antes de que lleguen a Talento Humano.

BEGIN;

-- 1. Insertar el rol Comercial (idempotente)
INSERT INTO roles (titulo, descripcion, activo)
VALUES ('Comercial', 'Equipo comercial: procesa solicitudes RRHH y completa información antes de TH', true)
ON CONFLICT (titulo) DO NOTHING;

-- 2. Ampliar CHECK constraint de preregistro_personas.estado
ALTER TABLE preregistro_personas
  DROP CONSTRAINT IF EXISTS preregistro_personas_estado_check;

ALTER TABLE preregistro_personas
  ADD CONSTRAINT preregistro_personas_estado_check
  CHECK (estado IN (
    'Pendiente Coordinador',
    'Pendiente Comercial',
    'Pendiente Revision TH',
    'Pendiente Correo Silver',
    'Completado',
    'Anulado'
  ));

-- 3. Ampliar CHECK constraint de solicitudes_contratacion.estado
ALTER TABLE solicitudes_contratacion
  DROP CONSTRAINT IF EXISTS solicitudes_contratacion_estado_check;

ALTER TABLE solicitudes_contratacion
  ADD CONSTRAINT solicitudes_contratacion_estado_check
  CHECK (estado IN (
    'Pendiente',
    'Pendiente Coordinador',
    'Pendiente Comercial',
    'En Proceso',
    'Pendiente Confirmación Cliente',
    'Pendiente Revision TH',
    'Pendiente Correo Silver',
    'Completado',
    'Cancelado'
  ));

COMMIT;
