BEGIN;

-- Las cuentas firmadas sin seguridad social agotaron los reintentos del job de
-- revalidación mientras el resolver verificado retornaba extraFiles vacío (bug).
-- Se resetean los intentos para que el job corregido las reprocese.
-- Acotado a cuentas creadas desde el 2026-06-01: ventana del daño reportado.
-- Las anteriores se rescatan manualmente (carga manual o buscar en Click&Sign),
-- que también disparan la notificación tardía a proveedores.
UPDATE cuenta_cobro
SET datos_adjuntos = jsonb_set(
  COALESCE(datos_adjuntos, '{}'::jsonb),
  '{revalidacion_soportes,intentos}',
  '0'::jsonb,
  true
)
WHERE COALESCE(datos_adjuntos->'soportes'->'seguridad_social'->>'url', '') = ''
  AND COALESCE(datos_adjuntos->'firma'->'documento_firmado'->>'url', '') <> ''
  AND created_at >= DATE '2026-06-01';

COMMIT;
