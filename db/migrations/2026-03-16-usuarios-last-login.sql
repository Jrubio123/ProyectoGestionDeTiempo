ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS ultimo_inicio_sesion TIMESTAMP;
