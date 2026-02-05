// Función para cargar fragmentos de HTML
async function loadHTML(elementId, url) {
    try {
        const response = await fetch(url);
        const html = await response.text();
        document.getElementById(elementId).innerHTML = html;
    } catch (error) {
        console.error(`Error cargando ${url}:`, error);
    }
}

// Router: Cambia la vista según el hash (#inicio, #tareas)
async function router() {
    const hash = window.location.hash.replace('#', '') || 'inicio';
    const viewUrl = `/views/${hash}.html`;
    
    await loadHTML('view-container', viewUrl);
    
    // Opcional: Actualizar título en el Topbar si existe
    const titleEl = document.getElementById('screen-title');
    if (titleEl) titleEl.innerText = hash.toUpperCase();
}

// Inicialización al cargar la página
window.addEventListener('DOMContentLoaded', async () => {
    // Cargar componentes fijos
    await loadHTML('sidebar-container', '/components/sidebar/sidebar.html');
    await loadHTML('topbar-container', '/components/topbar/topbar.html');
    
    // Cargar la vista inicial
    router();
});

// Escuchar cambios en la URL (Navegación)
window.addEventListener('hashchange', router);  