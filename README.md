# ProyectoGestionDeTiempo

Sistema web para gestionar consultorias, asignaciones, reporte de horas, cuentas de cobro, aprobaciones de coordinacion, solicitudes de RRHH y firma electronica.

## Estado actual (Febrero 2026)
- Frontend principal de pruebas (`test`) en Azure Static Web Apps.
- Backend de pruebas (`test`) en Render.
- Base de datos de pruebas (`test`) en Supabase (PostgreSQL).
- Produccion (`prod`) corre en infraestructura Azure de Silver (front/back/db), con repositorio de despliegue separado.
- En login de `test` se muestra etiqueta visible: `Entorno test`.

## Ambientes
- `local`:
  - Front: `http://localhost:3000`
  - Back: `http://localhost:4000`
  - DB: PostgreSQL en Docker (`db`).
- `tunnel`:
  - Front y back por URLs publicas de Dev Tunnels.
- `test`:
  - Front: `https://zealous-mud-057b4ca0f.1.azurestaticapps.net/`
  - Back: `https://proyectogestiondetiempo.onrender.com`
  - DB: Supabase
- `prod`:
  - Front/Back/DB en Azure (entorno productivo Silver).

## Arquitectura tecnica
- Frontend:
  - HTML + JS vanilla + Alpine.js + Tailwind CDN.
  - SPA con `index.html` + hash routes.
  - Config dinamica en `front/env.js` (`APP_MODE` y `API_BASE`).
- Backend:
  - Node.js + Express (`back/src/index.js`).
  - Seguridad HTTP con `helmet`, CORS configurable y JWT.
  - Integraciones: Microsoft Graph (auth/correo/avatar), OneDrive, Click&Sign.
- Base de datos:
  - PostgreSQL 16.
  - Script inicial completo en `db/init.sql`.
  - Migraciones puntuales en `db/migrations/`.
- Contenedores:
  - `docker-compose.yml` levanta `db`, `back`, `front`, `maildev`, `pgadmin`.

## Modelo de identidad de datos (doble ID)
El sistema usa dos identificadores por registro en casi todas las tablas:
- `id`:
  - `SERIAL` entero.
  - Uso interno en DB, joins, FKs y operaciones de alto rendimiento.
- `public_id`:
  - `UUID` (`gen_random_uuid()`), `UNIQUE`.
  - Uso externo en API/cliente para no exponer IDs secuenciales.

Ventajas:
- Seguridad:
  - Reduce enumeracion de recursos por ID incremental.
  - Evita exponer claves internas en frontend.
- Rendimiento:
  - Las relaciones y consultas internas siguen sobre enteros (`id`), mas eficientes para joins e indices.
- Compatibilidad:
  - Se mantiene modelo relacional tradicional y se agrega una capa segura para intercambio externo.

Implementacion backend:
- Entrada:
  - Endpoints aceptan `public_id` o `id` segun caso y resuelven a ID interno con `resolveInternalId(...)`.
- Salida:
  - Respuestas normalizadas con `withPublicId(...)` para exponer `public_id`.
- Error:
  - Si no existe recurso, se usa `PUBLIC_ID_NOT_FOUND`.

## Seguridad y acceso
- Autenticacion:
  - Local (`/auth/login`) para desarrollo.
  - Microsoft Entra ID (`/auth/microsoft`) para SSO.
- Modo de autenticacion por entorno:
  - `AUTH_MODE=hybrid`: local + Microsoft.
  - `AUTH_MODE=ms_only`: solo Microsoft.
- Autorizacion:
  - Middleware por rol/tipo (`requireAccess`).
  - Roles usados: `Administrador`, `Coordinador`, `Consultor`, `Consultor Principal`, `Mesa de Servicio`, `Reclutador`.
  - Tipo usado en flujos de consultor: `Asociado`.
- DB y seguridad:
  - RLS habilitado en tablas sensibles (`usuarios`, `reporte_horas`, `cuenta_cobro`).
  - CORS con `CORS_ORIGINS`.
  - JWT requerido en rutas privadas.

## Funcionalidad implementada
- Catalogos y maestros:
  - Clientes, modulos, tipos de asignacion, tarifas, consultores, coordinadores.
- Gestion de consultorias y asignaciones:
  - CRUD de consultorias.
  - Asignacion de consultores.
  - Asociacion de subconsultores.
- Registro de horas:
  - Registro y actualizacion de reportes.
  - Flujo mesa/fabrica con estados de mesa y fabrica.
- Cuentas de cobro:
  - Previsualizacion.
  - Generacion.
  - Historial por consultor.
  - Soportes y adjuntos.
  - Generacion de PDF.
- Aprobaciones:
  - Pendientes de coordinador.
  - Aprobacion/rechazo con notificaciones.
- RRHH:
  - Solicitudes de personal (coordinador/reclutador/admin).
  - Actualizacion de estado con notificaciones.
- Firma electronica:
  - Inicio de firma en Click&Sign.
  - Recepcion de webhook y actualizacion de estado.
- Salud de servicio:
  - Endpoint `/health`.

## Base de datos (resumen)
- Tipos enum principales:
  - `tipo_aprobacion`
  - `tipo_estado_asignacion`
  - `tipo_servicio`
  - `tipo_estado_reporte` (incluye `En_Firma`)
  - `tipo_estado_mesa` (incluye `Transferido Silver`, `Transferido Corona`)
  - `tipo_estado_fabrica`
  - `tipo_persona`
  - `tipo_moneda`
  - `tipo_consultor_enum`
- Tablas principales:
  - `usuarios`, `roles`, `clientes`, `modulo`, `tipo_asignacion`
  - `consultorias`, `registro_asignaciones`, `tarifa_consultor`
  - `reporte_horas`, `cuenta_cobro`
  - `solicitudes_rrhh`, `asignaciones_consultoria_mesa_fabrica`
  - `permisos_administrador`
- Vistas:
  - `v_asignaciones_activas`
  - `v_reportes_pendientes`
  - `v_consultores_activos`
  - `v_facturacion_por_cliente`
  - `v_tarifas_vigentes`
- Funciones:
  - `obtener_tarifa_consultor(...)`
  - `numero_a_letras(...)`

## Migraciones y esquema
- `db/init.sql`:
  - Fuente principal para inicializar base nueva desde cero.
- `db/migrations/2026-02-24-add-public-id.sql`:
  - Evolucion para incorporar `public_id` en tablas existentes.
- `db/migrations/20260219_estado_mesa_fabrica.sql`:
  - Agrega valores a `tipo_estado_mesa` si no existen.
- `db/migrations/2026-03-17-usuario-licencias-backup.sql`:
  - Crea `usuario_licencias_backup` para guardar/restaurar snapshots de licencias de Entra ID.
- Nota:
  - El cambio de `En_Firma` ya quedo integrado en `init.sql`; no se necesita migracion separada para instalaciones nuevas.

## Variables de entorno
Plantillas versionadas:
- `.env.example` (local/dev)
- `.env_tunnels.example` (dev tunnels)
- `.env_produccion.example` (produccion)

Variables clave:
- Backend:
  - `NODE_ENV`, `BACK_PORT`, `JWT_SECRET`, `AUTH_MODE`
- DB:
  - `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_HOST`, `DB_PORT`
  - `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED`
  - `DB_POOL_MAX`, `DB_POOL_MIN`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECTION_TIMEOUT_MS`
- Front/CORS:
  - `CORS_ORIGINS`, `FRONT_PORTAL_BASE`
- Azure/SSO:
  - `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_ALLOWED_GROUPS`
- Email:
  - `EMAIL_PROVIDER`, `EMAIL_FALLBACK_SMTP`, `GRAPH_SENDER_USER`
- OneDrive:
  - `ONEDRIVE_ENABLED`, `ONEDRIVE_TARGET_USER`, `ONEDRIVE_ROOT_FOLDER`
- Click&Sign:
  - `CLICKSIGN_API_BASE`, `CLICKSIGN_API_KEY`, `CLICKSIGN_USER`, `CLICKSIGN_CONFIG_ID`
  - `CLICKSIGN_WEBHOOK_TOKEN`, `CLICKSIGN_SIGNATURE_CB_URL`
  - `CLICKSIGN_SIGNED_FILE_URL_TEMPLATE` (opcional, para descarga directa del PDF firmado)

## Frontend: seleccion de API por entorno
La resolucion se hace en `front/env.js`:
- `local` usa localhost.
- `tunnel` usa URL publica de tunel.
- `test` detecta host `zealous-mud-057b4ca0f.1.azurestaticapps.net` y usa Render.
- `prod` usa URL de backend productiva configurada.

Comportamiento especial en `test`:
- Si habia `APP_API_BASE` viejo en `localStorage`, se reemplaza por la URL de Render para evitar apuntar a back incorrecto.
- En login se muestra badge `Entorno test`.

## Estructura del proyecto
- `back/`
  - API Express, auth, integraciones, logica de negocio.
- `front/`
  - Vistas, scripts JS por modulo, componentes y router.
- `db/`
  - `init.sql` + migraciones.
- `scripts/`
  - Utilidades operativas (ej. carga masiva de app settings en Azure).
- `docker-compose.yml`
  - Orquestacion local.

## Ejecucion local con Docker
Requisitos:
- Docker Desktop.

Pasos:
1. Crear archivo `.env` a partir de `.env.example`.
2. Levantar stack:
   ```powershell
   docker compose up -d
   ```
3. Accesos:
   - Front: `http://localhost:3000`
   - Back: `http://localhost:4000`
   - MailDev: `http://localhost:1080`
   - pgAdmin: `http://localhost:5050`

## Endpoints principales (referencia)
- Auth:
  - `POST /auth/register`
  - `POST /auth/login`
  - `POST /auth/microsoft`
  - `GET /auth/me`
  - `GET /auth/photo`
- Core:
  - `GET /health`
  - CRUD de `clientes`, `consultorias`, `tarifas`
  - `GET /consultores`, `GET /coordinadores`
  - `GET /tipos-asignacion`, `GET /modulos`
  - `PUT /admin/usuarios/:id/activo` (con `liberar_licencias` o `restaurar_licencias`)
  - `POST /admin/usuarios/:id/licencia`
  - `GET /admin/usuarios/:id/licencias-historial`
- Asignaciones y horas:
  - `GET/POST/PUT /registro-asignaciones...`
  - `GET /mis-asignaciones...`
  - `POST /reportar-horas`
  - `GET/PUT/POST /mesa-fabrica...`
- Cuentas de cobro:
  - `POST /cuentas-cobro/preview`
  - `POST /cuentas-cobro`
  - `GET /cuentas-cobro/historial/:userId`
  - `GET /cuentas-cobro/detalle/:cuentaId`
  - `POST /cuentas-cobro/:id/adjuntos`
  - `GET /cuentas-cobro/:id/pdf`
  - `POST /cuentas-cobro/:id/firma/iniciar`
- Firma:
  - `POST /webhooks/clicksign/signature`
- Aprobaciones:
  - `GET /aprobaciones/pendientes`
  - `PUT /aprobaciones/:id`
- RRHH:
  - `GET/POST/PUT /rrhh/solicitudes...`

## Flujo de firma automatica (end-to-end)
1. Consultor genera cuenta desde `Generar y Firmar`.
2. Backend crea la cuenta (`/cuentas-cobro`) y luego inicia firma (`/cuentas-cobro/:id/firma/iniciar`).
3. Click&Sign entrega `url_firma`; frontend abre modal y pestaña de firma.
4. Al firmar/rechazar, Click&Sign llama webhook (`/webhooks/clicksign/signature?token=...`).
5. Backend actualiza estado de la cuenta:
   - `signed` -> `Aprobado`
   - `rejected` -> `Rechazado`
   - `pending` -> `En_Firma` (si existe en enum)
6. Si llega `signed`, backend intenta resolver el PDF firmado:
   - primero desde payload del webhook,
   - luego desde URL template opcional (`CLICKSIGN_SIGNED_FILE_URL_TEMPLATE`),
   - luego con consultas de fallback a API Click&Sign.
7. Si obtiene PDF valido, backend lo sube automaticamente a OneDrive y guarda metadata en:
   - `datos_adjuntos.firma.documento_firmado`
   - `datos_adjuntos.soportes.cuenta_cobro`
8. Coordinador/Administrador lo ve en `Soportes de Cuentas de Cobro` y lo puede abrir/descargar.
9. Consultor lo ve en `Historial de Cobros` como estado firmado y con accion para abrir cuenta firmada.

## Operacion y despliegue
- Azure App Service:
  - Script para cargar settings desde archivo env:
    - `scripts/set-azure-appsettings.ps1`
- Ejemplo:
  ```powershell
  ./scripts/set-azure-appsettings.ps1 `
    -ResourceGroup "AppSilver" `
    -AppName "BackApp" `
    -EnvFile ".env_produccion"
  ```
- Dry run:
  ```powershell
  ./scripts/set-azure-appsettings.ps1 `
    -ResourceGroup "AppSilver" `
    -AppName "BackApp" `
    -EnvFile ".env_produccion" `
    -DryRun
  ```

## Politica de secretos
- No subir archivos reales:
  - `.env`
  - `.env_produccion`
  - `.env_tunnels`
- Usar solo plantillas versionadas.
- Cargar secretos en el proveedor de hosting (App Settings/Secrets Manager), no en Git.
- Rotar secretos si alguna vez quedaron expuestos en historial.

## Checklist rapido antes de merge/deploy
- Validar `CORS_ORIGINS` contra URL real del front.
- Validar `FRONT_PORTAL_BASE`.
- Validar `AUTH_MODE` correcto por entorno.
- Verificar conectividad DB y SSL (`DB_SSL`).
- Probar login, carga de datos, flujo de reporte, cuenta de cobro y aprobacion.
- Si aplica firma, probar callback/webhook de Click&Sign.

## Notas de mantenimiento
- `init.sql` debe reflejar el estado base completo para instalaciones nuevas.
- Migraciones solo para evolucionar entornos ya existentes.
- Mantener consistencia de enums entre backend y DB.
