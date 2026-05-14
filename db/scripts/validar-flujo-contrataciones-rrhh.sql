-- =============================================================================
-- Consultas de validacion del flujo RRHH -> TH -> contratacion/firma.
--
-- Uso:
--   1. Ejecuta el bloque del paso que quieras validar.
--   2. Si necesitas filtrar, cambia los NULL del WITH p AS (...) de ese bloque.
-- =============================================================================

-- 0. Catalogos y usuarios base para probar.
SELECT
  r.titulo AS rol,
  u.public_id AS usuario_public_id,
  u.nombre_usuario,
  u.email
FROM usuarios u
JOIN roles r ON r.id = u.rol_usuario_id
WHERE u.activo = true
  AND r.titulo IN ('Administrador', 'Coordinador', 'Comercial', 'Reclutador', 'Talento Humano')
ORDER BY r.titulo, u.nombre_usuario;

SELECT public_id AS cliente_public_id, titulo, requiere_confirmacion_cliente
FROM clientes
WHERE activo = true
ORDER BY titulo;

SELECT public_id AS modulo_public_id, titulo
FROM modulo
WHERE activo = true
ORDER BY titulo;

SELECT public_id AS documento_public_id, titulo, codigo
FROM documento_identidad
WHERE activo = true
ORDER BY titulo;

SELECT public_id AS banco_public_id, titulo
FROM bancos
WHERE activo = true
ORDER BY titulo;

-- 1. Despues de crear la solicitud RRHH.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  sr.id AS rrhh_internal_id,
  sr.public_id AS rrhh_public_id,
  sr.estado,
  sr.perfil,
  sr.nivel,
  sr.modalidad,
  sr.ubicacion,
  COALESCE(c.titulo, sr.cliente_nombre_otro) AS cliente,
  m.titulo AS modulo,
  coord.nombre_usuario AS coordinador,
  sr.created_at,
  sr.updated_at
FROM solicitudes_rrhh sr
CROSS JOIN p
LEFT JOIN clientes c ON c.id = sr.cliente_id
LEFT JOIN modulo m ON m.id = sr.modulo_id
LEFT JOIN usuarios coord ON coord.id = sr.coordinador_id
WHERE (p.solicitud_rrhh_public_id IS NULL OR sr.public_id::text = p.solicitud_rrhh_public_id)
  AND (p.perfil IS NULL OR sr.perfil ILIKE '%' || p.perfil || '%')
ORDER BY sr.created_at DESC
LIMIT 20;

-- 2. Despues de mover la vacante a Reclutamiento/Entrevistas.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  sr.public_id AS rrhh_public_id,
  sr.estado,
  sr.observaciones_rrhh,
  sr.perfil,
  sr.updated_at
FROM solicitudes_rrhh sr
CROSS JOIN p
WHERE (p.solicitud_rrhh_public_id IS NULL OR sr.public_id::text = p.solicitud_rrhh_public_id)
  AND (p.perfil IS NULL OR sr.perfil ILIKE '%' || p.perfil || '%')
ORDER BY sr.updated_at DESC
LIMIT 20;

-- 3. Despues de POST /api/solicitudes-rrhh/:public_id/contratar.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  sr.public_id AS rrhh_public_id,
  sr.estado AS rrhh_estado,
  pp.public_id AS preregistro_public_id,
  pp.estado AS preregistro_estado,
  sc.public_id AS contratacion_public_id,
  sc.estado AS contratacion_estado,
  sc.origen_flujo,
  (sc.preregistro_id = pp.id) AS link_preregistro_ok,
  (sc.datos_extra->>'rrhh_solicitud_id' = sr.public_id::text) AS link_rrhh_ok,
  pp.nombre,
  pp.apellidos,
  pp.numero_documento,
  pp.correo_personal,
  pp.moneda,
  pp.tarifa_mes,
  pp.tarifa_hora,
  pp.factura_en_colombia
FROM preregistro_personas pp
JOIN solicitudes_rrhh sr ON sr.id = pp.id_solicitud_rrhh
CROSS JOIN p
LEFT JOIN solicitudes_contratacion sc
  ON sc.preregistro_id = pp.id
  OR sc.datos_extra->>'preregistro_id' = pp.public_id::text
WHERE (p.numero_documento IS NULL OR pp.numero_documento = p.numero_documento)
  AND (p.correo_personal IS NULL OR LOWER(pp.correo_personal) = LOWER(p.correo_personal))
  AND (p.solicitud_rrhh_public_id IS NULL OR sr.public_id::text = p.solicitud_rrhh_public_id)
  AND (p.preregistro_public_id IS NULL OR pp.public_id::text = p.preregistro_public_id)
ORDER BY pp.created_at DESC
LIMIT 20;

-- 4. Despues de que coordinacion completa seccion 2.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  sc.public_id AS contratacion_public_id,
  sc.estado AS contratacion_estado,
  pp.public_id AS preregistro_public_id,
  pp.estado AS preregistro_estado,
  sc.correo_enviado_mesa,
  sc.correo_enviado_th,
  sc.requiere_confirmacion_cliente,
  sc.cliente_id,
  c.titulo AS cliente,
  sc.perfil,
  sc.modalidad_contrato,
  sc.moneda,
  sc.tarifa_mes,
  sc.tarifa_hora,
  sc.fecha_inicio,
  sc.fecha_fin,
  sc.datos_extra,
  pp.fecha_completado_coordinador
FROM solicitudes_contratacion sc
CROSS JOIN p
LEFT JOIN preregistro_personas pp ON pp.id = sc.preregistro_id
LEFT JOIN clientes c ON c.id = sc.cliente_id
WHERE (p.numero_documento IS NULL OR sc.numero_documento = p.numero_documento OR pp.numero_documento = p.numero_documento)
  AND (p.preregistro_public_id IS NULL OR pp.public_id::text = p.preregistro_public_id)
  AND (p.solicitud_contratacion_public_id IS NULL OR sc.public_id::text = p.solicitud_contratacion_public_id)
ORDER BY sc.updated_at DESC
LIMIT 20;

-- 5. Si el cliente requiere confirmacion, despues de POST /contrataciones/solicitudes/:id/enviar-th.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  sc.public_id AS contratacion_public_id,
  sc.estado,
  sc.requiere_confirmacion_cliente,
  sc.correo_enviado_th,
  sc.correo_confirmacion_coordinador,
  sc.updated_at
FROM solicitudes_contratacion sc
CROSS JOIN p
LEFT JOIN preregistro_personas pp ON pp.id = sc.preregistro_id
WHERE (p.numero_documento IS NULL OR sc.numero_documento = p.numero_documento OR pp.numero_documento = p.numero_documento)
  AND (p.solicitud_contratacion_public_id IS NULL OR sc.public_id::text = p.solicitud_contratacion_public_id)
ORDER BY sc.updated_at DESC
LIMIT 20;

-- 6. Anexo tecnico creado/sincronizado desde el proceso.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  ati.public_id AS anexo_item_public_id,
  sc.public_id AS contratacion_public_id,
  pp.public_id AS preregistro_public_id,
  ati.usuario_id,
  ati.nombre_persona,
  ati.numero_documento,
  ati.correo_personal,
  ati.tipo_asignacion,
  ati.estado,
  ati.estado_firma,
  ati.cliente_nombre,
  m.titulo AS modulo,
  ati.moneda,
  ati.valor_tarifa,
  ati.fecha_inicio,
  ati.fecha_fin,
  ati.origen
FROM anexo_tecnico_items ati
CROSS JOIN p
LEFT JOIN solicitudes_contratacion sc ON sc.id = ati.solicitud_contratacion_id
LEFT JOIN preregistro_personas pp ON pp.id = ati.preregistro_id
LEFT JOIN modulo m ON m.id = ati.modulo_id
WHERE (p.numero_documento IS NULL OR ati.numero_documento = p.numero_documento)
  AND (p.correo_personal IS NULL OR LOWER(ati.correo_personal) = LOWER(p.correo_personal))
  AND (p.solicitud_contratacion_public_id IS NULL OR sc.public_id::text = p.solicitud_contratacion_public_id)
  AND (p.preregistro_public_id IS NULL OR pp.public_id::text = p.preregistro_public_id)
ORDER BY ati.created_at DESC
LIMIT 20;

-- 7. Despues de que TH completa seccion 3.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  sc.public_id AS contratacion_public_id,
  sc.estado AS contratacion_estado,
  sc.correo_empresarial,
  sc.datos_extra->>'direccion' AS direccion_sc,
  sc.datos_extra->>'tipo_persona' AS tipo_persona_sc,
  sc.datos_extra->>'banco_id' AS banco_sc,
  sc.datos_extra->>'tipo_cuenta' AS tipo_cuenta_sc,
  sc.datos_extra->>'numero_cuenta' AS numero_cuenta_sc,
  pp.public_id AS preregistro_public_id,
  pp.estado AS preregistro_estado,
  pp.direccion AS direccion_pp,
  pp.tipo_persona AS tipo_persona_pp,
  b.titulo AS banco_pp,
  pp.tipo_cuenta AS tipo_cuenta_pp,
  pp.numero_cuenta AS numero_cuenta_pp,
  pp.correo_silver,
  pp.fecha_completado_th
FROM solicitudes_contratacion sc
CROSS JOIN p
LEFT JOIN preregistro_personas pp ON pp.id = sc.preregistro_id
LEFT JOIN bancos b ON b.id = pp.banco_id
WHERE (p.numero_documento IS NULL OR sc.numero_documento = p.numero_documento OR pp.numero_documento = p.numero_documento)
  AND (p.correo_silver IS NULL OR LOWER(sc.correo_empresarial) = LOWER(p.correo_silver) OR LOWER(pp.correo_silver) = LOWER(p.correo_silver))
  AND (p.solicitud_contratacion_public_id IS NULL OR sc.public_id::text = p.solicitud_contratacion_public_id)
ORDER BY sc.updated_at DESC
LIMIT 20;

-- 8. Despues de aprobar/revision TH: persona y usuario deben quedar vinculados.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  sc.public_id AS contratacion_public_id,
  sc.estado AS contratacion_estado,
  pp.public_id AS preregistro_public_id,
  pp.estado AS preregistro_estado,
  per.public_id AS persona_public_id,
  per.numero_documento,
  per.nombre,
  per.apellidos,
  per.correo_electronico,
  per.preregistro_id,
  u.public_id AS usuario_public_id,
  u.email AS usuario_email,
  u.persona_id,
  (u.persona_id = per.id) AS usuario_persona_ok,
  sc.fecha_revision_th,
  pp.fecha_aprobacion
FROM solicitudes_contratacion sc
CROSS JOIN p
LEFT JOIN preregistro_personas pp ON pp.id = sc.preregistro_id
LEFT JOIN personas per ON per.numero_documento = COALESCE(sc.numero_documento, pp.numero_documento)
LEFT JOIN usuarios u
  ON u.id = COALESCE(sc.persona_usuario_id, pp.id_usuario_creado)
  OR (per.id IS NOT NULL AND u.persona_id = per.id)
  OR LOWER(u.email) = LOWER(COALESCE(sc.correo_empresarial, pp.correo_silver, ''))
WHERE (p.numero_documento IS NULL OR COALESCE(sc.numero_documento, pp.numero_documento, per.numero_documento) = p.numero_documento)
  AND (p.correo_silver IS NULL OR LOWER(COALESCE(sc.correo_empresarial, pp.correo_silver, u.email)) = LOWER(p.correo_silver))
  AND (p.solicitud_contratacion_public_id IS NULL OR sc.public_id::text = p.solicitud_contratacion_public_id)
ORDER BY sc.updated_at DESC
LIMIT 20;

-- 9. Token del portal publico de contratacion/firma.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  tf.public_id AS token_public_id,
  tf.token,
  tf.estado,
  tf.nombre_persona,
  tf.correo_personal,
  sc.public_id AS contratacion_public_id,
  pp.public_id AS preregistro_public_id,
  tf.checks_completados,
  jsonb_array_length(COALESCE(tf.docs_firma, '[]'::jsonb)) AS total_docs_firma,
  tf.expires_at,
  tf.created_at,
  tf.updated_at
FROM tokens_firma_contrato tf
CROSS JOIN p
LEFT JOIN solicitudes_contratacion sc ON sc.id = tf.solicitud_id
LEFT JOIN preregistro_personas pp ON pp.id = tf.preregistro_id
WHERE (p.numero_documento IS NULL OR sc.numero_documento = p.numero_documento OR pp.numero_documento = p.numero_documento)
  AND (p.correo_personal IS NULL OR LOWER(tf.correo_personal) = LOWER(p.correo_personal))
  AND (p.solicitud_contratacion_public_id IS NULL OR sc.public_id::text = p.solicitud_contratacion_public_id)
  AND (p.preregistro_public_id IS NULL OR pp.public_id::text = p.preregistro_public_id)
ORDER BY tf.created_at DESC
LIMIT 20;

-- 10. Datos que deberia traer GET /contratacion/datos-persona.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  tf.token,
  tf.estado AS token_estado,
  sc.public_id AS contratacion_public_id,
  pp.public_id AS preregistro_public_id,
  per.public_id AS persona_public_id,
  u.public_id AS usuario_public_id,
  COALESCE(per.nombre, sc.nombre, pp.nombre) AS nombre_form,
  COALESCE(per.apellidos, sc.apellidos, pp.apellidos) AS apellidos_form,
  COALESCE(per.numero_documento, sc.numero_documento, pp.numero_documento, u.cedula) AS numero_documento_form,
  COALESCE(di_per.public_id::text, di_sc.public_id::text, di_pp.public_id::text, di_u.public_id::text) AS tipo_documento_id_form,
  COALESCE(per.correo_electronico, sc.correo_personal, pp.correo_personal, u.email) AS correo_form,
  COALESCE(per.numero_contacto, sc.telefono, pp.telefono, u.telefono) AS telefono_form,
  COALESCE(per.direccion_residencia, sc.datos_extra->>'direccion', pp.direccion, u.direccion) AS direccion_form,
  COALESCE(per.ciudad_residencia, pp.ciudad, u.ciudad) AS ciudad_form,
  COALESCE(per.pais_residencia, pp.pais_ubicacion) AS pais_form,
  COALESCE(m_per.public_id::text, sc.datos_extra->>'modulo_id') AS modulo_id_form,
  COALESCE(per.modulo_otro, sc.datos_extra->>'modulo_otro', sc.datos_extra->>'modulo', sc.perfil) AS modulo_otro_form,
  per.fecha_nacimiento,
  per.sexo,
  per.estado_civil,
  per.acepta_tratamiento_datos
FROM tokens_firma_contrato tf
CROSS JOIN p
LEFT JOIN solicitudes_contratacion sc ON sc.id = tf.solicitud_id
LEFT JOIN preregistro_personas pp ON pp.id = COALESCE(tf.preregistro_id, sc.preregistro_id)
LEFT JOIN usuarios u
  ON u.id = COALESCE(sc.persona_usuario_id, pp.id_usuario_creado)
  OR LOWER(u.email) = LOWER(COALESCE(sc.correo_empresarial, pp.correo_silver, ''))
LEFT JOIN personas per
  ON per.id = u.persona_id
  OR per.preregistro_id = pp.id
  OR per.numero_documento = COALESCE(sc.numero_documento, pp.numero_documento, u.cedula)
LEFT JOIN documento_identidad di_per ON di_per.id = per.tipo_documento_id
LEFT JOIN documento_identidad di_sc ON di_sc.id = sc.tipo_documento_id
LEFT JOIN documento_identidad di_pp ON di_pp.id = pp.tipo_documento_id
LEFT JOIN documento_identidad di_u ON di_u.id = u.tipo_documento_id
LEFT JOIN modulo m_per ON m_per.id = per.modulo_id
WHERE (p.numero_documento IS NULL OR COALESCE(per.numero_documento, sc.numero_documento, pp.numero_documento, u.cedula) = p.numero_documento)
  AND (p.correo_personal IS NULL OR LOWER(tf.correo_personal) = LOWER(p.correo_personal))
  AND (p.solicitud_contratacion_public_id IS NULL OR sc.public_id::text = p.solicitud_contratacion_public_id)
  AND (p.preregistro_public_id IS NULL OR pp.public_id::text = p.preregistro_public_id)
ORDER BY tf.updated_at DESC
LIMIT 20;

-- 11. Checks de lectura/documentos del token.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  tf.token,
  kv.key AS documento,
  kv.value AS leido,
  tf.estado,
  tf.updated_at
FROM tokens_firma_contrato tf
CROSS JOIN p
CROSS JOIN LATERAL jsonb_each(COALESCE(tf.checks_completados, '{}'::jsonb)) AS kv(key, value)
LEFT JOIN solicitudes_contratacion sc ON sc.id = tf.solicitud_id
LEFT JOIN preregistro_personas pp ON pp.id = tf.preregistro_id
WHERE (p.numero_documento IS NULL OR sc.numero_documento = p.numero_documento OR pp.numero_documento = p.numero_documento)
  AND (p.correo_personal IS NULL OR LOWER(tf.correo_personal) = LOWER(p.correo_personal))
ORDER BY tf.updated_at DESC, kv.key;

-- 12. Documentos enviados a firma desde el portal publico.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  tf.token,
  doc.value->>'doc_index' AS doc_index,
  doc.value->>'estado' AS estado_doc,
  doc.value->>'request_id' AS request_id,
  doc.value->>'contract_id' AS contract_id,
  doc.value->>'url_firma' AS url_firma
FROM tokens_firma_contrato tf
CROSS JOIN p
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tf.docs_firma, '[]'::jsonb)) AS doc(value)
LEFT JOIN solicitudes_contratacion sc ON sc.id = tf.solicitud_id
LEFT JOIN preregistro_personas pp ON pp.id = tf.preregistro_id
WHERE (p.numero_documento IS NULL OR sc.numero_documento = p.numero_documento OR pp.numero_documento = p.numero_documento)
  AND (p.correo_personal IS NULL OR LOWER(tf.correo_personal) = LOWER(p.correo_personal))
ORDER BY tf.updated_at DESC, doc.value->>'doc_index';

-- 13. Datos guardados desde el formulario publico de contratacion.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  per.public_id AS persona_public_id,
  per.numero_documento,
  per.nombre,
  per.apellidos,
  per.fecha_nacimiento,
  per.lugar_nacimiento,
  per.lugar_expedicion,
  per.nacionalidad,
  per.estado_civil,
  per.direccion_residencia,
  per.barrio,
  per.pais_residencia,
  per.hijos,
  per.edades_hijos,
  per.acepta_tratamiento_datos,
  per.tratamiento_datos_aceptado_at,
  per.updated_at
FROM personas per
CROSS JOIN p
WHERE (p.numero_documento IS NULL OR per.numero_documento = p.numero_documento)
  AND (p.correo_personal IS NULL OR LOWER(per.correo_electronico) = LOWER(p.correo_personal))
ORDER BY per.updated_at DESC
LIMIT 20;

-- 14. Firma de anexo individual enviada por TH.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  t.public_id AS token_anexo_public_id,
  t.estado,
  t.correo_firmante,
  t.nombre_persona,
  t.anexo_item_ids,
  t.request_id,
  t.contract_id,
  t.url_firma,
  t.onedrive_url,
  t.firmado_at,
  u.public_id AS usuario_public_id,
  u.email AS usuario_email
FROM tokens_firma_anexo_individual t
CROSS JOIN p
JOIN usuarios u ON u.id = t.usuario_id
LEFT JOIN personas per ON per.id = u.persona_id
WHERE (p.numero_documento IS NULL OR u.cedula = p.numero_documento OR per.numero_documento = p.numero_documento)
  AND (p.correo_silver IS NULL OR LOWER(u.email) = LOWER(p.correo_silver))
ORDER BY t.created_at DESC
LIMIT 20;

-- 15. Conteo rapido por estado.
SELECT 'solicitudes_rrhh' AS tabla, estado, COUNT(*) AS total
FROM solicitudes_rrhh
GROUP BY estado
UNION ALL
SELECT 'preregistro_personas', estado, COUNT(*)
FROM preregistro_personas
GROUP BY estado
UNION ALL
SELECT 'solicitudes_contratacion', estado, COUNT(*)
FROM solicitudes_contratacion
GROUP BY estado
UNION ALL
SELECT 'tokens_firma_contrato', estado, COUNT(*)
FROM tokens_firma_contrato
GROUP BY estado
UNION ALL
SELECT 'tokens_firma_anexo_individual', estado, COUNT(*)
FROM tokens_firma_anexo_individual
GROUP BY estado
ORDER BY tabla, estado;

-- 16. Resumen end-to-end del caso.
WITH p AS (
  SELECT
    NULL::text AS numero_documento,
    NULL::text AS correo_personal,
    NULL::text AS correo_silver,
    NULL::text AS perfil,
    NULL::text AS solicitud_rrhh_public_id,
    NULL::text AS preregistro_public_id,
    NULL::text AS solicitud_contratacion_public_id
)
SELECT
  sr.public_id AS rrhh_public_id,
  sr.estado AS rrhh_estado,
  pp.public_id AS preregistro_public_id,
  pp.estado AS preregistro_estado,
  sc.public_id AS contratacion_public_id,
  sc.estado AS contratacion_estado,
  per.public_id AS persona_public_id,
  u.public_id AS usuario_public_id,
  u.email AS usuario_email,
  (SELECT COUNT(*)
   FROM anexo_tecnico_items ati
   WHERE ati.solicitud_contratacion_id = sc.id
      OR ati.preregistro_id = pp.id
      OR ati.numero_documento = COALESCE(sc.numero_documento, pp.numero_documento)) AS total_anexos,
  (SELECT COUNT(*)
   FROM tokens_firma_contrato tf
   WHERE tf.solicitud_id = sc.id
      OR tf.preregistro_id = pp.id
      OR LOWER(tf.correo_personal) = LOWER(pp.correo_personal)) AS total_tokens_contrato
FROM preregistro_personas pp
JOIN solicitudes_rrhh sr ON sr.id = pp.id_solicitud_rrhh
CROSS JOIN p
LEFT JOIN solicitudes_contratacion sc ON sc.preregistro_id = pp.id
LEFT JOIN personas per ON per.numero_documento = COALESCE(sc.numero_documento, pp.numero_documento)
LEFT JOIN usuarios u ON u.id = COALESCE(sc.persona_usuario_id, pp.id_usuario_creado) OR u.persona_id = per.id
WHERE (p.numero_documento IS NULL OR pp.numero_documento = p.numero_documento OR sc.numero_documento = p.numero_documento)
  AND (p.correo_personal IS NULL OR LOWER(pp.correo_personal) = LOWER(p.correo_personal))
  AND (p.preregistro_public_id IS NULL OR pp.public_id::text = p.preregistro_public_id)
  AND (p.solicitud_contratacion_public_id IS NULL OR sc.public_id::text = p.solicitud_contratacion_public_id)
ORDER BY pp.created_at DESC
LIMIT 20;