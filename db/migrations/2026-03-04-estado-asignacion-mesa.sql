-- Separa el estado de asignaciones de mesa/fabrica del enum general.
-- registro_asignaciones mantiene tipo_estado_asignacion (Abierto/Cerrado/Proceso).
-- asignaciones_consultoria_mesa_fabrica pasa a tipo_estado_asignacion_mesa (Activo/Inactivo).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tipo_estado_asignacion_mesa') THEN
    CREATE TYPE tipo_estado_asignacion_mesa AS ENUM ('Activo', 'Inactivo');
  END IF;
END$$;

ALTER TABLE asignaciones_consultoria_mesa_fabrica
  ALTER COLUMN estado_asignacion DROP DEFAULT;

ALTER TABLE asignaciones_consultoria_mesa_fabrica
  ALTER COLUMN estado_asignacion TYPE tipo_estado_asignacion_mesa
  USING (
    CASE estado_asignacion::text
      WHEN 'Abierto' THEN 'Activo'
      WHEN 'Proceso' THEN 'Activo'
      WHEN 'Cerrado' THEN 'Inactivo'
      ELSE 'Activo'
    END
  )::tipo_estado_asignacion_mesa;

ALTER TABLE asignaciones_consultoria_mesa_fabrica
  ALTER COLUMN estado_asignacion SET DEFAULT 'Activo';
