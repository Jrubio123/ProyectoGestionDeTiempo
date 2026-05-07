BEGIN;

ALTER TABLE reporte_horas
  ADD COLUMN IF NOT EXISTS aprobado_por INTEGER REFERENCES usuarios(id),
  ADD COLUMN IF NOT EXISTS fecha_aprobacion TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_reporte_horas_aprobado_por
  ON reporte_horas(aprobado_por);

COMMIT;
