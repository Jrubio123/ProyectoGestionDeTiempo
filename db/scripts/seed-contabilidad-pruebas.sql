-- Datos controlados para probar la proyeccion de pagos.
-- Periodo por defecto: septiembre de 2026.
-- Para cambiarlo, reemplazar (2026, 9) en los tres CTE "parametros".
--
-- Separacion usada actualmente por el motor:
--   SILVER      -> factura_en_colombia = TRUE, moneda_cobro = COP
--   CAPITALINK  -> factura_en_colombia = FALSE, moneda_cobro = USD
--
-- Este seed NO crea, actualiza ni elimina bancos. Reutiliza los codigos
-- conversores 1007 (Bancolombia) y 1013 (BBVA) existentes en public.bancos.

BEGIN;

SET LOCAL search_path TO public;

-- Catalogos minimos requeridos por las personas de prueba.
-- No duplica filas si el codigo ya existe.
INSERT INTO documento_identidad (titulo, codigo, codigo_bancario, activo)
SELECT 'Cedula', 'CC', '1', TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM documento_identidad
  WHERE UPPER(BTRIM(COALESCE(codigo, ''))) = 'CC'
     OR BTRIM(COALESCE(codigo_bancario, '')) = '1'
)
ON CONFLICT (titulo) DO UPDATE
SET codigo = EXCLUDED.codigo,
    codigo_bancario = EXCLUDED.codigo_bancario,
    activo = TRUE,
    updated_at = CURRENT_TIMESTAMP;

INSERT INTO documento_identidad (titulo, codigo, codigo_bancario, activo)
SELECT 'Pasaporte', 'PA', '5', TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM documento_identidad
  WHERE UPPER(BTRIM(COALESCE(codigo, ''))) IN ('PA', 'PAS')
     OR BTRIM(COALESCE(codigo_bancario, '')) = '5'
)
ON CONFLICT (titulo) DO UPDATE
SET codigo = EXCLUDED.codigo,
    codigo_bancario = EXCLUDED.codigo_bancario,
    activo = TRUE,
    updated_at = CURRENT_TIMESTAMP;

UPDATE tipo_cuenta_bancaria
SET titulo = 'Cuenta de Ahorros',
    tipo_transaccion = '37',
    activo = TRUE,
    updated_at = CURRENT_TIMESTAMP
WHERE tipo_cuenta = 7;

INSERT INTO tipo_cuenta_bancaria (titulo, tipo_cuenta, tipo_transaccion, activo)
SELECT 'Cuenta de Ahorros', 7, '37', TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM tipo_cuenta_bancaria WHERE tipo_cuenta = 7
);

-- Falla temprano si faltan bancos. Nunca modifica el catalogo bancos.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bancos
    WHERE BTRIM(COALESCE(codigo_conversor, '')) = '1007'
      AND activo IS NOT FALSE
  ) THEN
    RAISE EXCEPTION 'Falta Bancolombia (codigo_conversor 1007) en public.bancos';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM bancos
    WHERE BTRIM(COALESCE(codigo_conversor, '')) = '1013'
      AND activo IS NOT FALSE
  ) THEN
    RAISE EXCEPTION 'Falta BBVA (codigo_conversor 1013) en public.bancos';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PERSONAS SILVER
-- ---------------------------------------------------------------------------
WITH datos (
  numero_documento, nombre, apellidos, correo, tipo_contrato,
  banco_codigo, numero_cuenta, facturador_electronico, declarante_renta,
  es_gran_contribuyente, es_autorretenedor
) AS (
  VALUES
    (
      '1099000001', 'Natalia', 'Rios Silver', 'seed.natalia.silver@example.test',
      'Por horas'::tipo_contrato, '1007', '40990000001', FALSE, TRUE, FALSE, FALSE
    ),
    (
      '1099000002', 'Sebastian', 'Mora Silver', 'seed.sebastian.silver@example.test',
      'Por horas'::tipo_contrato, '1007', '40990000002', TRUE, TRUE, TRUE, TRUE
    ),
    (
      '1099000003', 'Laura', 'Gomez Nomina', 'seed.laura.nomina@example.test',
      'Vinculado'::tipo_contrato, '1007', '40990000003', FALSE, TRUE, FALSE, FALSE
    ),
    (
      '1099000004', 'Miguel', 'Perez Nomina', 'seed.miguel.nomina@example.test',
      'Vinculado'::tipo_contrato, '1007', '40990000004', FALSE, TRUE, FALSE, FALSE
    )
)
INSERT INTO personas (
  numero_documento, tipo_documento_id, estado, nombre, apellidos,
  correo_electronico, ciudad_residencia, tipo_persona, factura_en_colombia,
  banco_id, tipo_cuenta_id, numero_cuenta, moneda_cobro, tipo_contrato,
  facturador_electronico, declarante_renta, es_gran_contribuyente,
  es_autorretenedor, es_regimen_simple, es_entidad_sin_animo_lucro,
  es_economia_naranja, acumulado_facturacion_anual
)
SELECT
  d.numero_documento,
  (
    SELECT id FROM documento_identidad
    WHERE UPPER(BTRIM(COALESCE(codigo, ''))) = 'CC'
       OR BTRIM(COALESCE(codigo_bancario, '')) = '1'
    ORDER BY id LIMIT 1
  ),
  'activo', d.nombre, d.apellidos, d.correo, 'Medellin',
  'Natural'::tipo_persona, TRUE,
  (
    SELECT id FROM bancos
    WHERE BTRIM(COALESCE(codigo_conversor, '')) = d.banco_codigo
      AND activo IS NOT FALSE
    ORDER BY id LIMIT 1
  ),
  (SELECT id FROM tipo_cuenta_bancaria WHERE tipo_cuenta = 7 ORDER BY id LIMIT 1),
  d.numero_cuenta, 'COP'::tipo_moneda, d.tipo_contrato,
  d.facturador_electronico, d.declarante_renta, d.es_gran_contribuyente,
  d.es_autorretenedor, FALSE, FALSE, FALSE, 0
FROM datos d
ON CONFLICT (numero_documento) DO UPDATE
SET estado = EXCLUDED.estado,
    nombre = EXCLUDED.nombre,
    apellidos = EXCLUDED.apellidos,
    correo_electronico = EXCLUDED.correo_electronico,
    ciudad_residencia = EXCLUDED.ciudad_residencia,
    tipo_persona = EXCLUDED.tipo_persona,
    factura_en_colombia = EXCLUDED.factura_en_colombia,
    banco_id = EXCLUDED.banco_id,
    tipo_cuenta_id = EXCLUDED.tipo_cuenta_id,
    numero_cuenta = EXCLUDED.numero_cuenta,
    moneda_cobro = EXCLUDED.moneda_cobro,
    tipo_contrato = EXCLUDED.tipo_contrato,
    facturador_electronico = EXCLUDED.facturador_electronico,
    declarante_renta = EXCLUDED.declarante_renta,
    es_gran_contribuyente = EXCLUDED.es_gran_contribuyente,
    es_autorretenedor = EXCLUDED.es_autorretenedor,
    es_regimen_simple = EXCLUDED.es_regimen_simple,
    es_entidad_sin_animo_lucro = EXCLUDED.es_entidad_sin_animo_lucro,
    es_economia_naranja = EXCLUDED.es_economia_naranja,
    updated_at = CURRENT_TIMESTAMP;

-- ---------------------------------------------------------------------------
-- PERSONAS CAPITALINK
-- ---------------------------------------------------------------------------
WITH datos (
  numero_documento, nombre, apellidos, correo, numero_cuenta
) AS (
  VALUES
    ('CAP-TEST-001', 'Emma', 'Reed Capitalink', 'seed.emma.capitalink@example.test', '70990000001'),
    ('CAP-TEST-002', 'Noah', 'Turner Capitalink', 'seed.noah.capitalink@example.test', '70990000002')
)
INSERT INTO personas (
  numero_documento, tipo_documento_id, estado, nombre, apellidos,
  correo_electronico, ciudad_residencia, departamento_pais, pais_residencia,
  tipo_persona, factura_en_colombia, banco_id, tipo_cuenta_id, numero_cuenta,
  moneda_cobro, tipo_contrato, facturador_electronico, declarante_renta,
  es_gran_contribuyente, es_autorretenedor, es_regimen_simple,
  es_entidad_sin_animo_lucro, es_economia_naranja, acumulado_facturacion_anual
)
SELECT
  d.numero_documento,
  (
    SELECT id FROM documento_identidad
    WHERE UPPER(BTRIM(COALESCE(codigo, ''))) IN ('PA', 'PAS')
       OR BTRIM(COALESCE(codigo_bancario, '')) = '5'
    ORDER BY id LIMIT 1
  ),
  'activo', d.nombre, d.apellidos, d.correo, 'Miami', 'Florida, Estados Unidos',
  'Estados Unidos', 'Natural'::tipo_persona, FALSE,
  (
    SELECT id FROM bancos
    WHERE BTRIM(COALESCE(codigo_conversor, '')) = '1013'
      AND activo IS NOT FALSE
    ORDER BY id LIMIT 1
  ),
  (SELECT id FROM tipo_cuenta_bancaria WHERE tipo_cuenta = 7 ORDER BY id LIMIT 1),
  d.numero_cuenta, 'USD'::tipo_moneda, 'Por horas'::tipo_contrato,
  TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 0
FROM datos d
ON CONFLICT (numero_documento) DO UPDATE
SET estado = EXCLUDED.estado,
    nombre = EXCLUDED.nombre,
    apellidos = EXCLUDED.apellidos,
    correo_electronico = EXCLUDED.correo_electronico,
    ciudad_residencia = EXCLUDED.ciudad_residencia,
    departamento_pais = EXCLUDED.departamento_pais,
    pais_residencia = EXCLUDED.pais_residencia,
    tipo_persona = EXCLUDED.tipo_persona,
    factura_en_colombia = EXCLUDED.factura_en_colombia,
    banco_id = EXCLUDED.banco_id,
    tipo_cuenta_id = EXCLUDED.tipo_cuenta_id,
    numero_cuenta = EXCLUDED.numero_cuenta,
    moneda_cobro = EXCLUDED.moneda_cobro,
    tipo_contrato = EXCLUDED.tipo_contrato,
    facturador_electronico = EXCLUDED.facturador_electronico,
    declarante_renta = EXCLUDED.declarante_renta,
    es_gran_contribuyente = EXCLUDED.es_gran_contribuyente,
    es_autorretenedor = EXCLUDED.es_autorretenedor,
    es_regimen_simple = EXCLUDED.es_regimen_simple,
    es_entidad_sin_animo_lucro = EXCLUDED.es_entidad_sin_animo_lucro,
    es_economia_naranja = EXCLUDED.es_economia_naranja,
    updated_at = CURRENT_TIMESTAMP;

-- Usuarios tecnicos requeridos porque cuenta_cobro.created_by enlaza con personas.
WITH datos (numero_documento, email) AS (
  VALUES
    ('1099000001', 'seed.natalia.silver@example.test'),
    ('1099000002', 'seed.sebastian.silver@example.test'),
    ('1099000003', 'seed.laura.nomina@example.test'),
    ('1099000004', 'seed.miguel.nomina@example.test'),
    ('CAP-TEST-001', 'seed.emma.capitalink@example.test'),
    ('CAP-TEST-002', 'seed.noah.capitalink@example.test')
)
INSERT INTO usuarios (
  nombre_usuario, email, activo, nro_cuenta_bancaria, banco_id,
  tipo_cuenta_id, tipo_documento_id, cedula, ciudad, tipo_persona,
  factura_en_colombia, moneda_cobro, persona_id, created_by
)
SELECT
  BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)), d.email, TRUE,
  p.numero_cuenta, p.banco_id, p.tipo_cuenta_id, p.tipo_documento_id,
  p.numero_documento, p.ciudad_residencia, p.tipo_persona,
  p.factura_en_colombia, p.moneda_cobro, p.id, 'seed_contabilidad'
FROM datos d
JOIN personas p ON p.numero_documento = d.numero_documento
ON CONFLICT (email) DO UPDATE
SET nombre_usuario = EXCLUDED.nombre_usuario,
    activo = TRUE,
    nro_cuenta_bancaria = EXCLUDED.nro_cuenta_bancaria,
    banco_id = EXCLUDED.banco_id,
    tipo_cuenta_id = EXCLUDED.tipo_cuenta_id,
    tipo_documento_id = EXCLUDED.tipo_documento_id,
    cedula = EXCLUDED.cedula,
    ciudad = EXCLUDED.ciudad,
    tipo_persona = EXCLUDED.tipo_persona,
    factura_en_colombia = EXCLUDED.factura_en_colombia,
    moneda_cobro = EXCLUDED.moneda_cobro,
    persona_id = EXCLUDED.persona_id,
    updated_at = CURRENT_TIMESTAMP;

-- ---------------------------------------------------------------------------
-- ANEXOS: cuatro consultores y dos vinculados, separados por empresa.
-- ---------------------------------------------------------------------------
WITH parametros (anio, mes) AS (
  VALUES (2026, 9)
), datos (
  numero_documento, email, tipo_asignacion, empresa, modulo, moneda, tarifa
) AS (
  VALUES
    ('1099000001', 'seed.natalia.silver@example.test', 'proyecto', '[PRUEBA] SILVER', 'Desarrollo backend', 'COP', 10500000.00),
    ('1099000002', 'seed.sebastian.silver@example.test', 'proyecto', '[PRUEBA] SILVER', 'Arquitectura cloud', 'COP', 12800000.00),
    ('1099000003', 'seed.laura.nomina@example.test', 'full_time', '[PRUEBA] SILVER', 'Talento Humano', 'COP', 5000000.00),
    ('1099000004', 'seed.miguel.nomina@example.test', 'full_time', '[PRUEBA] SILVER', 'Contabilidad', 'COP', 5400000.00),
    ('CAP-TEST-001', 'seed.emma.capitalink@example.test', 'proyecto', '[PRUEBA] CAPITALINK', 'Integracion internacional', 'USD', 2800.00),
    ('CAP-TEST-002', 'seed.noah.capitalink@example.test', 'proyecto', '[PRUEBA] CAPITALINK', 'Analitica internacional', 'USD', 3400.00)
)
INSERT INTO anexo_tecnico_items (
  usuario_id, nombre_persona, numero_documento, correo_personal,
  tipo_asignacion, cliente_nombre, modulo_nombre, moneda, valor_tarifa,
  fecha_inicio, fecha_fin, fecha_fin_calculada, origen, estado,
  estado_firma, creado_por, updated_by
)
SELECT
  u.id, BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)), p.numero_documento,
  d.email, d.tipo_asignacion, d.empresa, d.modulo, d.moneda,
  d.tarifa,
  make_date(sp.anio, sp.mes, 1), make_date(sp.anio, 12, 31),
  FALSE, 'manual', 'activo', 'firmado', u.id, u.id
FROM datos d
JOIN personas p ON p.numero_documento = d.numero_documento
JOIN usuarios u ON LOWER(u.email) = LOWER(d.email)
CROSS JOIN parametros sp
WHERE NOT EXISTS (
  SELECT 1
  FROM anexo_tecnico_items ati
  WHERE ati.numero_documento = d.numero_documento
    AND ati.cliente_nombre = d.empresa
    AND ati.fecha_inicio = make_date(sp.anio, sp.mes, 1)
    AND ati.estado <> 'cancelado'
);

-- ---------------------------------------------------------------------------
-- CUENTAS DE COBRO SILVER Y CAPITALINK.
-- La fecha del archivo define automaticamente Q1 (dia 4) o Q2 (dia 18).
-- ---------------------------------------------------------------------------
WITH parametros (anio, mes) AS (
  VALUES (2026, 9)
), datos (
  numero_documento, email, empresa, quincena, valor, ciudad
) AS (
  VALUES
    ('1099000001', 'seed.natalia.silver@example.test', 'SILVER', 1, 2000000.00, 'Medellin'),
    ('1099000002', 'seed.sebastian.silver@example.test', 'SILVER', 2, 4800000.00, 'Medellin'),
    ('CAP-TEST-001', 'seed.emma.capitalink@example.test', 'CAPITALINK', 1, 1250.00, 'Miami'),
    ('CAP-TEST-002', 'seed.noah.capitalink@example.test', 'CAPITALINK', 2, 2100.00, 'Miami')
), cuentas AS (
  SELECT
    d.*,
    sp.anio,
    sp.mes,
    FORMAT('[PRUEBA][%s][Q%s] Cuenta de cobro %s-%s',
      d.empresa, d.quincena, sp.anio, LPAD(sp.mes::text, 2, '0')) AS descripcion,
    CASE WHEN d.quincena = 1 THEN make_date(sp.anio, sp.mes, 1)
         ELSE make_date(sp.anio, sp.mes, 16) END AS fecha_inicio,
    CASE WHEN d.quincena = 1 THEN make_date(sp.anio, sp.mes, 15)
         ELSE (make_date(sp.anio, sp.mes, 1) + INTERVAL '1 month - 1 day')::date END AS fecha_fin,
    CASE WHEN d.quincena = 1 THEN make_date(sp.anio, sp.mes, 4)
         ELSE make_date(sp.anio, sp.mes, 18) END AS fecha_archivo
  FROM datos d
  CROSS JOIN parametros sp
)
INSERT INTO cuenta_cobro (
  descripcion, fecha_correspondiente, total_cuenta_cobro,
  fecha_periodo_inicio, fecha_periodo_fin, total_letras, ciudad_cobro,
  datos_adjuntos, estado, created_by, ciclo_proyeccion_asignado,
  proyeccion_pago_id
)
SELECT
  c.descripcion,
  c.fecha_fin,
  c.valor,
  c.fecha_inicio,
  c.fecha_fin,
  '[VALOR DE PRUEBA]',
  c.ciudad,
  jsonb_build_object(
    'origen', 'seed_contabilidad',
    'empresa', c.empresa,
    'archivos', jsonb_build_array(
      jsonb_build_object(
        'nombre', FORMAT('soporte-%s-q%s.pdf', LOWER(c.empresa), c.quincena),
        'url', FORMAT('seed://contabilidad/%s/q%s/soporte.pdf', LOWER(c.empresa), c.quincena),
        'created_at', TO_CHAR(c.fecha_archivo, 'YYYY-MM-DD') || 'T10:00:00-05:00'
      )
    )
  ),
  'Aprobado',
  u.id,
  NULL,
  NULL
FROM cuentas c
JOIN usuarios u ON LOWER(u.email) = LOWER(c.email)
WHERE NOT EXISTS (
  SELECT 1 FROM cuenta_cobro cc WHERE cc.descripcion = c.descripcion
);

-- ---------------------------------------------------------------------------
-- NOMINA NETA: un vinculado por cada quincena.
-- ---------------------------------------------------------------------------
WITH parametros (anio, mes) AS (
  VALUES (2026, 9)
), datos (numero_documento, email, quincena, valor_neto) AS (
  VALUES
    ('1099000003', 'seed.laura.nomina@example.test', 1, 3250000.00),
    ('1099000004', 'seed.miguel.nomina@example.test', 2, 3480000.00)
)
INSERT INTO nomina_pagos_manual (
  mes, anio, quincena, persona_id, valor_neto, estado,
  proyeccion_pago_id, created_by
)
SELECT
  sp.mes, sp.anio, d.quincena, p.id, d.valor_neto,
  'Pendiente', NULL, u.id
FROM datos d
JOIN personas p ON p.numero_documento = d.numero_documento
JOIN usuarios u ON LOWER(u.email) = LOWER(d.email)
CROSS JOIN parametros sp
ON CONFLICT (anio, mes, quincena, persona_id) DO NOTHING;

-- Resumen antes de confirmar la transaccion.
SELECT
  CASE WHEN p.factura_en_colombia THEN 'SILVER' ELSE 'CAPITALINK' END AS empresa,
  p.numero_documento,
  BTRIM(CONCAT_WS(' ', p.nombre, p.apellidos)) AS persona,
  p.tipo_contrato,
  p.moneda_cobro,
  COUNT(DISTINCT cc.id) AS cuentas_cobro,
  COUNT(DISTINCT np.id) AS pagos_nomina,
  COUNT(DISTINCT ati.id) AS anexos
FROM personas p
LEFT JOIN usuarios u ON u.persona_id = p.id
LEFT JOIN cuenta_cobro cc ON cc.created_by = u.id
  AND cc.descripcion LIKE '[PRUEBA]%'
LEFT JOIN nomina_pagos_manual np ON np.persona_id = p.id
LEFT JOIN anexo_tecnico_items ati ON ati.usuario_id = u.id
  AND ati.cliente_nombre LIKE '[PRUEBA]%'
WHERE p.numero_documento IN (
  '1099000001', '1099000002', '1099000003', '1099000004',
  'CAP-TEST-001', 'CAP-TEST-002'
)
GROUP BY p.id
ORDER BY empresa DESC, p.numero_documento;

COMMIT;
