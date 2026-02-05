function initNavbar() {
    const navLinks = document.querySelectorAll(".nav-link");

    function setActiveByHash() {
        const hash = window.location.hash || "#inicio";
        navLinks.forEach((link) => {
            if (link.getAttribute("href") === hash) {
                link.classList.add("active");
            } else {
                link.classList.remove("active");
            }
        });
    }

    setActiveByHash();
    window.addEventListener("hashchange", setActiveByHash);

    navLinks.forEach((link) => {
        link.addEventListener("click", function () {
            navLinks.forEach((l) => l.classList.remove("active"));
            this.classList.add("active");
        });
    });

    const searchInput = document.querySelector(".search-input");
    if (searchInput) {
        searchInput.addEventListener("keypress", function (e) {
            if (e.key === "Enter") {
                performSearch(this.value);
            }
        });
    }
}

function performSearch(query) {
    const q = query.trim().toLowerCase();
    if (!q) return;

    const views = [
        { label: "Inicio", hash: "#inicio" },
        { label: "Clientes", hash: "#cliente" },
        { label: "Tarifas", hash: "#tarifas" },
        { label: "Asignación Coordinador", hash: "#asignacion-coordinador" },
        { label: "Permisos Coordinador", hash: "#permisos-coordinador" },
        { label: "Asociar Subconsultores", hash: "#asociar-subconsultores" },
        { label: "Asignación Consultor", hash: "#asignacion-consultor" },
        { label: "Mis Asignaciones Coordinador", hash: "#mis-asignaciones-coordinador" },
        { label: "Mis Asignaciones Consultor", hash: "#mis-asignaciones-consultor" },
        { label: "Asignación Fábrica Mesa Servicio", hash: "#asignacion-fabrica-mesa-servicio" },
        { label: "Registro Horas Consultor", hash: "#registro-horas-consultor" },
        { label: "Aprobar/Rechazar Coordinador", hash: "#aprobar-rechazar-coordinador" },
        { label: "Mis Cuentas Cobros", hash: "#mis-cuentas-cobros" },
        { label: "Generar Cuenta Cobro", hash: "#generar-cuenta-cobro" }
    ];

    const match = views.find(v => v.label.toLowerCase() === q) ||
        views.find(v => v.label.toLowerCase().includes(q));

    if (match) {
        window.location.hash = match.hash;
    } else {
        alert("No se encontró esa vista");
    }
}

window.initNavbar = initNavbar;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNavbar);
} else {
    initNavbar();
}
