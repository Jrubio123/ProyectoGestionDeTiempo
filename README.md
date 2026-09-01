# ProyectoGestionDeTiempo

Sistema web para gestionar consultorias, asignaciones, reporte de horas, cuentas de cobro, aprobaciones, RRHH, contrataciones, personas y firma electronica.

## Estado actual (Abril 2026)

- Frontend de pruebas (`test`) en Azure Static Web Apps.
- Backend de pruebas (`test`) en Render.
- Base de datos de pruebas (`test`) en Supabase PostgreSQL.
- Produccion (`prod`) corre en infraestructura Azure de Silver.
- Login de `test` muestra la etiqueta visible `Entorno test`.
- Backend en proceso de modularizacion por `routes/` + `services/`.

## Stack

- Frontend: HTML, TailwindCSS, Alpine.js y JavaScript vanilla.
- Backend: Node.js 18, Express, JWT, Helmet, CORS y PostgreSQL.
- Base de datos: PostgreSQL 16.
- Integraciones: Microsoft Graph, Entra ID, OneDrive, Click&Sign y Adobe PDF Services.
- Local: Docker Compose con `db`, `back`, `front`, `maildev` y `pgadmin`.

## Ambientes

- `local`
  - Front: `http://localhost:3000`
  - Back: `http://localhost:4000`
  - DB: PostgreSQL en Docker
- `tunnel`
  - Front/back publicados por Dev Tunnels
- `test`
  - Front: `https://lively-sky-00d667a0f.4.azurestaticapps.net/`
  - Back: `https://proyectogestiondetiempo.onrender.com`
  - DB: Supabase
- `prod`
  - Front: Azure Static Web Apps
  - Back: Azure App Service
  - DB: Azure PostgreSQL Flexible Server

## Arquitectura

### Frontend

- SPA principal en `front/index.html`.
- Router por hash en `front/router.js`.
- Vistas por modulo en `front/views/`.
- Scripts por modulo en `front/js/`.
- Configuracion de API en `front/env.js`.
- Flujos publicos de contratacion en `front/contratacion.html`.

### Backend

- Entrada principal: `back/src/index.js`.
- Rutas extraidas en `back/src/routes/`.
- Logica de negocio extraida en `back/src/services/`.
- Middleware de acceso en `back/src/middlewares/access.js`.
- Configuracion central en `back/src/config/env.js`.
- Conexion PostgreSQL en `back/src/db.js`.

Rutas ya modularizadas:

- `auth.routes.js`
- `webhook.routes.js`
- `clientes.routes.js`
- `consultores.routes.js`
- `catalogos.routes.js`
- `usuarios.routes.js`
- `consultorias.routes.js`
- `registro-asignaciones.routes.js`
- `reportes.routes.js`
- `anexo-individual.routes.js`
- `firma-contratos.routes.js`
- `preregistro-routes.js`
- `contrataciones-routes.js`
- `cuentas-cobro.routes.js`
- `health.routes.js`

Servicios principales:

- `auth.service.js`
- `catalogos.service.js`
- `clientes.service.js`
- `consultores.service.js`
- `consultorias.service.js`
- `usuarios.service.js`
- `registro-asignaciones.service.js`
- `reportes.service.js`
- `cuentas-cobro.service.js`
- `firma-contratos.service.js`
- `anexo-individual.service.js`
- `firma-cuenta-timeout.service.js`
- `clicksign.service.js`

## Identidad de datos

El sistema usa doble identificador:

- `id`: entero interno para joins, FKs y rendimiento.
- `public_id`: UUID externo para API y frontend.

Reglas:

- No exponer IDs internos al frontend cuando exista `public_id`.
- Resolver entradas con helpers como `resolveInternalIdFromPublicIdOrId`.
- Normalizar respuestas usando `public_id AS id` o helpers equivalentes.

## Seguridad y acceso

- Login local: `POST /auth/login`.
- SSO Microsoft: `POST /auth/microsoft`.
- Modo `AUTH_MODE=hybrid`: local + Microsoft.
- Modo `AUTH_MODE=ms_only`: solo Microsoft.
- JWT requerido en rutas privadas.
- Autorizacion por rol/tipo con `requireAccess`.

Roles usados:

- `Administrador`
- `Coordinador`
- `Comercial`
- `Talento Humano`
- `Reclutador`
- `Consultor`
- `Consultor Principal`
- `Mesa de Servicio`

Tipo usado en flujos asociados:

- `Asociado`

## Funcionalidad

- Auth local y Microsoft SSO.
- Catalogos: modulos, roles, bancos, monedas, documentos y tipos de cuenta.
- Clientes, consultores, subconsultores y consultorias.
- Usuarios, roles, estado activo y licencias Microsoft.
- Registro de asignaciones.
- Reporte de horas y aprobaciones de coordinador.
- Mesa/fabrica y flujo de aprobacion.
- Cuentas de cobro con PDF, soportes, firma y OneDrive.
- Webhooks Click&Sign.
- RRHH y solicitudes de personal.
- Preregistro y flujo de contratacion.
- Gestion de personas.
- Firma publica de contratos.
- Anexo tecnico individual para Talento Humano.
- Health checks basico y profundo.

## Endpoints principales

### Auth

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/microsoft`
- `GET /auth/me`
- `GET /auth/photo`

### Salud

- `GET /health`
- `GET /health/deep`

### Catalogos

- `GET /modulos`
- `GET /monedas`
- `GET /admin/modulos`
- `POST /admin/modulos`
- `PUT /admin/modulos/:id`
- `DELETE /admin/modulos/:id`
- `GET /admin/roles`
- `POST /admin/roles`
- `PUT /admin/roles/:id`
- `DELETE /admin/roles/:id`
- `GET /admin/bancos`
- `POST /admin/bancos`
- `PUT /admin/bancos/:id`
- `DELETE /admin/bancos/:id`
- `GET /supervisores`
- `GET /tipos-asignacion`
- `GET /bancos`
- `GET /documentos-identidad`
- `GET /admin/tipos-cuenta-bancaria`

### Clientes y consultores

- `GET /clientes`
- `POST /clientes`
- `PUT /clientes/:id`
- `DELETE /clientes/:id`
- `GET /consultores`
- `GET /consultores/principales`
- `GET /sub-consultores/:principalId`
- `GET /sub-consultores/disponibles/:principalId`
- `POST /sub-consultores/asociar`
- `DELETE /sub-consultores/:asociadoId`

### Consultorias y asignaciones

- `GET /consultorias`
- `POST /consultorias`
- `PUT /consultorias/:id`
- `DELETE /consultorias/:id`
- `POST /registro-asignaciones`
- `PUT /registro-asignaciones/:id`
- `DELETE /registro-asignaciones/:id`
- `GET /mis-asignaciones`
- `GET /mis-asignaciones-coordinador`
- `GET /registro-horas-asignaciones`

### Reportes y aprobaciones

- `POST /reportar-horas`
- `GET /aprobaciones/pendientes`
- `PUT /aprobaciones/:id`
- `GET /mesa-fabrica`
- `POST /mesa-fabrica/:id/enviar-aprobacion`
- `PUT /mesa-fabrica/:id`

### Tarifas

- `GET /tarifas`
- `POST /tarifas`
- `PUT /tarifas/:id`
- `DELETE /tarifas/:id`
- `GET /tarifa-consultor`

### Cuentas de cobro

- `POST /cuentas-cobro/preview`
- `POST /cuentas-cobro`
- `GET /cuentas-cobro/historial/:userId`
- `GET /cuentas-cobro/soportes`
- `GET /cuentas-cobro/detalle/:cuentaId`
- `GET /cuentas-cobro/:id/pdf`
- `POST /cuentas-cobro/:id/adjuntos`
- `POST /cuentas-cobro/:id/firma/iniciar`
- `POST /cuentas-cobro/:id/firma/reconciliar`
- `POST /cuentas-cobro/:id/firma/adjuntar`

### Usuarios

- `GET /admin/tenant/usuarios`
- `GET /admin/usuarios-roles`
- `GET /admin/usuarios-licencias`
- `PATCH /admin/usuarios-licencias/:public_id/estado`
- `PUT /admin/usuarios/:id/rol`
- `PUT /admin/usuarios/:id/activo`
- `POST /admin/usuarios/:id/licencia`
- `GET /admin/usuarios/:id/licencias-historial`
- `GET /admin/licencias-disponibles`

### RRHH, preregistro y contrataciones

- `GET /rrhh/solicitudes`
- `POST /rrhh/solicitudes`
- `PUT /rrhh/solicitudes/:id`
- `POST /api/solicitudes-rrhh/:public_id/contratar`
- `GET /api/preregistros`
- `GET /api/preregistros/:public_id`
- `PATCH /api/preregistros/:public_id/seccion-1`
- `PATCH /api/preregistros/:public_id/seccion-2`
- `PATCH /api/preregistros/:public_id/seccion-2/editar`
- `PATCH /api/preregistros/:public_id/seccion-3`
- `PATCH /api/preregistros/:public_id/correo-silver`
- `POST /api/preregistros/:public_id/aprobar`
- `POST /api/preregistros/:public_id/completar`
- `POST /api/preregistros/:public_id/anular`
- `GET /contrataciones/personas`
- `GET /contrataciones/solicitudes`
- `GET /contrataciones/solicitudes/:id`
- `POST /contrataciones/solicitudes`
- `POST /contrataciones/solicitudes/:id/completar`
- `POST /contrataciones/solicitudes/:id/enviar-th`
- `PATCH /contrataciones/solicitudes/:id/devolver-coordinador`
- `PATCH /contrataciones/solicitudes/:id/seccion-3`
- `PATCH /contrataciones/solicitudes/:id/revision-th`

### Personas y Consultores

- `GET /admin/personas`
- `POST /admin/personas`
- `GET /admin/personas/:id`
- `PUT /admin/personas/:id/identidad`
- `PUT /admin/personas/:id/personal`
- `PUT /admin/personas/:id/cobro`
- `PUT /admin/personas/:id/contratacion`
- `PUT /admin/personas/:id/laboral`
- `PUT /admin/personas/:id/operativa`
- `GET /admin/personas-standalone`
- `GET /admin/personas/p/:personaId`
- `PUT /admin/personas/p/:personaId/personal`
- `PUT /admin/personas/p/:personaId/cobro`
- `PUT /admin/personas/p/:personaId/contratacion`
- `PATCH /admin/personas/p/:personaId/estado`
- `GET /admin/consultores`
- `POST /admin/consultores`
- `GET /admin/consultores/existente`
- `PUT /admin/consultores/:id`
- `GET /admin/consultores/:id`

### Firma de contratos

- `GET /admin/firma-contratos`
- `GET /admin/firma-contratos/candidatos`
- `POST /admin/firma-contratos/generar`
- `GET /admin/firma-contratos/anexo-items`
- `POST /admin/firma-contratos/anexo-items`
- `DELETE /admin/firma-contratos/:id`

### Portal publico de contratacion

- `POST /contratacion/validar`
- `GET /contratacion/estado`
- `POST /contratacion/firma/reconciliar`
- `GET /contratacion/docs-info`
- `GET /contratacion/datos-persona`
- `POST /contratacion/datos-persona`
- `GET /contratacion/video`
- `GET /contratacion/pdf/:nombre`
- `PATCH /contratacion/check`
- `GET /contratacion/docs-firma/:doc_index/pdf`
- `POST /contratacion/firmar`

### Anexo individual

- `GET /th/anexo-individual/search`
- `GET /th/anexo-individual/usuarios/:usuarioId/items`
- `GET /th/anexo-individual/items/:itemId`
- `POST /th/anexo-individual/items`
- `PATCH /th/anexo-individual/items/:itemId`
- `PATCH /th/anexo-individual/items/:itemId/finalizar`
- `POST /th/anexo-individual/preview-pdf`
- `POST /th/anexo-individual/iniciar-firma`
- `DELETE /th/anexo-individual/cancelar-firma/:tokenId`

### Webhooks y debug

- `POST /webhooks/clicksign/signature`
- `GET /debug/clicksign`

## Base de datos

Archivos:

- `db/init.sql`: esquema base para instalaciones nuevas.
- `db/migrations/`: cambios incrementales para entornos existentes.
- `db/scripts/`: scripts operativos y post-carga.

Tablas principales:

- `usuarios`, `roles`, `clientes`, `modulo`, `tipo_asignacion`
- `consultorias`, `registro_asignaciones`, `tarifa_consultor`
- `reporte_horas`, `cuenta_cobro`
- `solicitudes_rrhh`, `solicitudes_contratacion`, `preregistro_personas`
- `personas`, `anexo_tecnico_items`
- `vacaciones_solicitudes`, `vacaciones_destinatarios`, `vacaciones_auditoria`
- `tokens_firma_contrato`, `tokens_firma_anexo_individual`
- `permisos_administrador`, `usuario_licencias_backup`

Migraciones recientes relevantes:

- `2026-03-18-anexo-tecnico-items.sql`
- `2026-03-18-firma-contrato-bootstrap.sql`
- `2026-03-24-anexo-individual-th.sql`
- `2026-03-25-anexo-individual-firma-hardening.sql`
- `2026-03-30-tarifa-unique-index.sql`
- `2026-04-01-add-rol-comercial.sql`
- `2026-04-13-factura-en-colombia.sql`
- `2026-04-14-add_personas.sql`
- `2026-04-16-anexo-multi-asignacion.sql`
- `2026-04-16-personas-nucleo.sql`
- `2026-04-21-campos-persona-juridica.sql`
- `2026-04-22-formulario-personas-contratacion.sql`
- `2026-09-01-vacaciones.sql`

Scripts utiles:

- `db/scripts/normalize-tarifas-vencidas-post-load.sql`
- `db/scripts/dedupe-tarifas-activas-post-load.sql`
- `db/scripts/wipe-flujo-contrataciones-rrhh.sql`

## Variables de entorno

Plantillas versionadas:

- `.env.example`
- `.env_tunnels.example`
- `.env_produccion.example`

Variables clave:

- Backend: `NODE_ENV`, `BACK_PORT`, `JWT_SECRET`, `AUTH_MODE`
- DB: `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_HOST`, `DB_PORT`, `DB_SSL`
- Pool DB: `DB_POOL_MAX`, `DB_POOL_MIN`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECTION_TIMEOUT_MS`
- CORS/front: `CORS_ORIGINS`, `FRONT_PORTAL_BASE`
- Microsoft: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_ALLOWED_GROUPS`
- Email: `EMAIL_PROVIDER`, `EMAIL_FALLBACK_SMTP`, `GRAPH_SENDER_USER`, `EMAIL_TO_CONTABILIDAD`
- Vacaciones: `VACACIONES_PUBLIC_API_URL`, `VACACIONES_JEFES_FIJOS`, `VACACIONES_TOKEN_DIAS`
- OneDrive: `ONEDRIVE_ENABLED`, `ONEDRIVE_TARGET_USER`, `ONEDRIVE_ROOT_FOLDER`
- Contratos: `CONTRATOS_BASE_URL`, `CONTRATOS_TOKEN_EXPIRY_HOURS`, `CONTRATOS_ONEDRIVE_FOLDER`
- Click&Sign: `CLICKSIGN_API_BASE`, `CLICKSIGN_API_KEY`, `CLICKSIGN_USER`, `CLICKSIGN_CONFIG_ID`
- Click&Sign contratos: `CLICKSIGN_CONTRATOS_CONFIG_ID`
- Webhooks: `CLICKSIGN_WEBHOOK_TOKEN`, `CLICKSIGN_SIGNATURE_CB_URL`
- Click&Sign anexo técnico: `CLICKSIGN_ANEXO_TECNICO_CONFIG_ID`
- Contratos Capital: `CONTRATOS_CAPITAL_RAZON_SOCIAL`, `CONTRATOS_CAPITAL_REPRESENTANTE_LEGAL`, `CONTRATOS_CAPITAL_CEDULA_REPRESENTANTE`, `CONTRATOS_CAPITAL_NIT`, `CONTRATOS_CAPITAL_CIUDAD`, `CONTRATOS_CAPITAL_DOMICILIO`
- Adobe PDF: `ADOBE_PDF_CLIENT_ID`, `ADOBE_PDF_CLIENT_SECRET`, `ADOBE_PDF_ORGANIZATION_ID`
- Notificaciones: `ANEXO_INDIVIDUAL_NOTIFY_EMAIL`

## Ejecucion local con Docker

Requisitos:

- Docker Desktop.

Pasos:

```powershell
Copy-Item .env.example .env
docker compose up -d
```

Accesos:

- Front: `http://localhost:3000`
- Back: `http://localhost:4000`
- MailDev: `http://localhost:1080`
- pgAdmin: `http://localhost:5050`

## Ejecucion local sin Docker

Backend:

```powershell
cd back
npm install
npm run dev
```

Frontend:

- Servir la carpeta `front/` con Nginx, Live Server o servidor estatico equivalente.
- Para estilos compilados:

```powershell
npm install
npm run build:css
```

## Flujos principales

### Cuenta de cobro firmada

1. Consultor genera cuenta de cobro.
2. Backend genera PDF y soportes.
3. Se inicia firma Click&Sign.
4. Click&Sign llama `POST /webhooks/clicksign/signature`.
5. Backend actualiza estado y adjuntos.
6. PDF firmado se sube a OneDrive cuando esta disponible.
7. Coordinador/Admin ve soportes desde cuentas de cobro.

### Firma publica de contratos

1. Admin o Talento Humano genera token desde `/admin/firma-contratos/generar`.
2. El candidato recibe link de `CONTRATOS_BASE_URL`.
3. El portal publico valida token y muestra documentos.
4. El candidato completa datos, confirma documentos y firma.
5. Backend genera documentos, inicia firma y actualiza estado.
6. Webhook Click&Sign reconcilia documentos firmados.

### Anexo individual

1. Talento Humano busca usuario corporativo.
2. Crea o edita items de anexo tecnico.
3. Puede descargar preview PDF.
4. Inicia firma Click&Sign.
5. Webhook actualiza token, items y archivo firmado.

## Despliegue

Azure App Service:

```powershell
./scripts/set-azure-appsettings.ps1 `
  -ResourceGroup "AppSilver" `
  -AppName "BackApp" `
  -EnvFile ".env_produccion"
```

Dry run:

```powershell
./scripts/set-azure-appsettings.ps1 `
  -ResourceGroup "AppSilver" `
  -AppName "BackApp" `
  -EnvFile ".env_produccion" `
  -DryRun
```

## Politica de secretos

No subir archivos reales:

- `.env`
- `.env_produccion`
- `.env_tunnels`

Usar solo plantillas versionadas y cargar secretos en App Settings o Secrets Manager.

## Checklist antes de merge/deploy

- Ejecutar `node -c` en archivos backend tocados.
- Validar `CORS_ORIGINS` contra el front real.
- Validar `FRONT_PORTAL_BASE` y `CONTRATOS_BASE_URL`.
- Confirmar `AUTH_MODE` por entorno.
- Verificar DB, SSL y pool.
- Probar login Microsoft.
- Probar reportes, aprobaciones y cuentas de cobro.
- Si aplica firma, probar webhook Click&Sign.
- Si aplica contratacion, probar token publico y firma.

## Mantenimiento

- Mantener `db/init.sql` como fuente base para instalaciones nuevas.
- Usar migraciones para evolucionar entornos existentes.
- Mantener consistencia entre enums de DB y backend.
- Mantener rutas nuevas en `routes/` y logica en `services/`.
- Evitar `require("../index")` a nivel top en servicios; usar lazy require si es necesario.
