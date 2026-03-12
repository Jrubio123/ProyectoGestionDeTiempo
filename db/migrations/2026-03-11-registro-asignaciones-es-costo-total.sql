ALTER TABLE registro_asignaciones
ADD COLUMN IF NOT EXISTS es_costo_total BOOLEAN DEFAULT false;

UPDATE registro_asignaciones
SET es_costo_total = false
WHERE es_costo_total IS NULL;

ALTER TABLE registro_asignaciones
ALTER COLUMN es_costo_total SET DEFAULT false;
