function initSidebar() {
    const sidebar = document.querySelector(".sidebar");
    const toggleBtn = document.getElementById("sidebarToggle");
    const mobileBackdrop = document.getElementById("sidebarMobileBackdrop");
    const menuItems = document.querySelectorAll(".menu-item");
    const logoutBtn = document.querySelector(".logout-btn");
    const mobileQuery = window.matchMedia("(max-width: 1024px)");

    if (!sidebar) return;
    if (window.__sidebarMounted) return;
    window.__sidebarMounted = true;

    const isMobileViewport = () => mobileQuery.matches;

    const closeMobileSidebar = () => {
        sidebar.classList.remove("mobile-open");
        document.body.classList.remove("sidebar-mobile-open");
    };

    const openMobileSidebar = () => {
        sidebar.classList.add("mobile-open");
        document.body.classList.add("sidebar-mobile-open");
    };

    const toggleMobileSidebar = () => {
        if (sidebar.classList.contains("mobile-open")) {
            closeMobileSidebar();
        } else {
            openMobileSidebar();
        }
    };

    if (toggleBtn) {
        toggleBtn.addEventListener("click", function () {
            if (isMobileViewport()) {
                toggleMobileSidebar();
                return;
            }
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
        if (savedState === "true" && !isMobileViewport()) {
            sidebar.classList.add("collapsed");
        }
    } catch (e) {
        // Ignore storage access errors.
    }

    const isCollapsed = !isMobileViewport() && sidebar.classList.contains("collapsed");
    document.body.classList.toggle("sidebar-collapsed", isCollapsed);

    if (mobileBackdrop) {
        mobileBackdrop.addEventListener("click", closeMobileSidebar);
    }

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isMobileViewport()) {
            closeMobileSidebar();
        }
    });

    window.addEventListener("resize", () => {
        if (!isMobileViewport()) {
            closeMobileSidebar();
        }
    });

    const roleKey = window.auth?.getRoleKey?.() || "other";
    const roleRoutes = {
        admin: ["inicio", "cliente", "permisos-coordinador", "asignacion-coordinador", "asociar-subconsultores", "tarifas", "solicitudesCoord", "preregistrosCoord", "solicitudesRecl", "onboardingTH", "anexoTecnicoIndividual", "soportes-cuentas-cobro", "catalogos-admin", "gestion-licencias-admin", "firma-contratos-admin"],
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
            "soportes-cuentas-cobro"
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
        talento_humano: ["inicio", "onboardingTH", "anexoTecnicoIndividual", "firma-contratos-admin"]
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
            if (isMobileViewport()) {
                closeMobileSidebar();
            }
        });
    });

    function syncActiveWithHash() {
        const currentHash = (window.location.hash || "#inicio").replace("#", "");
        let matched = false;
        menuItems.forEach((item) => {
            const link = item.querySelector(".menu-link");
            if (!link) return;
            const target = (link.getAttribute("href") || "").replace("#", "");
            const isActive = target === currentHash;
            item.classList.toggle("active", isActive);
            if (isActive) matched = true;
        });

        if (!matched) {
            menuItems.forEach((item) => {
                const link = item.querySelector(".menu-link");
                if (!link) return;
                const target = (link.getAttribute("href") || "").replace("#", "");
                item.classList.toggle("active", target === "inicio");
            });
        }

        if (isMobileViewport()) {
            closeMobileSidebar();
        }
    }

    syncActiveWithHash();
    if (!window.__sidebarHashSyncReady) {
        window.addEventListener("hashchange", syncActiveWithHash);
        window.__sidebarHashSyncReady = true;
    }

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

