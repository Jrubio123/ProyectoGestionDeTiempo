async function loadView(view) {
    try {
        // Quitamos la extensión aquí, el backend se encargará de buscar el archivo
        const res = await fetch(`/views/${view}.html`);

        if(!res.ok) throw new Error("Error HTTP: " + res.status);

        const html = await res.text();
        const container = document.getElementById("view-container");
        
        // Inyectamos HTML
        container.innerHTML = html;
        
        // Alpine 3 detecta automáticamente cambios en el DOM (MutationObserver),
        // pero por seguridad, como estamos inyectando HTML completo:
        if (window.Alpine) {
           // Alpine.initTree(container); // Opcional en v3, necesario en v2
        }
        
    } catch (error) {
        console.error("Error cargando vista:", error);
        document.getElementById("view-container").innerHTML = `<div class="text-red-600 p-4">Error cargando vista: ${view}</div>`;
    }
}


// Mapa de rutas (hash -> archivo)
const routes = {
    inicio: "dashboard",
    cliente: "cliente",
    tarifas: "tarifas",
    "permisos-coordinador": "permisos-coordinador",
    "asignacion-coordinador": "asignacion-coordinador",
    "asignacion-consultor": "asignacion-consultor",
    "asociar-subconsultores": "asociar-subconsultores",
    "mis-asignaciones-coordinador": "mis-asignaciones-coordinador",
    "mis-asignaciones-consultor": "mis-asignaciones-consultor",
    "registro-horas-consultor": "registro-horas-consultor",
    "aprobar-rechazar-coordinador": "aprobar-rechazar-coordinador",
    "mis-cuentas-cobros": "mis-cuentas-cobros",
    "generar-cuenta-cobro": "generar-cuenta-cobro"
};

function router() {
    const hash = location.hash.replace("#", "") || "inicio";
    const view = routes[hash];
    
    if (view) {
        loadView(view);
    } else {
        loadView("dashboard");
    }
}

// Detecta cambios en menú
window.addEventListener("hashchange", router);
document.addEventListener("DOMContentLoaded", router);
