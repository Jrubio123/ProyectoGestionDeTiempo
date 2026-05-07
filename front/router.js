// Mapa ruta -> script de vista. null = no necesita JS propio.
const viewScripts = {
    inicio:                           null,
    cliente:                          "/js/cliente.js",
    tarifas:                          "/js/tarifas.js",
    "permisos-coordinador":           null,
    "asignacion-coordinador":         "/js/asignacion-coordinador.js",
    "asignacion-consultor":           "/js/asignacion-consultor.js",
    "asociar-subconsultores":         "/js/asociar-subconsultores.js",
    "mis-asignaciones-coordinador":   "/js/mis-asignaciones-coordinador.js",
    "mis-asignaciones-consultor":     "/js/mis-asignaciones-consultor.js",
    "registro-horas-consultor":       "/js/registro-horas-consultor.js",
    "aprobar-rechazar-coordinador":   "/js/aprobar-rechazar-coordinador.js",
    "mis-cuentas-cobros":             "/js/mis-cuentas-cobros.js",
    "soportes-cuentas-cobro":         "/js/soportes-cuentas-cobro.js",
    "generar-cuenta-cobro":           "/js/generar-cuenta-cobro.js",
    "asignacion-fabrica-mesa-servicio": "/js/asignacion-fabrica-mesa-servicio.js",
    "catalogos-admin":                "/js/catalogos-admin.js",
    "gestion-licencias-admin":        "/js/gestion-licencias-admin.js",
    "gestion-personas":               "/js/gestion-personas.js",
    "gestion-consultores":            "/js/gestion-consultores.js",
    "firma-contratos-admin":          "/js/firma-contratos-admin.js",
    solicitudesCoord:                 "/js/solicitudes-coord.js",
    preregistrosCoord:                "/js/preregistros-coord.js",
    solicitudesRecl:                  "/js/solicitudes-recl.js",
    onboardingTH:                     "/js/onboarding-th.js",
    anexoTecnicoIndividual:           "/js/onboarding-th.js"
};

// Cache de promesas de scripts: clave = src, valor = Promise.
// Guardar la promesa (no solo el resultado) evita inyectar el mismo
// archivo dos veces si llegan dos navegaciones rápidas antes del onload.
const _scriptPromises = new Map();
const APP_ASSET_VERSION = "20260507-gestion-consultores";

function loadScript(src) {
    if (_scriptPromises.has(src)) return _scriptPromises.get(src);
    const promise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        const sep = src.includes("?") ? "&" : "?";
        script.src = `${src}${sep}v=${APP_ASSET_VERSION}`;
        script.onload = () => resolve();
        script.onerror = () => {
            _scriptPromises.delete(src); // permite reintento si falla
            reject(new Error("Error cargando script: " + src));
        };
        document.head.appendChild(script);
    });
    _scriptPromises.set(src, promise);
    return promise;
}

async function loadView(view) {
    const container = document.getElementById("view-container");

    // Feedback inmediato: evita pantalla en blanco mientras carga script + HTML.
    container.innerHTML = `<div class="flex items-center justify-center py-16 text-gray-400">
        <svg class="animate-spin h-6 w-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
        </svg>
    </div>`;

    try {
        const scriptSrc = viewScripts[view] ?? null;

        // Cargamos script y HTML en paralelo para no perder tiempo.
        const [, res] = await Promise.all([
            scriptSrc ? loadScript(scriptSrc) : Promise.resolve(),
            fetch(`/views/${view}.html?v=${APP_ASSET_VERSION}`)
        ]);

        if (!res.ok) throw new Error("Error HTTP: " + res.status);

        const html = await res.text();
        container.innerHTML = html;

        // Re-inicializar Alpine para el contenido cargado dinámicamente.
        if (window.Alpine) {
            Alpine.initTree(container);
        }
    } catch (error) {
        console.error("Error cargando vista:", error);
        container.innerHTML =
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
    "soportes-cuentas-cobro": "soportes-cuentas-cobro",
    "generar-cuenta-cobro": "generar-cuenta-cobro",
    "asignacion-fabrica-mesa-servicio": "asignacion-fabrica-mesa-servicio",
    "catalogos-admin": "catalogos-admin",
    "gestion-licencias-admin": "gestion-licencias-admin",
    "gestion-personas": "gestion-personas",
    "gestion-consultores": "gestion-consultores",
    "firma-contratos-admin": "firma-contratos-admin",
    solicitudesCoord: "solicitudesCoord",
    preregistrosCoord: "preregistrosCoord",
    solicitudesRecl: "solicitudesRecl",
    onboardingTH: "onboardingTH",
    anexoTecnicoIndividual: "anexoTecnicoIndividual"
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
        admin: ["inicio", "cliente", "permisos-coordinador", "asignacion-coordinador","asociar-subconsultores", "tarifas", "solicitudesCoord", "preregistrosCoord", "solicitudesRecl", "onboardingTH", "anexoTecnicoIndividual", "soportes-cuentas-cobro", "catalogos-admin", "gestion-licencias-admin", "firma-contratos-admin", "gestion-personas", "gestion-consultores"],
        coordinador: [
            "inicio",
            "asignacion-consultor",
            "cliente",
            "aprobar-rechazar-coordinador",
            "mis-asignaciones-coordinador",
            "asociar-subconsultores",
            "tarifas",
            "solicitudesCoord",
            "preregistrosCoord",
            "soportes-cuentas-cobro",
            "gestion-consultores"
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
        reclutador: ["inicio", "solicitudesRecl"],
        comercial: ["inicio", "solicitudesCoord", "preregistrosCoord", "gestion-consultores"],
        talento_humano: ["inicio", "onboardingTH", "anexoTecnicoIndividual", "firma-contratos-admin", "gestion-personas", "gestion-consultores"]
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
