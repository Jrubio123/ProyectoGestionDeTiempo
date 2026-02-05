async function loadView(view) {
    try {
        const res = await fetch(`/views/${view}.html`);
        if (!res.ok) throw new Error("Error HTTP: " + res.status);

        const html = await res.text();
        const container = document.getElementById("view-container");

        container.innerHTML = html;

        // Re-inicializar Alpine para el contenido cargado dinámicamente
        if (window.Alpine) {
            Alpine.initTree(container);
        }
    } catch (error) {
        console.error("Error cargando vista:", error);
        document.getElementById("view-container").innerHTML =
            `<div class="text-red-600 p-4">Error cargando vista: ${view}</div>`;
    }
}

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

window.addEventListener("hashchange", router);
document.addEventListener("DOMContentLoaded", router);
