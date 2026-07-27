# Incidente: cuentas de cobro aprobadas y notificadas a Proveedores sin firma real

- **Fecha de detección:** 2026-07-03 (reporte operativo: cuenta de Luis Figala llegó a Proveedores sin firmar)
- **Estado:** FIX IMPLEMENTADO Y VALIDADO — pendiente de configuración y despliegue en producción
- **Severidad:** Alta — documentos inválidos enviados a un tercero (Proveedores) como si estuvieran firmados
- **Componentes:** reconciliación de firmas Click&Sign de `cuenta_cobro` (backend)

## Resumen

Desde el 2026-06-09, la reconciliación automática de firmas de cuentas de cobro puede tomar el
**PDF original sin firmar** que se envió a Click&Sign, clasificarlo como documento firmado,
subirlo a OneDrive como `CuentaCobroFirmada`, pasar la cuenta a estado `Aprobado` y notificar
a Proveedores con ese documento inválido — todo sin que el consultor haya firmado.

## Causa raíz

Introducida en el commit `76017d5` (2026-06-09, "Se soluciona el tema de cuentas en el aire…").
Cadena de fallas (referencias sobre `back/src/index.js` en el estado actual de `main`):

1. `resolveCuentaFirmaFirmadaAcrossAttempts` (~línea 6436) invoca `resolveClickSignArtifacts`
   con `allowCatalogFallback: true` **fijo** (~6475), sin importar el estado de la firma.
2. El fallback de catálogo (~6299-6312) toma el **primer archivo no-secundario** de la lista;
   `isClickSignSecondaryFileEntry` (~6130) no excluye el PDF original (nombre
   `CuentaCobro_<uuid>.pdf` no matchea su regex).
3. La sola existencia de un buffer PDF fuerza `signed: true` (~6480-6491), sin verificar el
   estado real de la firma.
4. Agravantes del parser de estado:
   - `fetchClickSignSignatureSnapshot` (~6858) devuelve `signed` si la respuesta trae cualquier
     `file_url`/`document_url`/base64, aunque sea el original.
   - `normalizeClickSignStatus` (~6688) mapea `"success"` a `signed`; el `status: "Success"`
     HTTP de Click&Sign puede confundirse con estado de firma.
5. La notificación a Proveedores (`notifyCuentaCobroFirmadaToProveedores`, ~1038) solo exige que
   exista `documento_firmado.url`; no valida procedencia ni contenido.

## Vectores de disparo

- Job `jobReconciliarCuentasEnFirma` (cada 10 min; cuentas `En Firma` con >20 min sin actualizar).
- Auto-reconciliación del frontend al cargar la vista (`front/js/mis-cuentas-cobros.js`,
  `reconciliarFirmasPendientes` → `POST /cuentas-cobro/:id/firma/reconciliar`) — sin espera mínima.
- Endpoint manual `POST /cuentas-cobro/:id/firma/reconciliar`.
- Reintento diferido del webhook (`reintentarCuentaCobroFirma`, 30 s).

## Casos identificados

| Caso | `cuenta_cobro.public_id` | Tipo | Estado operativo |
|---|---|---|---|
| Luis Figala | `7e72d0ce-7a2b-471c-862b-3642572017f9` | Falso positivo (periodo 2026-06-01 a 2026-06-30) | Revertido manualmente por SQL el 2026-07-03: estado `Pendiente`, `firma`/`soportes` retirados, intento archivado en `firma_reseteos[0]` (falta marcar `no_reconciliar`). Respaldo de `datos_adjuntos` guardado por el operador. Nota: el reset retiró `soportes` completo; si existía mapeo de seguridad social, recuperar del respaldo. Carpeta OneDrive eliminada por el operador. Solicitud vieja cancelada en Click&Sign por el operador. |
| Marisol | `dcbf8016-3ff4-4a99-9390-8f74d7c1c810` | Falso positivo | Pendiente. NO resetear en BD todavía. En OneDrive: borrar únicamente el PDF de cuenta mal clasificado; conservar seguridad social y su mapeo. |
| Jovanny Castro | `0235a33f-9e0a-446c-b364-217dc7498460` | Firma legítima, documento sospechoso | `raw=signed` (firmó de verdad) pero `documento_firmado.origen = get_file_catalog_fallback` y el nombre corresponde al PDF original → OneDrive/Proveedores probablemente recibieron el original SIN firma pese a que la firma existe en Click&Sign. Verificar visualmente y re-obtener el firmado real tras el fix. |

Barrido para detectar más víctimas (cuentas cerradas por firma desde 2026-06-09):

```sql
SELECT cc.public_id, u.nombre_usuario, cc.estado, cc.updated_at,
       cc.datos_adjuntos->'firma'->'documento_firmado'->>'nombre'  AS nombre_pdf,
       cc.datos_adjuntos->'firma'->'documento_firmado'->>'origen'  AS origen,
       cc.datos_adjuntos->'firma'->'diagnostico'->>'catalogSource' AS catalog_source
FROM cuenta_cobro cc
JOIN usuarios u ON u.id = cc.created_by
WHERE cc.datos_adjuntos->'firma'->'documento_firmado'->>'url' IS NOT NULL
  AND cc.updated_at >= '2026-06-09'
ORDER BY cc.updated_at DESC;
```

## Hallazgos del barrido en BD (2026-07-03, solo lectura)

18 cuentas cerradas por firma desde 2026-06-09; **todas** con notificación a Proveedores enviada
(`notificacion_proveedores.enviada = true`). Clasificación por procedencia del documento:

| Categoría | Cuentas | Lectura |
|---|---|---|
| `origen = get_file_signed_contract`, `raw = signed` | 13 | Camino normal: la entrada firmada del catálogo SÍ existe en firmas legítimas. Probablemente correctas (muestrear 1-2 para confirmar). Valida que el gate estricto por grupo firmado no atascará el flujo normal. |
| `raw = ready` + `origen = get_file_catalog_fallback` | 2 (Luis — archivado, Marisol) | **Falsos positivos confirmados por datos**: Click&Sign reportaba `ready` (sin firmar) y el fallback subió el original. |
| `raw = signed` + `origen = get_file_catalog_fallback` | 1 (Jovanny) | **Firma real, documento equivocado**: firmó, pero se subió/envió el PDF del fallback (nombre del original). Nuevo tipo de daño. |
| `origen = clicksign_reparacion` (30-jun: Jose Vasquez `raw=ready`, Elkin Fernandez `raw=ready`, Heber Hernandez `raw=signed`) | 3 | Origen inexistente en el código actual: script de reparación puntual. Los dos con `raw=ready` son sospechosos → verificación visual de sus PDFs. |

**Pendientes de verificación visual** (abrir el PDF y confirmar firma): Marisol, Jovanny,
Jose Vasquez, Elkin Fernandez, + muestreo de los 13 `get_file_signed_contract`.

Dato clave para el fix: el valor crudo que Click&Sign reporta para una firma no completada es
`ready` — `normalizeClickSignStatus("ready")` devuelve `""` y el resolvedor fabrica `signed` por
la sola existencia del PDF. El verificador nuevo debe tratar `ready` como pendiente.

## Restricciones operativas vigentes

1. **NO reiniciar ninguna firma** (ni Luis ni Marisol) hasta desplegar el fix: la reconciliación
   actual volvería a clasificar el original como firmado.
2. No usar `POST /cuentas-cobro/:id/firma/reiniciar` sobre cuentas con falso firmado: la guardia
   actual detecta `documento_firmado.url` y se niega (o re-aprueba vía verificación falsa).
3. Avisar a Proveedores que las copias de los falsos positivos son inválidas.

## Plan de corrección (v2.2, aprobado para Fase 0)

**Fase 0 (en curso):** `back/scripts/diagnostico-firma-clicksign.js` (solo lectura) compara los 3
casos en Click&Sign: `signature_status` oficial, `file_group` reales por archivo, soporte del
parámetro `file_group` en `GET_FILE_LIST`, y descarga opcional para verificación visual. La salida
define la allowlist real de grupos firmados. Salida fuera del repositorio (`%TEMP%`).

**Fix productivo (tras Fase 0), solo cuentas de cobro:**

1. Verificador nuevo en servicio independiente: `signature_status` oficial estricto
   (únicamente `signed` exacto) **y** PDF proveniente de `file_group` de la allowlist
   (fail-closed: vacía o con valores desconocidos ⇒ nunca aprueba).
2. Eliminar `allowCatalogFallback` del camino de cuentas de cobro.
3. Cierre común (Aprobado + OneDrive + notificación) extraído a servicio propio, transaccional y
   condicional; el webhook libera su `FOR UPDATE` (COMMIT) antes de invocarlo.
4. Kill-switch `CUENTAS_FIRMA_AUTOCIERRE`: evaluado antes del upload a OneDrive; apagado ⇒ sin
   aprobación, sin notificación, sin reintentos de 30 s; se mantienen diagnóstico (caller),
   timeout de 24 h y carga manual (`/firma/adjuntar`). Nunca persistir `firma.estado = "signed"`
   fuera del cierre exitoso (el timeout solo procesa estados pendientes; un `signed` persistido
   dejaría la cuenta atascada).
5. Reinicio: `CANCEL_SIGNATURE` obligatorio (ya-cancelada/expirada cuentan como éxito; error de
   transporte aborta; override solo admin, auditado); retirar la guardia por `documento_firmado.url`;
   limpiar solo `cuenta_cobro_firmada`, `seguridad_social_firma`, `evidencia_firma`, `anexo_firma`;
   conservar siempre `soportes.seguridad_social` y sus llaves de mapeo (`seguridad_social_origen`,
   `_cargado_por`, `_cargado_en`); intentos archivados con `no_reconciliar: true` no se reconcilian.
6. Pruebas ejecutables con `node:test` nativo (script `test` nuevo en `back/package.json`); caso
   obligatorio: firma `pending` + PDF original ⇒ jamás aprueba ni notifica.
7. Fuera de alcance: contratos y anexos individuales (siguen su flujo actual);
   `fetchClickSignSignatureSnapshot` (~6858) queda como follow-up separado.
8. Pendiente al implementar: marcar `no_reconciliar: true` en `firma_reseteos[0]` de Luis
   (SQL preparado) y resetear Marisol con el procedimiento corregido.

## Cronología

| Fecha | Evento |
|---|---|
| 2026-06-09 | Commit `76017d5` introduce la reconciliación con fallback de catálogo. |
| 2026-07-01 | Cuenta de Luis Figala creada; el flujo la aprueba y notifica con el PDF sin firma. |
| 2026-07-03 | Reporte operativo; diagnóstico de causa raíz; reversión manual del caso Luis; identificación de Marisol (falso positivo) y Jovanny (referencia); diseño del fix iterado hasta v2.2; script Fase 0 creado y aprobado. |
