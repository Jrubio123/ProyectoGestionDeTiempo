BEGIN;

-- Repara preregistros que ya llegaron a TH antes de que la ficha de persona
-- se materializara al guardar la sección 3.
WITH preregistros_fuente AS (
  SELECT DISTINCT ON (BTRIM(pp.numero_documento))
    pp.*,
    sr.perfil,
    COALESCE(sc.modulo_id_resuelto, sr.modulo_id) AS modulo_id_resuelto,
    COALESCE(sc.cliente_id, sc.cliente_id_resuelto, sr.cliente_id) AS cliente_id_resuelto,
    CASE
      WHEN COALESCE(sc.modulo_id_resuelto, sr.modulo_id) IS NULL
        THEN COALESCE(
          sc.datos_extra->>'modulo_nombre',
          sc.datos_extra->>'modulo_otro',
          sc.datos_extra->>'modulo',
          sr.perfil
        )
      ELSE NULL
    END AS modulo_otro_resuelto,
    CASE
      WHEN COALESCE(sc.cliente_id, sc.cliente_id_resuelto, sr.cliente_id) IS NULL
        THEN COALESCE(sc.datos_extra->>'cliente_nombre', sr.cliente_nombre_otro)
      ELSE NULL
    END AS cliente_otro_resuelto,
    COALESCE(pp.tipo_cuenta_id, tcb.id) AS tipo_cuenta_id_resuelto
  FROM preregistro_personas pp
  LEFT JOIN solicitudes_rrhh sr ON sr.id = pp.id_solicitud_rrhh
  LEFT JOIN LATERAL (
    SELECT
      solicitud.cliente_id,
      solicitud.datos_extra,
      modulo_catalogo.id AS modulo_id_resuelto,
      cliente_catalogo.id AS cliente_id_resuelto
    FROM solicitudes_contratacion solicitud
    LEFT JOIN LATERAL (
      SELECT m.id
      FROM modulo m
      WHERE m.public_id::text = solicitud.datos_extra->>'modulo_id'
         OR m.id::text = solicitud.datos_extra->>'modulo_id'
      LIMIT 1
    ) modulo_catalogo ON true
    LEFT JOIN LATERAL (
      SELECT c.id
      FROM clientes c
      WHERE c.public_id::text = solicitud.datos_extra->>'cliente_id'
         OR c.id::text = solicitud.datos_extra->>'cliente_id'
      LIMIT 1
    ) cliente_catalogo ON true
    WHERE solicitud.preregistro_id = pp.id
      AND solicitud.estado <> 'Cancelado'
    ORDER BY solicitud.updated_at DESC
    LIMIT 1
  ) sc ON true
  LEFT JOIN LATERAL (
    SELECT id
    FROM tipo_cuenta_bancaria
    WHERE LOWER(titulo) LIKE LOWER(COALESCE(pp.tipo_cuenta, '') || '%')
    ORDER BY id
    LIMIT 1
  ) tcb ON true
  WHERE pp.estado IN ('Pendiente Revision TH', 'Pendiente Correo Silver', 'Completado')
    AND NULLIF(BTRIM(pp.numero_documento), '') IS NOT NULL
  ORDER BY BTRIM(pp.numero_documento), pp.updated_at DESC
)
INSERT INTO personas (
  numero_documento, tipo_documento_id, nombre, apellidos,
  numero_contacto, correo_electronico, direccion_residencia, ciudad_residencia,
  tipo_persona, factura_en_colombia,
  banco_id, tipo_cuenta_id, numero_cuenta,
  modulo_id, modulo_otro, cliente_id, cliente_otro,
  razon_social, nit_empresa, representante_legal,
  tipo_documento_representante, numero_documento_representante,
  preregistro_id, created_by
)
SELECT
  BTRIM(numero_documento), tipo_documento_id, nombre, apellidos,
  telefono, correo_personal, direccion, ciudad,
  CASE LOWER(BTRIM(tipo_persona::text))
    WHEN 'natural' THEN 'Natural'::tipo_persona
    WHEN 'juridica' THEN 'Jurídica'::tipo_persona
    WHEN 'jurídica' THEN 'Jurídica'::tipo_persona
    ELSE NULL
  END,
  CASE LOWER(BTRIM(factura_en_colombia::text))
    WHEN 'true' THEN true
    WHEN 'false' THEN false
    ELSE NULL
  END,
  banco_id, tipo_cuenta_id_resuelto, numero_cuenta,
  modulo_id_resuelto, modulo_otro_resuelto, cliente_id_resuelto, cliente_otro_resuelto,
  razon_social, nit_empresa, representante_legal,
  tipo_documento_representante, numero_documento_representante,
  id, COALESCE(completado_th_por, creado_por)
FROM preregistros_fuente
ON CONFLICT (numero_documento) DO UPDATE SET
  tipo_documento_id              = COALESCE(EXCLUDED.tipo_documento_id, personas.tipo_documento_id),
  nombre                         = COALESCE(EXCLUDED.nombre, personas.nombre),
  apellidos                      = COALESCE(EXCLUDED.apellidos, personas.apellidos),
  numero_contacto                = COALESCE(EXCLUDED.numero_contacto, personas.numero_contacto),
  correo_electronico             = COALESCE(EXCLUDED.correo_electronico, personas.correo_electronico),
  direccion_residencia           = COALESCE(EXCLUDED.direccion_residencia, personas.direccion_residencia),
  ciudad_residencia              = COALESCE(EXCLUDED.ciudad_residencia, personas.ciudad_residencia),
  tipo_persona                   = COALESCE(EXCLUDED.tipo_persona, personas.tipo_persona),
  factura_en_colombia            = COALESCE(EXCLUDED.factura_en_colombia, personas.factura_en_colombia),
  banco_id                       = COALESCE(EXCLUDED.banco_id, personas.banco_id),
  tipo_cuenta_id                 = COALESCE(EXCLUDED.tipo_cuenta_id, personas.tipo_cuenta_id),
  numero_cuenta                  = COALESCE(EXCLUDED.numero_cuenta, personas.numero_cuenta),
  modulo_id                      = COALESCE(EXCLUDED.modulo_id, personas.modulo_id),
  modulo_otro                    = COALESCE(EXCLUDED.modulo_otro, personas.modulo_otro),
  cliente_id                     = COALESCE(EXCLUDED.cliente_id, personas.cliente_id),
  cliente_otro                   = COALESCE(EXCLUDED.cliente_otro, personas.cliente_otro),
  razon_social                   = COALESCE(EXCLUDED.razon_social, personas.razon_social),
  nit_empresa                    = COALESCE(EXCLUDED.nit_empresa, personas.nit_empresa),
  representante_legal            = COALESCE(EXCLUDED.representante_legal, personas.representante_legal),
  tipo_documento_representante   = COALESCE(EXCLUDED.tipo_documento_representante, personas.tipo_documento_representante),
  numero_documento_representante = COALESCE(EXCLUDED.numero_documento_representante, personas.numero_documento_representante),
  preregistro_id                 = COALESCE(EXCLUDED.preregistro_id, personas.preregistro_id),
  estado                         = 'activo',
  updated_at                     = NOW();

-- Repara solicitudes directas que no tienen preregistro asociado.
WITH solicitudes_fuente AS (
  SELECT DISTINCT ON (BTRIM(sc.numero_documento))
    sc.*,
    banco.id AS banco_id_resuelto,
    modulo_catalogo.id AS modulo_id_resuelto,
    tcb.id AS tipo_cuenta_id_resuelto
  FROM solicitudes_contratacion sc
  LEFT JOIN LATERAL (
    SELECT b.id
    FROM bancos b
    WHERE b.public_id::text = sc.datos_extra->>'banco_id'
       OR b.id::text = sc.datos_extra->>'banco_id'
    LIMIT 1
  ) banco ON true
  LEFT JOIN LATERAL (
    SELECT m.id
    FROM modulo m
    WHERE m.public_id::text = sc.datos_extra->>'modulo_id'
       OR m.id::text = sc.datos_extra->>'modulo_id'
    LIMIT 1
  ) modulo_catalogo ON true
  LEFT JOIN LATERAL (
    SELECT id
    FROM tipo_cuenta_bancaria
    WHERE LOWER(titulo) LIKE LOWER(COALESCE(sc.datos_extra->>'tipo_cuenta', '') || '%')
    ORDER BY id
    LIMIT 1
  ) tcb ON true
  WHERE sc.tipo_solicitud = 'Nuevo'
    AND sc.preregistro_id IS NULL
    AND sc.estado IN ('Pendiente Revision TH', 'Pendiente Correo Silver', 'Completado')
    AND NULLIF(BTRIM(sc.numero_documento), '') IS NOT NULL
  ORDER BY BTRIM(sc.numero_documento), sc.updated_at DESC
)
INSERT INTO personas (
  numero_documento, tipo_documento_id, nombre, apellidos,
  numero_contacto, correo_electronico, direccion_residencia, ciudad_residencia,
  tipo_persona, factura_en_colombia,
  banco_id, tipo_cuenta_id, numero_cuenta,
  modulo_id, modulo_otro, cliente_id, cliente_otro,
  razon_social, nit_empresa, representante_legal,
  tipo_documento_representante, numero_documento_representante,
  created_by
)
SELECT
  BTRIM(numero_documento), tipo_documento_id, nombre, apellidos,
  telefono, correo_personal, datos_extra->>'direccion', ubicacion,
  CASE LOWER(datos_extra->>'tipo_persona')
    WHEN 'natural' THEN 'Natural'::tipo_persona
    WHEN 'juridica' THEN 'Jurídica'::tipo_persona
    WHEN 'jurídica' THEN 'Jurídica'::tipo_persona
    ELSE NULL
  END,
  CASE LOWER(datos_extra->>'factura_en_colombia')
    WHEN 'true' THEN true
    WHEN 'false' THEN false
    ELSE NULL
  END,
  banco_id_resuelto, tipo_cuenta_id_resuelto, datos_extra->>'numero_cuenta',
  modulo_id_resuelto,
  CASE WHEN modulo_id_resuelto IS NULL
    THEN COALESCE(
      datos_extra->>'modulo_nombre',
      datos_extra->>'modulo_otro',
      datos_extra->>'modulo',
      perfil
    )
    ELSE NULL
  END,
  cliente_id,
  CASE WHEN cliente_id IS NULL THEN datos_extra->>'cliente_nombre' ELSE NULL END,
  datos_extra->>'razon_social',
  datos_extra->>'nit_empresa',
  datos_extra->>'representante_legal',
  datos_extra->>'tipo_documento_representante',
  datos_extra->>'numero_documento_representante',
  COALESCE(revisado_th_por, coordinador_solicitante_id)
FROM solicitudes_fuente
ON CONFLICT (numero_documento) DO UPDATE SET
  tipo_documento_id              = COALESCE(EXCLUDED.tipo_documento_id, personas.tipo_documento_id),
  nombre                         = COALESCE(EXCLUDED.nombre, personas.nombre),
  apellidos                      = COALESCE(EXCLUDED.apellidos, personas.apellidos),
  numero_contacto                = COALESCE(EXCLUDED.numero_contacto, personas.numero_contacto),
  correo_electronico             = COALESCE(EXCLUDED.correo_electronico, personas.correo_electronico),
  direccion_residencia           = COALESCE(EXCLUDED.direccion_residencia, personas.direccion_residencia),
  ciudad_residencia              = COALESCE(EXCLUDED.ciudad_residencia, personas.ciudad_residencia),
  tipo_persona                   = COALESCE(EXCLUDED.tipo_persona, personas.tipo_persona),
  factura_en_colombia            = COALESCE(EXCLUDED.factura_en_colombia, personas.factura_en_colombia),
  banco_id                       = COALESCE(EXCLUDED.banco_id, personas.banco_id),
  tipo_cuenta_id                 = COALESCE(EXCLUDED.tipo_cuenta_id, personas.tipo_cuenta_id),
  numero_cuenta                  = COALESCE(EXCLUDED.numero_cuenta, personas.numero_cuenta),
  modulo_id                      = COALESCE(EXCLUDED.modulo_id, personas.modulo_id),
  modulo_otro                    = COALESCE(EXCLUDED.modulo_otro, personas.modulo_otro),
  cliente_id                     = COALESCE(EXCLUDED.cliente_id, personas.cliente_id),
  cliente_otro                   = COALESCE(EXCLUDED.cliente_otro, personas.cliente_otro),
  razon_social                   = COALESCE(EXCLUDED.razon_social, personas.razon_social),
  nit_empresa                    = COALESCE(EXCLUDED.nit_empresa, personas.nit_empresa),
  representante_legal            = COALESCE(EXCLUDED.representante_legal, personas.representante_legal),
  tipo_documento_representante   = COALESCE(EXCLUDED.tipo_documento_representante, personas.tipo_documento_representante),
  numero_documento_representante = COALESCE(EXCLUDED.numero_documento_representante, personas.numero_documento_representante),
  estado                         = 'activo',
  updated_at                     = NOW();

COMMIT;
