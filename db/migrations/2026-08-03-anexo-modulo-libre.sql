BEGIN;

ALTER TABLE anexo_tecnico_items
  ADD COLUMN IF NOT EXISTS modulo_nombre VARCHAR(200);

COMMENT ON COLUMN anexo_tecnico_items.modulo_nombre
  IS 'Nombre libre del modulo cuando no existe en el catalogo';

UPDATE anexo_tecnico_items ati
SET modulo_nombre = COALESCE(
  NULLIF(BTRIM(sc.datos_extra->>'modulo_nombre'), ''),
  NULLIF(BTRIM(sc.datos_extra->>'modulo_otro'), ''),
  NULLIF(BTRIM(sc.datos_extra->>'modulo'), ''),
  NULLIF(BTRIM(sc.perfil), '')
)
FROM solicitudes_contratacion sc
WHERE sc.id = ati.solicitud_contratacion_id
  AND ati.modulo_id IS NULL
  AND NULLIF(BTRIM(COALESCE(ati.modulo_nombre, '')), '') IS NULL
  AND COALESCE(
    NULLIF(BTRIM(sc.datos_extra->>'modulo_nombre'), ''),
    NULLIF(BTRIM(sc.datos_extra->>'modulo_otro'), ''),
    NULLIF(BTRIM(sc.datos_extra->>'modulo'), ''),
    NULLIF(BTRIM(sc.perfil), '')
  ) IS NOT NULL;

UPDATE anexo_tecnico_items ati
SET modulo_nombre = NULLIF(BTRIM(p.modulo_otro), '')
FROM personas p
LEFT JOIN usuarios u ON u.persona_id = p.id
WHERE ati.modulo_id IS NULL
  AND NULLIF(BTRIM(COALESCE(ati.modulo_nombre, '')), '') IS NULL
  AND NULLIF(BTRIM(COALESCE(p.modulo_otro, '')), '') IS NOT NULL
  AND (
    (ati.usuario_id IS NOT NULL AND u.id = ati.usuario_id)
    OR (
      ati.numero_documento IS NOT NULL
      AND BTRIM(ati.numero_documento) <> ''
      AND BTRIM(p.numero_documento) = BTRIM(ati.numero_documento)
    )
  );

COMMIT;
