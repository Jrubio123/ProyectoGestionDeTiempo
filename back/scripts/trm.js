
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');

// ==========================================
// 1. CONFIGURACIÓN
// ==========================================
const pool = new Pool({
  user: 'postgres',      // TU USUARIO
  host: 'localhost',     // TU HOST (ej. localhost o endpoint de Azure)
  database: 'midatabase', // TU BASE DE DATOS
  password: 'admin',     // TU CONTRASEÑA
  port: 5432,
});

// Headers para parecer un navegador real (evita bloqueos en BanRep)
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

// ==========================================
// 2. FUNCIONES DE AYUDA (PARSING)
// ==========================================

// Convierte "$ 3,659.71" (Formato USA) a número 3659.71
function parseFormatoUSA(texto) {
    if (!texto) return null;
    // Quitar todo excepto números y punto
    let limpio = texto.replace(/[^0-9.]/g, ''); 
    return parseFloat(limpio);
}

// Convierte "3.659,71" (Formato COL) a número 3659.71
function parseFormatoCOL(texto) {
    if (!texto) return null;
    // Quitar puntos de miles
    let sinMiles = texto.replace(/\./g, '');
    // Cambiar coma decimal por punto
    let conPunto = sinMiles.replace(',', '.');
    // Limpiar basura extra
    let limpio = conPunto.replace(/[^0-9.]/g, '');
    return parseFloat(limpio);
}

// Función genérica para guardar en BD
async function guardarEnBD(columna, valor) {
    if (!valor) return;
    const fechaHoy = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    const query = `
      INSERT INTO trm_consolidada (fecha, ${columna}, ultima_actualizacion)
      VALUES ($1, $2, NOW())
      ON CONFLICT (fecha) 
      DO UPDATE SET 
        ${columna} = EXCLUDED.${columna},
        ultima_actualizacion = NOW();
    `;
    
    try {
        await pool.query(query, [fechaHoy, valor]);
        console.log(`✅ Guardado en columna [${columna}]: ${valor}`);
    } catch (e) {
        console.error(`❌ Error guardando en BD (${columna}):`, e.message);
    }
}

// ==========================================
// 3. SCRAPERS INDIVIDUALES
// ==========================================

// SITIO 1: Dolar Colombia (Formato USA: 3,659.71)
async function scrapeDolarColombia() {
    try {
        const { data } = await axios.get('https://www.dolar-colombia.com/', { headers: HEADERS });
        const $ = cheerio.load(data);
        
        // Selector robusto
        const texto = $('.exchange-rate').first().text();
        const valor = parseFormatoUSA(texto); // Usa coma para miles, punto para decimales en el HTML
        
        console.log(`🔍 Dolar-Colombia: ${valor}`);
        await guardarEnBD('dolar_colombia_com', valor);
    } catch (error) {
        console.error('⚠️ Falló Dolar-Colombia:', error.message);
    }
}

// SITIO 2: TRM Hoy (Formato USA: 3,659.71 en tu ejemplo)
async function scrapeTRMHoy() {
    try {
        const { data } = await axios.get('https://www.trmhoy.co/', { headers: HEADERS });
        const $ = cheerio.load(data);

        // Selector basado en tu snippet: h2 dentro de .col-4
        // A veces hay varios h2, buscamos el que tenga el signo pesos
        let texto = '';
        $('div.col-4 h2').each((i, el) => {
            const t = $(el).text();
            if (t.includes('$')) texto = t;
        });

        const valor = parseFormatoUSA(texto);
        
        console.log(`🔍 TRM Hoy: ${valor}`);
        await guardarEnBD('trmhoy_co', valor);
    } catch (error) {
        console.error('⚠️ Falló TRMHoy:', error.message);
    }
}

// SITIO 3: BanRep (Formato COL: 3.659,71) - EL MÁS DIFÍCIL
async function scrapeBanRep() {
    try {
        // BanRep suele bloquear scrapers simples. Si falla, requeriría Puppeteer.
        const { data } = await axios.get('https://www.banrep.gov.co/es/estadisticas/trm', { headers: HEADERS });
        const $ = cheerio.load(data);

        // Buscamos un patrón común en la página de estadísticas
        // Nota: BanRep cambia mucho. Intentaremos buscar el valor en la tabla de "TRM vigente"
        // Si usamos tu snippet del glosario, el selector sería un 'a' específico.
        // Voy a usar un selector genérico de tabla que suele funcionar en su sección de stats.
        
        // Estrategia: Buscar texto que parezca moneda cerca de la palabra "Vigente"
        // O usar el ID específico si existe.
        
        // Intento con selector de tabla standard de banrep
        let texto = $('#block-system-main table tr').eq(1).find('td').last().text(); 
        
        // Si no encuentra nada, fallback a búsqueda genérica
        if (!texto) {
             // Esto es arriesgado pero intenta cazar el formato 1.000,00
             texto = $('body').text().match(/[0-9]{1}\.[0-9]{3},[0-9]{2}/)?.[0];
        }

        const valor = parseFormatoCOL(texto); // BanRep usa Puntos para miles, Coma decimal

        console.log(`🔍 BanRep: ${valor} (Texto crudo: ${texto ? texto.trim() : 'No encontrado'})`);
        await guardarEnBD('banrep_gov_co', valor);

    } catch (error) {
        console.error('⚠️ Falló BanRep (Probablemente requiera Puppeteer o API oficial):', error.message);
    }
}

// ==========================================
// 4. EJECUCIÓN PRINCIPAL
// ==========================================
(async () => {
    console.log('🚀 Iniciando Scraping...');
    
    // Ejecutamos todos en paralelo para ganar tiempo
    await Promise.all([
        scrapeDolarColombia(),
        scrapeTRMHoy(),
        scrapeBanRep()
    ]);

    console.log('🏁 Proceso finalizado.');
    await pool.end(); // Cerramos conexión BD
})();