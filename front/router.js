async function loadView(view) {
    try {
        const res = await fetch(`/views/${view}.html`);
        if (!res.ok) throw new Error("Vista no encontrada");
        document.getElementById("view-container").innerHTML = await res.text();
    } catch {
        document.getElementById("view-container").innerHTML = `
            <h2 class="text-xl text-red-600">Vista no encontrada</h2>
        `;
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
    if (view) loadView(view);
}

// Detecta cambios en menú
window.addEventListener("hashchange", router);
document.addEventListener("DOMContentLoaded", router);
