-- Uso: ejecutar despues de normalize-tarifas-vencidas-post-load.sql cuando aun
-- existan duplicados activos en tarifa_consultor y antes de crear el indice unico.
--
-- Estrategia:
-- 1. Agrupa tarifas activas por cliente + consultor + modulo + tipo_asignacion.
-- 2. Conserva una sola tarifa activa por grupo.
-- 3. Prefiere conservar la tarifa con mas usos en registro_asignaciones.
-- 4. En empate, conserva la mas reciente por updated_at/created_at/id.
-- 5. Las demas se marcan como inactivas; no se tocan las referencias historicas.

BEGIN;

WITH tarifas_activas AS (
  SELECT
    tc.id,
    tc.public_id,
    tc.id_cliente,
    tc.consultor_id,
    tc.modulo_id,
    tc.id_tipo_asignacion,
    tc.valor_tarifa,
    tc.created_at,
    tc.updated_at,
    COUNT(ra.id) AS usos_asignaciones
  FROM tarifa_consultor tc
  LEFT JOIN registro_asignaciones ra ON ra.id_tarifa = tc.id
  WHERE tc.activo = true
  GROUP BY
    tc.id,
    tc.public_id,
    tc.id_cliente,
    tc.consultor_id,
    tc.modulo_id,
    tc.id_tipo_asignacion,
    tc.valor_tarifa,
    tc.created_at,
    tc.updated_at
),
tarifas_ranked AS (
  SELECT
    ta.*,
    ROW_NUMBER() OVER (
      PARTITION BY ta.id_cliente, ta.consultor_id, ta.modulo_id, ta.id_tipo_asignacion
      ORDER BY
        ta.usos_asignaciones DESC,
        COALESCE(ta.updated_at, ta.created_at) DESC,
        ta.id DESC
    ) AS posicion_conservar,
    FIRST_VALUE(ta.id) OVER (
      PARTITION BY ta.id_cliente, ta.consultor_id, ta.modulo_id, ta.id_tipo_asignacion
      ORDER BY
        ta.usos_asignaciones DESC,
        COALESCE(ta.updated_at, ta.created_at) DESC,
        ta.id DESC
    ) AS tarifa_conservada_id
  FROM tarifas_activas ta
),
tarifas_desactivar AS (
  SELECT
    tr.id,
    tr.public_id,
    tr.id_cliente,
    tr.consultor_id,
    tr.modulo_id,
    tr.id_tipo_asignacion,
    tr.valor_tarifa,
    tr.usos_asignaciones,
    tr.tarifa_conservada_id
  FROM tarifas_ranked tr
  WHERE tr.posicion_conservar > 1
),
tarifas_actualizadas AS (
  UPDATE tarifa_consultor tc
  SET activo = false,
      updated_at = CURRENT_TIMESTAMP
  FROM tarifas_desactivar td
  WHERE tc.id = td.id
  RETURNING
    tc.id AS tarifa_desactivada_id,
    td.tarifa_conservada_id,
    td.id_cliente,
    td.consultor_id,
    td.modulo_id,
    td.id_tipo_asignacion,
    td.valor_tarifa,
    td.usos_asignaciones
)
SELECT *
FROM tarifas_actualizadas
ORDER BY id_cliente, consultor_id, modulo_id, id_tipo_asignacion, tarifa_desactivada_id;

COMMIT;

SELECT
  id_cliente,
  consultor_id,
  modulo_id,
  id_tipo_asignacion,
  COUNT(*) AS filas_activas,
  array_agg(id ORDER BY id) AS ids_activos
FROM tarifa_consultor
WHERE activo = true
GROUP BY id_cliente, consultor_id, modulo_id, id_tipo_asignacion
HAVING COUNT(*) > 1
ORDER BY filas_activas DESC, id_cliente, consultor_id, modulo_id, id_tipo_asignacion;
