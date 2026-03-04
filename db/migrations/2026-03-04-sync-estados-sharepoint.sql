-- Alinea enums de estados con las opciones reales de SharePoint.
-- Nota: se conserva En_Firma para el flujo de firma digital en cuenta_cobro.
-- - EstadoReporte: Aprobado, En_Firma, Pendiente, Rechazado, Revisión
-- - EstadoMesaServicio: Cerrado, En proceso, Transferido Corona, Transferido Silver
-- - EstadoFabrica: En desarrollo, Finalizado

BEGIN;

-- La vista depende de reporte_horas.estado_reporte y bloquea ALTER TYPE
DROP VIEW IF EXISTS v_reportes_pendientes;

-- 1) tipo_estado_reporte
CREATE TYPE tipo_estado_reporte_v2 AS ENUM (
  'Aprobado',
  'En_Firma',
  'Pendiente',
  'Rechazado',
  'Revisión'
);

ALTER TABLE cuenta_cobro
  ALTER COLUMN estado DROP DEFAULT;

ALTER TABLE reporte_horas
  ALTER COLUMN estado_reporte DROP DEFAULT;

ALTER TABLE cuenta_cobro
  ALTER COLUMN estado TYPE tipo_estado_reporte_v2
  USING (estado::text)::tipo_estado_reporte_v2;

ALTER TABLE reporte_horas
  ALTER COLUMN estado_reporte TYPE tipo_estado_reporte_v2
  USING (estado_reporte::text)::tipo_estado_reporte_v2;

ALTER TABLE cuenta_cobro
  ALTER COLUMN estado SET DEFAULT 'Pendiente';

ALTER TABLE reporte_horas
  ALTER COLUMN estado_reporte SET DEFAULT 'Pendiente';

DROP TYPE tipo_estado_reporte;
ALTER TYPE tipo_estado_reporte_v2 RENAME TO tipo_estado_reporte;

-- 2) tipo_estado_mesa
CREATE TYPE tipo_estado_mesa_v2 AS ENUM (
  'Cerrado',
  'En proceso',
  'Transferido Silver',
  'Transferido Corona'
);

ALTER TABLE reporte_horas
  ALTER COLUMN estado_mesa_servicio TYPE tipo_estado_mesa_v2
  USING (
    CASE estado_mesa_servicio::text
      WHEN 'Abierto' THEN 'En proceso'
      WHEN 'En Proceso' THEN 'En proceso'
      WHEN 'Suspendido' THEN 'En proceso'
      ELSE estado_mesa_servicio::text
    END
  )::tipo_estado_mesa_v2;

DROP TYPE tipo_estado_mesa;
ALTER TYPE tipo_estado_mesa_v2 RENAME TO tipo_estado_mesa;

-- 3) tipo_estado_fabrica
CREATE TYPE tipo_estado_fabrica_v2 AS ENUM (
  'En desarrollo',
  'Finalizado'
);

ALTER TABLE reporte_horas
  ALTER COLUMN estado_fabrica TYPE tipo_estado_fabrica_v2
  USING (
    CASE estado_fabrica::text
      WHEN 'En Proceso' THEN 'En desarrollo'
      WHEN 'Pendiente' THEN 'En desarrollo'
      WHEN 'Cancelado' THEN 'En desarrollo'
      ELSE estado_fabrica::text
    END
  )::tipo_estado_fabrica_v2;

DROP TYPE tipo_estado_fabrica;
ALTER TYPE tipo_estado_fabrica_v2 RENAME TO tipo_estado_fabrica;

-- Recrear vista util luego de cambiar enums
CREATE OR REPLACE VIEW v_reportes_pendientes AS
SELECT
    rh.id,
    c.titulo as cliente,
    c.nit as cliente_nit,
    u.nombre_usuario as consultor,
    u.email as consultor_email,
    coord.nombre_usuario as coordinador,
    rh.horas_reportadas,
    rh.cantidad_dias_reportados,
    rh.total_cobrar,
    rh.estado_reporte,
    rh.nro_caso_int_ext,
    m.titulo as modulo,
    rh.created_at as fecha_reporte,
    rh.fecha_cierre_mesa_fab
FROM reporte_horas rh
    LEFT JOIN clientes c ON rh.cliente_id = c.id
    LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
    LEFT JOIN usuarios coord ON rh.coordinador_id = coord.id
    LEFT JOIN modulo m ON rh.modulo_id = m.id
WHERE rh.estado_reporte = 'Pendiente';

COMMENT ON VIEW v_reportes_pendientes IS 'Vista de reportes de horas pendientes de aprobar';

COMMIT;
