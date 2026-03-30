-- Uso: ejecutar inmediatamente despues de cargar datos historicos en tarifa_consultor
-- y antes de aplicar el indice unico parcial en entornos existentes.
--
-- Ejemplo:
--   psql -U <usuario> -d <base> -f db/scripts/normalize-tarifas-vencidas-post-load.sql
--
-- Objetivo:
-- 1. Desactivar tarifas vencidas que aun llegaron con activo=true.
-- 2. Mostrar si todavia existen combinaciones activas duplicadas que bloquearian el indice.
-- 3. Si la consulta final devuelve filas, correr luego
--    db/scripts/dedupe-tarifas-activas-post-load.sql antes de crear el indice.

BEGIN;

WITH tarifas_normalizadas AS (
  UPDATE tarifa_consultor
  SET activo = false,
      updated_at = CURRENT_TIMESTAMP
  WHERE activo = true
    AND vigencia_hasta IS NOT NULL
    AND vigencia_hasta < CURRENT_DATE
  RETURNING id
)
SELECT COUNT(*) AS tarifas_vencidas_desactivadas
FROM tarifas_normalizadas;

COMMIT;

-- Si esta consulta devuelve filas, todavia quedan duplicados activos por resolver
-- antes de aplicar db/migrations/2026-03-30-tarifa-unique-index.sql.
SELECT
  tc.id_cliente,
  tc.consultor_id,
  tc.modulo_id,
  tc.id_tipo_asignacion,
  c.titulo AS cliente,
  u.nombre_usuario AS consultor,
  COALESCE(m.titulo, 'Sin modulo') AS modulo,
  COALESCE(ta.titulo, 'Sin tipo') AS tipo_asignacion,
  COUNT(*) AS filas_activas,
  array_agg(tc.id ORDER BY tc.id) AS ids_activos
FROM tarifa_consultor tc
JOIN clientes c ON c.id = tc.id_cliente
JOIN usuarios u ON u.id = tc.consultor_id
LEFT JOIN modulo m ON m.id = tc.modulo_id
LEFT JOIN tipo_asignacion ta ON ta.id = tc.id_tipo_asignacion
WHERE tc.activo = true
GROUP BY
  tc.id_cliente,
  tc.consultor_id,
  tc.modulo_id,
  tc.id_tipo_asignacion,
  c.titulo,
  u.nombre_usuario,
  COALESCE(m.titulo, 'Sin modulo'),
  COALESCE(ta.titulo, 'Sin tipo')
HAVING COUNT(*) > 1
ORDER BY filas_activas DESC, tc.id_cliente, tc.consultor_id, tc.modulo_id, tc.id_tipo_asignacion;
