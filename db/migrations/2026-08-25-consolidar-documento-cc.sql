BEGIN;

DO $$
DECLARE
  tipo_cc_canonico_id INTEGER;
BEGIN
  SELECT di.id
  INTO tipo_cc_canonico_id
  FROM documento_identidad di
  WHERE UPPER(BTRIM(COALESCE(di.codigo, ''))) = 'CC'
     OR REGEXP_REPLACE(
          TRANSLATE(LOWER(BTRIM(di.titulo)), 'áéíóúüñ', 'aeiouun'),
          '[^a-z0-9]+',
          '',
          'g'
        ) IN ('cedula', 'ceduladeciudadania')
  ORDER BY
    (
      (SELECT COUNT(*) FROM personas p WHERE p.tipo_documento_id = di.id) +
      (SELECT COUNT(*) FROM usuarios u WHERE u.tipo_documento_id = di.id) +
      (SELECT COUNT(*) FROM preregistro_personas pp WHERE pp.tipo_documento_id = di.id) +
      (SELECT COUNT(*) FROM solicitudes_contratacion sc WHERE sc.tipo_documento_id = di.id)
    ) DESC,
    di.id ASC
  LIMIT 1;

  IF tipo_cc_canonico_id IS NOT NULL THEN
    UPDATE personas
    SET tipo_documento_id = tipo_cc_canonico_id,
        updated_at = CURRENT_TIMESTAMP
    WHERE tipo_documento_id IN (
      SELECT id
      FROM documento_identidad
      WHERE (
          UPPER(BTRIM(COALESCE(codigo, ''))) = 'CC'
          OR REGEXP_REPLACE(
               TRANSLATE(LOWER(BTRIM(titulo)), 'áéíóúüñ', 'aeiouun'),
               '[^a-z0-9]+',
               '',
               'g'
             ) IN ('cedula', 'ceduladeciudadania')
        )
        AND id <> tipo_cc_canonico_id
    );

    UPDATE usuarios
    SET tipo_documento_id = tipo_cc_canonico_id,
        updated_at = CURRENT_TIMESTAMP
    WHERE tipo_documento_id IN (
      SELECT id
      FROM documento_identidad
      WHERE (
          UPPER(BTRIM(COALESCE(codigo, ''))) = 'CC'
          OR REGEXP_REPLACE(
               TRANSLATE(LOWER(BTRIM(titulo)), 'áéíóúüñ', 'aeiouun'),
               '[^a-z0-9]+',
               '',
               'g'
             ) IN ('cedula', 'ceduladeciudadania')
        )
        AND id <> tipo_cc_canonico_id
    );

    UPDATE preregistro_personas
    SET tipo_documento_id = tipo_cc_canonico_id,
        updated_at = CURRENT_TIMESTAMP
    WHERE tipo_documento_id IN (
      SELECT id
      FROM documento_identidad
      WHERE (
          UPPER(BTRIM(COALESCE(codigo, ''))) = 'CC'
          OR REGEXP_REPLACE(
               TRANSLATE(LOWER(BTRIM(titulo)), 'áéíóúüñ', 'aeiouun'),
               '[^a-z0-9]+',
               '',
               'g'
             ) IN ('cedula', 'ceduladeciudadania')
        )
        AND id <> tipo_cc_canonico_id
    );

    UPDATE solicitudes_contratacion
    SET tipo_documento_id = tipo_cc_canonico_id,
        updated_at = CURRENT_TIMESTAMP
    WHERE tipo_documento_id IN (
      SELECT id
      FROM documento_identidad
      WHERE (
          UPPER(BTRIM(COALESCE(codigo, ''))) = 'CC'
          OR REGEXP_REPLACE(
               TRANSLATE(LOWER(BTRIM(titulo)), 'áéíóúüñ', 'aeiouun'),
               '[^a-z0-9]+',
               '',
               'g'
             ) IN ('cedula', 'ceduladeciudadania')
        )
        AND id <> tipo_cc_canonico_id
    );

    UPDATE documento_identidad
    SET activo = (id = tipo_cc_canonico_id),
        codigo = CASE WHEN id = tipo_cc_canonico_id THEN 'CC' ELSE codigo END,
        updated_at = CURRENT_TIMESTAMP
    WHERE UPPER(BTRIM(COALESCE(codigo, ''))) = 'CC'
       OR REGEXP_REPLACE(
            TRANSLATE(LOWER(BTRIM(titulo)), 'áéíóúüñ', 'aeiouun'),
            '[^a-z0-9]+',
            '',
            'g'
          ) IN ('cedula', 'ceduladeciudadania');
  END IF;
END $$;

COMMIT;
