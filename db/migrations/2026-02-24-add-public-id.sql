-- Agrega public_id UUID a las tablas principales para exponer IDs públicos en API.
-- Requiere PostgreSQL 16+ (gen_random_uuid nativo).

DO $$
DECLARE
  t TEXT;
  has_unique_public_id BOOLEAN;
  tables TEXT[] := ARRAY[
    'bancos',
    'roles',
    'tipo_cuenta_bancaria',
    'documento_identidad',
    'clientes',
    'tipo_asignacion',
    'modulo',
    'period_1',
    'place_value_1',
    'usuarios',
    'consultorias',
    'tarifa_consultor',
    'registro_asignaciones',
    'cuenta_cobro',
    'reporte_horas',
    'asignaciones_consultoria_mesa_fabrica',
    'permisos_administrador',
    'solicitudes_rrhh'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS public_id UUID', t);
    EXECUTE format('UPDATE %I SET public_id = gen_random_uuid() WHERE public_id IS NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN public_id SET DEFAULT gen_random_uuid()', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN public_id SET NOT NULL', t);

    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class tbl
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      JOIN pg_catalog.pg_index i ON i.indrelid = tbl.oid
      JOIN pg_catalog.pg_attribute a ON a.attrelid = tbl.oid
      WHERE ns.nspname = current_schema()
        AND tbl.relname = t
        AND a.attname = 'public_id'
        AND a.attnum = ANY(i.indkey)
        AND i.indisunique
    ) INTO has_unique_public_id;

    IF NOT has_unique_public_id THEN
      EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS idx_%I_public_id ON %I(public_id)', t, t);
    END IF;
  END LOOP;
END $$;
