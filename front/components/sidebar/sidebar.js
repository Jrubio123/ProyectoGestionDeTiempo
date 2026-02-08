function initSidebar() {
    const sidebar = document.querySelector(".sidebar");
    const toggleBtn = document.getElementById("sidebarToggle");
    const menuItems = document.querySelectorAll(".menu-item");
    const logoutBtn = document.querySelector(".logout-btn");

    if (!sidebar) return;

    if (toggleBtn) {
        toggleBtn.addEventListener("click", function () {
            sidebar.classList.toggle("collapsed");
            const isCollapsed = sidebar.classList.contains("collapsed");
            document.body.classList.toggle("sidebar-collapsed", isCollapsed);
            try {
                localStorage.setItem("sidebarCollapsed", isCollapsed);
            } catch (e) {
                // Storage might be blocked by tracking prevention.
            }
        });
    }

    try {
        const savedState = localStorage.getItem("sidebarCollapsed");
        if (savedState === "true") {
            sidebar.classList.add("collapsed");
        }
    } catch (e) {
        // Ignore storage access errors.
    }

    const isCollapsed = sidebar.classList.contains("collapsed");
    document.body.classList.toggle("sidebar-collapsed", isCollapsed);

    const roleKey = window.auth?.getRoleKey?.() || "other";
    const roleRoutes = {
        admin: ["inicio", "cliente", "permisos-coordinador", "asignacion-coordinador", "tarifas"],
        coordinador: [
            "inicio",
            "asignacion-consultor",
            "aprobar-rechazar-coordinador",
            "mis-asignaciones-coordinador",
            "asociar-subconsultores",
            "tarifas"
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
        ]
    };

    const allowed = new Set(roleRoutes[roleKey] || ["inicio"]);
    menuItems.forEach((item) => {
        const link = item.querySelector(".menu-link");
        if (!link) return;
        const hash = (link.getAttribute("href") || "").replace("#", "");
        item.style.display = allowed.has(hash) ? "" : "none";
    });

    const sections = sidebar.querySelectorAll(".menu-section");
    sections.forEach((section) => {
        const hasVisible = Array.from(section.querySelectorAll(".menu-item")).some(
            (item) => item.style.display !== "none"
        );
        section.style.display = hasVisible ? "" : "none";
    });

    menuItems.forEach((item) => {
        const link = item.querySelector(".menu-link");
        if (!link) return;
        link.addEventListener("click", function () {
            menuItems.forEach((i) => i.classList.remove("active"));
            item.classList.add("active");
        });
    });

    if (logoutBtn) {
        logoutBtn.addEventListener("click", function () {
            if (confirm("¿Estás seguro de que quieres cerrar sesión?")) {
                console.log("Cerrando sesión...");
                window.location.href = "/login";
            }
        });
    }
}

window.initSidebar = initSidebar;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSidebar);
} else {
    initSidebar();
}
