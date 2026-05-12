# ProyectoGestionDeTiempo — CLAUDE.md

## Stack técnico

- **Backend**: Node.js + Express (`back/src/index.js` + módulos de rutas)
- **Frontend**: HTML + Alpine.js (patrón `window.xxxApp = function()`) + Axios
- **Base de datos**: PostgreSQL con UUIDs como `public_id` (exposición externa) e IDs enteros como clave interna
- **Autenticación**: Azure SSO (Microsoft Identity) + tokens JWT propios
- **Firma digital**: Click & Sign (webhooks en `back/src/index.js`)
- **Email**: Microsoft Graph API (`sendEmailSafe`)
- **Despliegue**: Railway (backend) + GitHub Pages o similar (frontend estático)

## Estructura de archivos

```
back/src/
  index.js                  # App principal: funciones globales, rutas generales, ENUM helpers
  preregistro-routes.js     # Flujo RRHH: solicitudes_rrhh → preregistro_personas
  contrataciones-routes.js  # Flujo directo coord→TH: solicitudes_contratacion
front/
  views/                    # HTML por vista (un archivo = una pantalla)
  js/                       # Alpine.js apps (window.xxxApp por archivo)
db/
  init.sql                  # Schema base completo
  migrations/               # Migraciones incrementales con fecha: YYYY-MM-DD-nombre.sql
```

## Rutas del backend — prefijos

| Prefijo | Archivo | Rol requerido |
|---|---|---|
| `/rrhh/*` | `index.js` | Coordinador / Comercial / Reclutador |
| `/api/solicitudes-rrhh/*` | `preregistro-routes.js` | Reclutador |
| `/api/preregistros/*` | `preregistro-routes.js` | Coordinador / TH |
| `/contrataciones/*` | `contrataciones-routes.js` | Coordinador / Comercial / TH |
| `/th/*` | `index.js` | Talento Humano |

## Modelo de datos clave

### Tablas núcleo
- **`personas`** — entidad madre de datos personales. Toda persona contratada debe tener fila aquí. Campos: `numero_documento` (UNIQUE), `modulo_id`, `modulo_otro` (cuando módulo = "Otros"), `cliente_id`, `cliente_otro`, datos bancarios, seguridad social, etc.
- **`usuarios`** — cuentas de acceso al sistema. Solo consultores y personal interno. Tiene `persona_id FK → personas`. No toda persona es usuario (ej: vinculados externos).
- **`solicitudes_contratacion`** — solicitud unificada para ambos flujos. Campo `origen_flujo`: `'rrhh'` o `'contratacion'`. Estado: `Pendiente Coordinador → Pendiente Revision TH → Pendiente Correo Silver → Completado`.
- **`preregistro_personas`** — registro de onboarding RRHH. Vinculado a `solicitudes_contratacion` vía `preregistro_id`.
- **`anexo_tecnico_items`** — asignaciones activas/históricas de un consultor. Un consultor puede tener múltiples filas (varios clientes, modalidades). Tiene `solicitante_id FK → usuarios` + `rol_solicitante TEXT` para saber quién originó cada asignación.
- **`solicitudes_rrhh`** — vacante creada por coordinador, gestionada por reclutador.

### Campos importantes en `solicitudes_contratacion`
- `tipo_solicitud`: `'Nuevo'` | `'Extension'` | `'Retiro'`
- `datos_extra` (JSONB): almacena sección 2 del coordinador — `modulo_id` (UUID), `modulo_otro`, `banco_id`, `direccion`, `tipo_persona`, `tipo_cuenta`, `numero_cuenta`, `factura_en_colombia`
- `coordinador_solicitante_id FK → usuarios`
- `persona_usuario_id FK → usuarios` — se llena cuando se crea el usuario al aprobar

## Flujos de contratación

### Flujo RRHH (nuevo consultor vía reclutamiento)
1. Coordinador crea vacante → `POST /rrhh/solicitudes` → tabla `solicitudes_rrhh`
2. Reclutador gestiona estados. Al marcar "Contratado" → `POST /api/solicitudes-rrhh/:id/contratar` → crea `preregistro_personas` + borrador en `solicitudes_contratacion` (`origen_flujo='rrhh'`)
3. Coordinador llena sección 2 → `POST /contrataciones/solicitudes/:id/completar` → estado `Pendiente Revision TH`
4. TH llena sección 3 → `PATCH /contrataciones/solicitudes/:id/seccion-3` (o `/api/preregistros/:id/seccion-3`)
5. TH aprueba → `POST /api/preregistros/:id/aprobar` → **UPSERT `personas`** → INSERT `usuarios` con `persona_id` → estado `Completado`

### Flujo directo (extensión / persona existente)
1. Coordinador selecciona persona existente → `POST /contrataciones/solicitudes` (tipo `Extension`)
2. Envío a TH → `POST /contrataciones/solicitudes/:id/enviar-th`
3. TH revisa → `PATCH /contrataciones/solicitudes/:id/revision-th` → **UPSERT `personas`** → si nuevo usuario: INSERT `usuarios` con `persona_id`; si usuario ya existe: UPDATE `persona_id` si es null

### Regla crítica: `personas` + `usuarios`
- **Siempre** al aprobar TH: UPSERT en `personas` (`ON CONFLICT (numero_documento) DO UPDATE`)
- **Solo si no es módulo "Otros"** o si es un consultor: también INSERT/vincular en `usuarios`
- `usuarios.persona_id` debe quedar vinculado después de cualquier aprobación TH

## Convenciones de código

### Backend
- Siempre usar `client` (transacción) dentro de `BEGIN/COMMIT/ROLLBACK`; usar `pool` solo para lecturas sin transacción
- IDs externos siempre son `public_id` (UUID); IDs internos son enteros
- Helpers de normalización: `normalizeMoneda()`, `normalizeTipoPersonaForUsuarios()`, `normalizeModalidad()`, `toNullableString()`, `toNullableInteger()`
- `isUuid(str)` para validar UUIDs antes de usarlos como FK
- Errores de unicidad: `err?.code === '23505'` → HTTP 409
- Roles en `requireAccess({ roles: [...] })` usan los títulos exactos de la tabla `roles`

### Frontend (Alpine.js)
- Cada vista tiene su propio archivo JS: `window.xxxApp = function() { return { ... } }`
- Axios con `this.getAuthConfig()` para headers de auth
- `API_BASE` viene de `window.API_BASE`
- Los `public_id` (UUIDs) son los IDs que viajan entre front y back
- Patrón de modal: `modalOpen`, `modalMode` ('crear'|'editar'|'ver'), `form` objeto plano

### Migraciones
- Nombre: `YYYY-MM-DD-descripcion.sql`
- Siempre dentro de `BEGIN; ... COMMIT;`
- Usar `ADD COLUMN IF NOT EXISTS` y `CREATE INDEX IF NOT EXISTS`
- Backfill de datos existentes dentro de la misma migración cuando aplique

## Módulos del catálogo
- Tabla `modulo`: tiene un registro con `titulo = 'Otros'`
- Cuando el coordinador selecciona "Otros" → el campo libre `form.perfil` se guarda como `datos_extra.modulo_otro`
- En `personas.modulo_otro` se almacena el cargo/perfil libre cuando no aplica módulo del catálogo

## `anexo_tecnico_items` — asignaciones de consultores
- Generado automáticamente por `ensurePersistedAnexoFromProceso()` al completar solicitudes
- Campos de trazabilidad: `solicitante_id FK → usuarios`, `rol_solicitante TEXT`
- Usado para generar PDF del anexo técnico a firmar (Click & Sign)
- Un consultor puede tener múltiples items (varios clientes/modalidades)
- `tipo_asignacion`: `full_time` | `medio_tiempo` | `horas` | `capacitacion` | `proyecto`

## Notas importantes
- No inventar URLs ni endpoints — verificar siempre en `preregistro-routes.js`, `contrataciones-routes.js` o `index.js`
- Los estados de `solicitudes_contratacion` son constantes en `ESTADOS` al inicio de `contrataciones-routes.js`
- `syncSolicitudYAnexoDesdePreregistro` y `syncLinkedPreregistroFromSolicitud` mantienen sincronía bidireccional entre `preregistro_personas` y `solicitudes_contratacion`
- `correo_empresarial` = correo Silver (`@silverconsulting.com.co`) — es el email que se usa para crear el usuario en `usuarios.email`
- Área Comercial también puede crear solicitudes de contratación (no solo Coordinadores)

## REGLA DE CODEX (obligatoria)

Siempre que el usuario te pida ejecutar un "LOTE", usar el comando `/codex`, o delegar una tarea de código, DEBES invocar el skill de Codex usando OBLIGATORIAMENTE el modelo avanzado y la máxima capacidad de razonamiento. Inyecta siempre de forma automática estos parámetros en tu invocación:

```
--model gpt-5.4 -c model_reasoning_effort=xhigh -c model_reasoning_summary=detailed
```

Aplica a: `/codex`, `/codex:rescue`, cualquier "LOTE", y cualquier delegación de código a Codex (análisis, refactor, diagnóstico, revisión, edición automática). No degradar el modelo ni el esfuerzo de razonamiento aunque la tarea parezca pequeña, salvo que el usuario lo pida explícitamente en ese turno.
