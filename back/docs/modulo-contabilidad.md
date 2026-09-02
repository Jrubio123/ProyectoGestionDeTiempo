# Módulo de Contabilidad y Proyección de Pagos

## 1. Migración

Aplicar `db/migrations/2026-09-02-contabilidad-proyeccion-pagos.sql` antes de desplegar el backend. `db/init.sql` también incluye la migración para instalaciones nuevas.

El perfil tributario de cada persona se obtiene de:

- `es_gran_contribuyente`, `es_autorretenedor`, `es_regimen_simple` y
  `es_entidad_sin_animo_lucro`: banderas independientes y combinables.
- `declarante_renta`: diferencia las tarifas de compras y servicios.
- `facturador_electronico`: conserva la clasificación tributaria de la persona;
  no reemplaza las bases específicas de `consultor` u `honorarios`.
- `acumulado_facturacion_anual`: conserva el acumulado que usa Contabilidad para determinar el tope anual.
- `factura_en_colombia`: en `false` identifica un pago Capitalink sin impuestos locales.

Las banderas se evalúan de manera acumulativa: `es_autorretenedor`,
`es_regimen_simple` o `es_entidad_sin_animo_lucro` desactivan ReteFuente;
`es_gran_contribuyente` desactiva ReteIVA. Una persona Gran Contribuyente y
Autorretenedora queda sin ambas retenciones. `consultor` usa base $1.750.905 y
tarifa 3,5%; `honorarios` usa base $1 y tarifa 11% para declarantes o 10% para
no declarantes.

Las facturas y la nómina se pueden cargar inicialmente por procesos internos con `estado = 'Pendiente'`. Al generar un lote pasan a `Proyectada`; al pagar, a `Pagada`; y al cancelar el lote vuelven a `Pendiente`.

## 2. Acceso

Todas las rutas requieren JWT y uno de los roles `Administrador`, `Contabilidad` o `Talento Humano`. Los IDs recibidos y devueltos por la API son UUID (`public_id`), no IDs internos.

## 3. Endpoints

### Simular retenciones

`POST /api/contabilidad/retenciones/simular`

```json
{
  "subtotal": 2000000,
  "iva": 380000,
  "tipo_pago": "consultor",
  "persona_id": "uuid-de-persona"
}
```

También se puede enviar `persona` como objeto para una simulación sin consultar una persona persistida.

### Generar lote

`POST /api/contabilidad/proyeccion/generar`

```json
{
  "anio": 2026,
  "mes": 10,
  "quincena": 1,
  "trm_oficial": 4215.35
}
```

`trm_oficial` es opcional si no hay pagos Capitalink y obligatorio cuando el lote contiene pagos internacionales. La respuesta incluye un resumen y las cuentas que quedaron en limbo por no tener una fecha de archivo válida o haber superado el segundo corte.

Solo puede existir una proyección activa por año, mes y quincena. Las facturas futuras respecto a `fecha_pago_programada` no se recolectan.

### Consultar detalles

`GET /api/contabilidad/proyeccion/:id/detalles`

Devuelve cabecera, totales y filas con tercero, banco, cuenta, subtotal, IVA, bruto, ReteFuente, ReteIVA, ReteICA y neto.

### Sobrescribir retenciones

`PUT /api/contabilidad/proyeccion/detalle/:id_detalle/retenciones`

```json
{
  "motivo": "Acuerdo tributario validado por Contabilidad",
  "retenciones_aplicadas": [
    {
      "tipo": "ReteFuente",
      "porcentaje": 3.5,
      "base": 2000000,
      "valor": 70000,
      "editable": true
    }
  ]
}
```

El neto se recalcula con los valores suministrados. Solo se permite editar lotes en `Borrador` o `Revisión`, y el cambio queda en auditoría.

### Transicionar lote

`POST /api/contabilidad/proyeccion/:id/transicion`

```json
{
  "estado": "Revisión",
  "comentario": "Validación contable completada"
}
```

Flujo permitido: `Borrador → Revisión → Aprobado → Pagado`. También se puede cancelar antes de `Pagado`. Cada transición registra usuario y fecha; las firmas de revisión, aprobación y pago quedan además en la cabecera.

### Cambiar ciclo de una cuenta

`PUT /api/contabilidad/cuenta_cobro/:id/ciclo`

```json
{
  "ciclo_proyeccion_asignado": "Q1"
}
```

Acepta `Q1`, `Q2` o `null` si la cuenta todavía no pertenece a un lote. En lotes editables puede mover la fila a otro lote del mismo mes o liberarla hasta que se genere el lote destino.

## 4. Regla temporal para arriendos

El documento funcional incluye `arriendo` como tipo de factura, pero no define una base o tarifa propia. El motor lo trata como `servicio` (misma base y tarifas) hasta que Contabilidad entregue una regla distinta.
