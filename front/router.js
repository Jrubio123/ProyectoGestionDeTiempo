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
    inicio: "inicio",
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
    "generar-cuenta-cobro": "generar-cuenta-cobro",
    "asignacion-fabrica-mesa-servicio": "asignacion-fabrica-mesa-servicio",
    solicitudesCoord: "solicitudesCoord",
    solicitudesRecl: "solicitudesRecl"
};

function router() {
    if (window.auth && !window.auth.isAuthenticated()) {
        window.location.href = "/login.html";
        return;
    }
    const hash = location.hash.replace("#", "") || "inicio";
    const view = routes[hash];

    const roleKey = window.auth?.getRoleKey?.() || "other";
    const roleRoutes = {
        admin: ["inicio", "cliente", "permisos-coordinador", "asignacion-coordinador","asociar-subconsultores", "tarifas", "solicitudesCoord", "solicitudesRecl"],
        coordinador: [
            "inicio",
            "asignacion-consultor",
            "cliente",
            "aprobar-rechazar-coordinador",
            "mis-asignaciones-coordinador",
            "asociar-subconsultores",
            "tarifas",
            "solicitudesCoord"
        ],
        consultor_principal: [
            "inicio",
            "mis-asignaciones-consultor",
            "registro-horas-consultor",
            "asignacion-fabrica-mesa-servicio",
            "generar-cuenta-cobro",
            "mis-cuentas-cobros"
        ],
        consultor_asociado: [
            "inicio",
            "mis-asignaciones-consultor",
            "registro-horas-consultor",
            "asignacion-fabrica-mesa-servicio"
        ],
        reclutador: [
            "inicio",
            "solicitudesRecl"
        ]
    };
    const allowed = new Set(roleRoutes[roleKey] || ["inicio"]);
    if (view && !allowed.has(view)) {
        loadView("inicio");
        return;
    }

    if (view) {
        loadView(view);
    } else {
        loadView("inicio");
    }
}

window.addEventListener("hashchange", router);
document.addEventListener("DOMContentLoaded", router);
