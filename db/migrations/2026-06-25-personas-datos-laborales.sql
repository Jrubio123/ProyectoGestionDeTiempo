BEGIN;

-- Datos laborales requeridos para contratos vinculados.
ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS tipo_trabajador VARCHAR(100),
  ADD COLUMN IF NOT EXISTS cargo VARCHAR(200),
  ADD COLUMN IF NOT EXISTS salario_mensual NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS salario_moneda VARCHAR(3) DEFAULT 'COP',
  ADD COLUMN IF NOT EXISTS periodo_pago VARCHAR(50),
  ADD COLUMN IF NOT EXISTS periodo_prueba VARCHAR(150),
  ADD COLUMN IF NOT EXISTS jefe_inmediato VARCHAR(200),
  ADD COLUMN IF NOT EXISTS caja_compensacion VARCHAR(100),
  ADD COLUMN IF NOT EXISTS condiciones_especiales TEXT,
  ADD COLUMN IF NOT EXISTS duracion_contrato VARCHAR(100),
  ADD COLUMN IF NOT EXISTS fecha_inicio_labores DATE,
  ADD COLUMN IF NOT EXISTS lugar_celebracion VARCHAR(150);

COMMENT ON COLUMN personas.tipo_trabajador IS 'Tipo de trabajador para contrato laboral vinculado';
COMMENT ON COLUMN personas.cargo IS 'Cargo u oficio a desempeñar en contrato laboral';
COMMENT ON COLUMN personas.salario_mensual IS 'Salario mensual pactado para contrato laboral';
COMMENT ON COLUMN personas.salario_moneda IS 'Moneda del salario mensual del contrato laboral';
COMMENT ON COLUMN personas.periodo_pago IS 'Periodo de pago pactado para el salario';
COMMENT ON COLUMN personas.periodo_prueba IS 'Periodo de prueba acordado para el contrato';
COMMENT ON COLUMN personas.jefe_inmediato IS 'Jefe inmediato asignado al trabajador';
COMMENT ON COLUMN personas.caja_compensacion IS 'Caja de compensacion familiar del trabajador';
COMMENT ON COLUMN personas.condiciones_especiales IS 'Condiciones especiales del contrato laboral';
COMMENT ON COLUMN personas.duracion_contrato IS 'Duracion declarada del contrato laboral';
COMMENT ON COLUMN personas.fecha_inicio_labores IS 'Fecha de inicio de labores del trabajador';
COMMENT ON COLUMN personas.lugar_celebracion IS 'Lugar de celebracion del contrato laboral';

COMMIT;
