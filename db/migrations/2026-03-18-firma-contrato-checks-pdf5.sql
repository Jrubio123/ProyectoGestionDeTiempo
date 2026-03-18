ALTER TABLE tokens_firma_contrato
ALTER COLUMN checks_completados
SET DEFAULT '{"pdf1":false,"pdf2":false,"pdf3":false,"pdf4":false,"pdf5":false}';

UPDATE tokens_firma_contrato
SET checks_completados = '{"pdf1":false,"pdf2":false,"pdf3":false,"pdf4":false,"pdf5":false}'::jsonb
WHERE checks_completados = '{"pdf1":false,"pdf2":false,"pdf3":false}'::jsonb;
