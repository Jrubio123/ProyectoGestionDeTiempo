BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO roles (titulo, descripcion, activo)
SELECT 'Reclutador', 'Usuario encargado de reclutar y gestionar candidatos y consultores', true
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE LOWER(titulo) = LOWER('Reclutador')
);

INSERT INTO roles (titulo, descripcion, activo)
SELECT 'Talento Humano', 'Usuario de Talento Humano para onboarding y aprobacion de preregistros', true
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE LOWER(titulo) = LOWER('Talento Humano')
);

WITH roles_map AS (
  SELECT LOWER(titulo) AS rol_key, id
  FROM roles
  WHERE LOWER(titulo) IN ('reclutador', 'coordinador', 'talento humano')
)
INSERT INTO usuarios (
  nombre_usuario,
  email,
  password_hash,
  rol_usuario_id,
  activo,
  created_by
)
SELECT
  data.nombre_usuario,
  data.email,
  crypt(data.password_plain, gen_salt('bf', 10)),
  rm.id,
  true,
  'seed_local_users'
FROM (
  VALUES
    ('Reclutador Local', 'reclutador.local@silver.test', 'Reclu2026!', 'reclutador'),
    ('Coordinador Local', 'coordinador.local@silver.test', 'Coord2026!', 'coordinador'),
    ('Talento Humano Local', 'talentohumano.local@silver.test', 'TH2026!', 'talento humano')
) AS data(nombre_usuario, email, password_plain, rol_key)
JOIN roles_map rm ON rm.rol_key = data.rol_key
ON CONFLICT (email) DO UPDATE
SET
  nombre_usuario = EXCLUDED.nombre_usuario,
  password_hash = EXCLUDED.password_hash,
  rol_usuario_id = EXCLUDED.rol_usuario_id,
  activo = true,
  updated_at = CURRENT_TIMESTAMP;

COMMIT;
