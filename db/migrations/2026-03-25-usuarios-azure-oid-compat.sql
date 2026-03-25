BEGIN;

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS azure_oid VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_azure_oid
  ON usuarios(azure_oid)
  WHERE azure_oid IS NOT NULL;

COMMIT;
