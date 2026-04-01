-- Agrega vpn_corona y necesita_s_user a solicitudes_contratacion
-- para que el formulario unificado (coord/comercial) almacene estos campos
-- y luego se sincronicen al preregistro_personas correspondiente.

ALTER TABLE solicitudes_contratacion
  ADD COLUMN IF NOT EXISTS vpn_corona        BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS necesita_s_user   BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS grupo_usuario_otro VARCHAR(150) DEFAULT NULL;
