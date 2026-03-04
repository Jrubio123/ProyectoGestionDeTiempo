-- Reemplaza tipo_servicio por tipo_permiso (ENUM) en permisos_administrador.
-- Ajusta la lista del ENUM si tienes mas opciones del Choice original.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tipo_permiso_admin') THEN
    CREATE TYPE tipo_permiso_admin AS ENUM ('Crear Asignación');
  END IF;
END$$;

ALTER TABLE permisos_administrador
  ADD COLUMN IF NOT EXISTS tipo_permiso tipo_permiso_admin;

-- Si existia tipo_servicio y habia datos, los marcamos con el permiso base.
-- Si quieres un mapeo 1:1 real, reemplaza esta asignacion por un CASE.
UPDATE permisos_administrador
SET tipo_permiso = 'Crear Asignación'
WHERE tipo_permiso IS NULL
  AND tipo_servicio IS NOT NULL;

ALTER TABLE permisos_administrador
  DROP COLUMN IF EXISTS tipo_servicio;
