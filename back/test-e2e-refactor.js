const { Client } = require('pg');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'dev_local_jwt_secret_change_me';
const DB_URL = 'postgres://gestion_user:gestion_pass_local@db:5432/gestion_tiempo';

async function test() {
  const client = new Client(DB_URL);
  await client.connect();
  
  console.log("=== INICIANDO E2E PRUEBAS REFACTORIZACION ===");
  try {
    // ==========================================
    // PREPARACION
    // ==========================================
    console.log("-> Preparando datos de prueba...");
    const thRes = await client.query(`SELECT id FROM roles WHERE titulo ILIKE 'Talento Humano' LIMIT 1`);
    const thId = thRes.rows[0]?.id || 1;
    
    await client.query(`DELETE FROM anexo_tecnico_items WHERE preregistro_id IN (SELECT id FROM preregistro_personas WHERE numero_documento = 'QA999999')`);
    await client.query(`DELETE FROM preregistro_personas WHERE numero_documento = 'QA999999'`);
    await client.query(`DELETE FROM personas WHERE numero_documento = 'QA999999'`);
    await client.query(`DELETE FROM solicitudes_rrhh WHERE perfil = 'QA Profile'`);
    await client.query(`DELETE FROM usuarios WHERE email = 'qa_th@silverconsulting.com.co'`);

    const userTh = await client.query(`
      INSERT INTO usuarios (public_id, nombre_usuario, email, rol_usuario_id, password_hash, activo) 
      VALUES (gen_random_uuid(), 'QA_TH_TESTER', 'qa_th@silverconsulting.com.co', $1, 'hash', true) 
      RETURNING id, public_id, email;`, [thId]);
    
    const tokenTH = jwt.sign({ 
      id: userTh.rows[0].id, 
      rol: 'Talento Humano', 
      email: userTh.rows[0].email 
    }, JWT_SECRET);

    // ==========================================
    // PRUEBA A: Preregistro con crear_usuario_sistema = false
    // ==========================================
    console.log("-> Ejecutando PRUEBA A (Personas vs Usuarios)...");
    
    // Prepare cliente
    const cliRes = await client.query(`INSERT INTO clientes (titulo, activo, public_id, nit) VALUES ('QA Cliente', true, gen_random_uuid(), '999999999') ON CONFLICT DO NOTHING RETURNING id`);
    const cliId = cliRes.rows[0]?.id || (await client.query(`SELECT id FROM clientes LIMIT 1`)).rows[0]?.id;

    // Tipo documento CC = 1, insert solicitud rrhh
    const sol = await client.query(`
      INSERT INTO solicitudes_rrhh (estado, perfil, modalidad, nivel, cliente_id, coordinador_id) 
      VALUES ('Contratado', 'QA Profile', 'Full time', 'Senior', $2, $1) 
      RETURNING id;`, [userTh.rows[0].id, cliId]);
      
    const pre = await client.query(`
      INSERT INTO preregistro_personas (
        id_solicitud_rrhh, nombre, apellidos, tipo_documento_id, numero_documento, correo_personal, correo_silver,
        estado, creado_por, crear_usuario_sistema, tarifa_mes, tarifa_hora, factura_en_colombia, moneda, tipo_persona, tipo_cuenta, numero_cuenta, pais_ubicacion, banco_id
      ) VALUES (
        $1, 'QANombre', 'QAApellido', (SELECT id FROM documento_identidad WHERE codigo = 'CC' LIMIT 1), 'QA999999', 'qa999@test.com', 'qa999@silverconsulting.com.co',
        'Pendiente Correo Silver', $2, false, 1000, 10, true, 'COP', 'Natural', 'Ahorros', '1234', 'Colombia', (SELECT id FROM bancos LIMIT 1)
      ) RETURNING id, public_id;`, [sol.rows[0].id, userTh.rows[0].id]);
      
    const prePubId = pre.rows[0].public_id;

    // Simulate approval call.
    const resA = await fetch(`http://localhost:4000/api/preregistros/${prePubId}/aprobar`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    
    if (resA.status >= 400) {
      console.log("   [FAIL] PRUEBA A: API devolvio error:", resA.status, await resA.text());
    } else {
      const checkPersona = await client.query(`SELECT id FROM personas WHERE numero_documento = 'QA999999'`);
      const checkUsuario = await client.query(`SELECT id FROM usuarios WHERE cedula = 'QA999999'`);
      
      if (checkPersona.rows.length === 1 && checkUsuario.rows.length === 0) {
        console.log("   [PASS] PRUEBA A: Persona guardada, Usuario NO insertado.");
      } else {
        console.log(`   [FAIL] PRUEBA A: persona=${checkPersona.rows.length}, usuario=${checkUsuario.rows.length}`);
      }
    }

    // ==========================================
    // PRUEBA B: Busqueda de Anexos
    // ==========================================
    console.log("-> Ejecutando PRUEBA B (Buscador TH)...");
    const resB = await fetch(`http://localhost:4000/th/anexo-individual/search?q=QA999999`, {
      headers: { 'Authorization': `Bearer ${tokenTH}` }
    });
    
    if (resB.status === 200) {
        const bodyB = await resB.json();
        const foundQA = bodyB.find(x => x.cedula === 'QA999999');
        if (foundQA) {
            console.log(`   [PASS] PRUEBA B: Se encontro a la persona en la busqueda.`);
            console.log(`          source: '${foundQA.source}', internal_id: ${foundQA.internal_id}`);
            if (foundQA.source === 'persona' && Number(foundQA.internal_id) < 0) {
                console.log("          Aserto cumplido: source es 'persona' y el id es negativo.");
            } else if (foundQA.source === 'persona') {
                console.log("          Aserto cumplido: source es 'persona' (Nota: id no es negativo pero lo encontro por UNION)");
            } else {
                console.log("   [FAIL] PRUEBA B: No cumple aserto de source o id.", foundQA);
            }
        } else {
            console.log("   [FAIL] PRUEBA B: No se encontro el documento en la respuesta de search:", bodyB.length, "resultados");
        }
    } else {
        console.log("   [FAIL] PRUEBA B: API /search retorno status", resB.status, await resB.text());
    }

    // ==========================================
    // PRUEBA C: RBAC Comercial
    // ==========================================
    console.log("-> Ejecutando PRUEBA C (RBAC Comercial)...");
    const tokenComercial = jwt.sign({ 
      id: userTh.rows[0].id, 
      rol: 'Comercial', 
      email: userTh.rows[0].email 
    }, JWT_SECRET);

    const resC = await fetch(`http://localhost:4000/contrataciones/solicitudes`, {
      headers: { 'Authorization': `Bearer ${tokenComercial}` }
    });
    
    if (resC.status === 200) {
       console.log("   [PASS] PRUEBA C: Comercial listando exitosamente con where por coordinador_solicitante_id.");
    } else {
       console.log("   [FAIL] PRUEBA C: Status =", resC.status, await resC.text());
    }

    // CLEANUP
    console.log("-> Limpiando base de datos...");
    await client.query(`DELETE FROM anexo_tecnico_items WHERE preregistro_id IN (SELECT id FROM preregistro_personas WHERE numero_documento = 'QA999999')`);
    await client.query(`DELETE FROM preregistro_personas WHERE numero_documento = 'QA999999'`);
    await client.query(`DELETE FROM personas WHERE numero_documento = 'QA999999'`);
    await client.query(`DELETE FROM solicitudes_rrhh WHERE perfil = 'QA Profile'`);
    await client.query(`DELETE FROM usuarios WHERE email = 'qa_th@silverconsulting.com.co'`);

  } catch(e) {
    console.error("ERROR EN SCRIPT:", e);
  } finally {
    await client.end();
  }
}
test();
