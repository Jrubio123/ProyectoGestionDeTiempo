BEGIN;

-- Campos para persona jurídica (contratista) en personas y preregistro_personas.
-- Se usan para generar {ContratistaComparecencia} en plantillas DOCX de contratos.
-- razon_social:                  razón social de la empresa del contratista
-- nit_empresa:                   NIT de la empresa del contratista
-- representante_legal:           nombre del representante legal del contratista
-- tipo_documento_representante:  tipo de documento del representante (CC, CE, etc.)
-- numero_documento_representante: número de documento del representante

ALTER TABLE personas
    ADD COLUMN IF NOT EXISTS razon_social                   VARCHAR(255),
    ADD COLUMN IF NOT EXISTS nit_empresa                    VARCHAR(50),
    ADD COLUMN IF NOT EXISTS representante_legal            VARCHAR(255),
    ADD COLUMN IF NOT EXISTS tipo_documento_representante   VARCHAR(50),
    ADD COLUMN IF NOT EXISTS numero_documento_representante VARCHAR(50);

ALTER TABLE preregistro_personas
    ADD COLUMN IF NOT EXISTS razon_social                   VARCHAR(255),
    ADD COLUMN IF NOT EXISTS nit_empresa                    VARCHAR(50),
    ADD COLUMN IF NOT EXISTS representante_legal            VARCHAR(255),
    ADD COLUMN IF NOT EXISTS tipo_documento_representante   VARCHAR(50),
    ADD COLUMN IF NOT EXISTS numero_documento_representante VARCHAR(50);

COMMIT;
