CREATE TABLE IF NOT EXISTS usuario_licencias_backup (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_group_id UUID NOT NULL DEFAULT gen_random_uuid(),
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  usuario_public_id UUID NOT NULL,
  azure_oid VARCHAR(64),
  email VARCHAR(255),
  sku_id VARCHAR(64) NOT NULL,
  sku_part_number VARCHAR(255),
  fecha_desactivacion TIMESTAMP NOT NULL DEFAULT NOW(),
  desactivado_por_usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
  desactivado_por_email VARCHAR(255),
  restaurado BOOLEAN NOT NULL DEFAULT FALSE,
  fecha_restauracion TIMESTAMP NULL,
  restaurado_por_usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
  restaurado_por_email VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_usuario_licencias_backup_usuario
  ON usuario_licencias_backup(usuario_id);

CREATE INDEX IF NOT EXISTS idx_usuario_licencias_backup_restaurado
  ON usuario_licencias_backup(restaurado);

CREATE INDEX IF NOT EXISTS idx_usuario_licencias_backup_group
  ON usuario_licencias_backup(backup_group_id);

CREATE INDEX IF NOT EXISTS idx_usuario_licencias_backup_fecha
  ON usuario_licencias_backup(fecha_desactivacion DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_usuario_licencias_backup_group_sku
  ON usuario_licencias_backup(backup_group_id, sku_id);
