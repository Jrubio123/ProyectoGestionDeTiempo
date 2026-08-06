BEGIN;

-- Alinea preregistro_personas.tipo_persona con el resto del modelo (personas, usuarios).
-- En algunos entornos la columna quedo como texto con un CHECK que solo aceptaba
-- 'Juridica' sin tilde, mientras el backend escribe el valor del ENUM ('Jurídica').
-- Ver contrataciones-routes.js -> normalizeTipoPersonaForPreregistro.

-- 1. El ENUM debe existir antes de convertir la columna.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tipo_persona') THEN
        CREATE TYPE tipo_persona AS ENUM ('Natural', 'Jurídica');
    END IF;
END $$;

-- 2. El CHECK viejo se quita ANTES de tocar los datos: mientras exista, cualquier
--    escritura de 'Jurídica' con tilde falla con el mismo error 23514 que se quiere corregir.
ALTER TABLE preregistro_personas
    DROP CONSTRAINT IF EXISTS preregistro_personas_tipo_persona_check;

-- 3. Convertir la columna solo si todavia no es el ENUM (idempotente y seguro en entornos
--    creados desde init.sql). El CASE normaliza de paso las escrituras viejas, asi que no
--    hace falta un UPDATE aparte: comparar contra 'Juridica' fallaria si ya fuera ENUM.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'preregistro_personas'
          AND column_name = 'tipo_persona'
          AND udt_name <> 'tipo_persona'
    ) THEN
        ALTER TABLE preregistro_personas
            ALTER COLUMN tipo_persona TYPE tipo_persona
            USING (
                CASE LOWER(BTRIM(COALESCE(tipo_persona::text, '')))
                    WHEN 'natural'  THEN 'Natural'::tipo_persona
                    WHEN 'juridica' THEN 'Jurídica'::tipo_persona
                    WHEN 'jurídica' THEN 'Jurídica'::tipo_persona
                    ELSE NULL
                END
            );
    END IF;
END $$;

COMMIT;
