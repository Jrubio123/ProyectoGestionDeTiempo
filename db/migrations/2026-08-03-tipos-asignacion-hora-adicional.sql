BEGIN;

INSERT INTO tipo_asignacion (titulo, descripcion, activo)
VALUES
    ('Hora Adicional Diurna', 'Horas adicionales trabajadas en jornada diurna', true),
    ('Hora Adicional Nocturna', 'Horas adicionales trabajadas en jornada nocturna', true),
    ('Hora Adicional Nocturna Dominical/Festivo', 'Horas adicionales nocturnas trabajadas en domingo o festivo', true),
    ('Hora Adicional Diurna Dominical/Festivo', 'Horas adicionales diurnas trabajadas en domingo o festivo', true)
ON CONFLICT (titulo) DO NOTHING;

COMMIT;
