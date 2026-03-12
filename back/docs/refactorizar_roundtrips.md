# Guía de Refactorización de Roundtrips en PostgreSQL (Node.js/Express)

Esta guía explica paso a paso cómo migrar los endpoints actuales que hacen dobles consultas (Roundtrips) para resolver el `public_id` a `id` interno, hacia una estrategia de una sola consulta (Single-Trip) 100% en SQL. Esto mejora el rendimiento, disminuye la latencia de red y escala de mejor manera.

## 1. Patrón ACTUAL (Inconsistente y Lento)

Actualmente se usa la función `resolveInternalId` o similares antes de hacer la operación de escritura real:

```javascript
// AHORA: Inserción de un nuevo registro
app.post("/asignaciones", async (req, res) => {
  const { consultoria_id, consultor_id, tarifa } = req.body;

  try {
    // 🔴 2 Roundtrips (VIAJES) EXTRA al servidor PostgreSQL
    const dbConsultoriaId = await resolveInternalId(pool, "consultorias", consultoria_id);
    const dbConsultorId = await resolveInternalId(pool, "usuarios", consultor_id);

    // 🔴 Viaje #3 a la BD
    const result = await pool.query(
      `INSERT INTO registro_asignaciones (id_consultoria, consultor_responsable_id, valor_hora)
       VALUES ($1, $2, $3) RETURNING public_id AS id`,
      [dbConsultoriaId, dbConsultorId, tarifa]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Error de Guardado" });
  }
});
```

## 2. El PATRÓN NUEVO: Usar CTEs (Common Table Expressions)

Podemos unificar los SELECTs iniciales y el INSERT/UPDATE en un único comando SQL mediante un CTE (`WITH variable AS (SELECT ...)`). Esta sintaxis le indica a PostgreSQL que calcule primero las variables temporales y luego realice la inserción usando esa tabla virtual.

### 2.1 Refactor de un `POST` (INSERT múltiple ForeignKey)

```javascript
// REFACTORIZADO (Un solo viaje)
app.post("/asignaciones", async (req, res) => {
  // Solo se reciben los public_ids (UUIDs)
  const { consultoria_id, consultor_id, tarifa } = req.body;

  try {
    const result = await pool.query(`
      WITH 
        -- Buscamos automáticamente los IDs reales enteros
        c_consultoria AS (SELECT id FROM consultorias WHERE public_id = $1),
        c_usuario AS (SELECT id FROM usuarios WHERE public_id = $2)
      
      INSERT INTO registro_asignaciones (
        id_consultoria, 
        consultor_responsable_id, 
        valor_hora
      )
      SELECT 
        c_consultoria.id, 
        c_usuario.id, 
        $3
      FROM c_consultoria, c_usuario
      -- Si alguno de los public_ids es falso o nulo, la condición WHERE falla y no inserta
      WHERE c_consultoria.id IS NOT NULL 
        AND c_usuario.id IS NOT NULL
        
      RETURNING 
        public_id AS id, 
        created_at;
    `, [consultoria_id, consultor_id, tarifa]);

    // Validación elegante si no se insertó nada
    if (result.rowCount === 0) {
      return res.status(400).json({ 
        error: "Referencia a Consultoría o Consultor inválidos o no encontrados" 
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo crear la asignación" });
  }
});
```

### 2.2 Refactor de un `PUT` (Actualizar sin resolveInternalId)

Las actualizaciones (y por lógica, los DELETE) en endpoints basados en un parámetro de ruta requieren lo mismo.

```javascript
// AHORA
app.put("/clientes/:id", async (req, res) => {
  const { titulo, nit } = req.body;
  
  // 🔴 Viaje 1
  const clienteId = await resolveInternalId(pool, "clientes", req.params.id, { required: true });

  // 🔴 Viaje 2
  const result = await pool.query(
    "UPDATE clientes SET titulo = $1, nit = $2 WHERE id = $3 RETURNING *",
    [titulo, nit, clienteId]
  );
  res.json({ id: result.rows[0].public_id, titulo: result.rows[0].titulo });
});
```

El enfoque de Un-viaje usando SubQuery:

```javascript
// REFACTOR (Un solo viaje)
app.put("/clientes/:id", async (req, res) => {
  const { titulo, nit } = req.body;
  
  try {
    const result = await pool.query(`
      UPDATE clientes      
      SET 
          titulo = $1,
          nit = $2,
          updated_at = CURRENT_TIMESTAMP
          
      -- Aquí el magia: El subquery en el WHERE clause
      WHERE id = (SELECT id FROM clientes WHERE public_id = $3)
      
      RETURNING 
          public_id AS id, 
          titulo, 
          nit
    `, [titulo, nit, req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (err) {
     res.status(500).json({ error: "Error al actualizar el cliente" });
  }
});
```

## 3. Estrategia de Implementación Recomendada

Hacer un refactor integral de un archivo gigante (8,500 líneas en `index.js`) tiene altos riesgos de romper algo. El mejor enfoque es migrar **Endpoints progresivamente**:

1. **Agrupar por Dominios/Features**: Puedes comenzar moviendo las rutas de `clientes` y `consultorias` hacia un controlador y aplicar estas técnicas SQL allí.
2. **Revisar Operaciones Críticas**: Priorizar endpoints que se invoquen con mucha frecuencia o en lotes, como `POST /reportar-horas` o asignaciones masivas de mesa de servicio. Estos son los que más ganan con un solo *roundtrip*.
3. **Validar las Inserciones Vacías**: Siempre comprobar `if (result.rowCount === 0)` y devolver código 400 (Bad Request) o 404 (Not Found). El patrón "Un Solo Viaje" devolverá `rowCount === 0` cuando el subquery con el UUID malicioso devuelva un valor nulo de forma transparente y segura.
4. **Remover funciones auxiliares legadas**: Una vez todos los endpoints de un recurso migren, puedes quitar las llamadas a `resolveInternalId()` con seguridad.
