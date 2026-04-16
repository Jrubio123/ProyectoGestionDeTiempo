-- ============================================================================
-- Migración: ajustar ENUM tipo_contrato en personas
-- Fecha: 2026-04-16
-- Descripción:
--   - Migra 'Indefinido' → 'Vinculado' (equivalente en lenguaje RR.HH. colombiano)
--   - Renombra 'Aprendizaje' → 'Aprendiz'
--   - Agrega 'Vinculado'
--   - Elimina 'Indefinido' del tipo (recrea el ENUM sin ese valor)
--
-- Valores finales: 'Full time', 'Por horas', 'Aprendiz', 'Vinculado'
--
-- Separación de conceptos:
--   personas.tipo_contrato     → naturaleza del contrato (cualquier persona)
--   anexo_tecnico_items.tipo_asignacion → cómo se factura/asigna un consultor
-- ============================================================================

BEGIN;

-- PostgreSQL no permite eliminar valores de un ENUM. Para evitar problemas
-- usando valores nuevos dentro de la misma transaccion, primero se convierte
-- temporalmente la columna a texto, luego se normalizan los datos y se recrea
-- el ENUM final.
ALTER TABLE personas ALTER COLUMN tipo_contrato TYPE VARCHAR(50);

-- 1. Migrar 'Indefinido' -> 'Vinculado'
--    (en RR.HH. colombiano, contrato indefinido = vinculado directo con prestaciones)
UPDATE personas SET tipo_contrato = 'Vinculado' WHERE tipo_contrato = 'Indefinido';

-- 2. Renombrar 'Aprendizaje' -> 'Aprendiz'
UPDATE personas SET tipo_contrato = 'Aprendiz' WHERE tipo_contrato = 'Aprendizaje';

-- 3. Recrear el ENUM limpio sin 'Indefinido'
DROP TYPE tipo_contrato;
CREATE TYPE tipo_contrato AS ENUM ('Full time', 'Por horas', 'Aprendiz', 'Vinculado');
ALTER TABLE personas ALTER COLUMN tipo_contrato TYPE tipo_contrato USING tipo_contrato::tipo_contrato;

COMMIT;
