-- Migracion: indice unico parcial para tarifas activas
--
-- Secuencia segura:
-- 1. Si la carga historica ya transforma vencidas, insertarlas con activo=false.
-- 2. Si la carga ya ocurrio, correr primero db/scripts/normalize-tarifas-vencidas-post-load.sql.
-- 3. Si aun quedan duplicados activos, correr db/scripts/dedupe-tarifas-activas-post-load.sql.
-- 4. Aplicar esta migracion para dejar el indice unico parcial habilitado.
--
-- PASO 1: Desactivar tarifas vencidas que quedaron con activo=true.
-- Esto es necesario antes de crear el indice y para que los datos migrados
-- sean coherentes con la regla de negocio (una tarifa activa por combinacion).
UPDATE tarifa_consultor
SET activo = false
WHERE activo = true
  AND vigencia_hasta IS NOT NULL
  AND vigencia_hasta < CURRENT_DATE;

-- PASO 2: Indice unico parcial sobre filas activas.
-- CURRENT_DATE no se puede usar en predicados de indice (no es inmutable),
-- por lo que el predicado es solo activo=true. El PASO 1 garantiza que
-- los datos esten limpios antes de crear este constraint.
-- La API valida ademas vigencia_hasta en tiempo de ejecucion.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tarifa_unica_activa
  ON tarifa_consultor (id_cliente, consultor_id, modulo_id, id_tipo_asignacion)
  WHERE activo = true;
