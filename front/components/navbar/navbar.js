function getRoleRoutes() {
    return {
        admin: ["inicio", "cliente", "permisos-coordinador", "asignacion-coordinador", "asociar-subconsultores", "tarifas", "solicitudesCoord", "preregistrosCoord", "solicitudesRecl", "onboardingTH", "anexoTecnicoIndividual", "soportes-cuentas-cobro", "catalogos-admin", "gestion-licencias-admin", "firma-contratos-admin", "gestion-personas", "gestion-consultores"],
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
        comercial: ["inicio", "solicitudesCoord", "preregistrosCoord", "gestion-consultores"],
        reclutador: ["inicio", "solicitudesRecl"],
        talento_humano: ["inicio", "onboardingTH", "anexoTecnicoIndividual", "firma-contratos-admin", "gestion-personas", "gestion-consultores"]
    };
}

function getAllSearchViews() {
    return [
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
        { label: "Soportes Cuentas Cobro", hash: "#soportes-cuentas-cobro" },
        { label: "Generar Cuenta Cobro", hash: "#generar-cuenta-cobro" },
        { label: "Catálogos Admin", hash: "#catalogos-admin" },
        { label: "Licencias de Acceso", hash: "#gestion-licencias-admin" },
        { label: "Gestion de Personas", hash: "#gestion-personas" },
        { label: "Gestión de Consultores", hash: "#gestion-consultores" },
        { label: "Solicitudes RRHH", hash: "#solicitudesCoord" },
        { label: "Contrataciones", hash: "#preregistrosCoord" },
        { label: "Pool de Solicitudes", hash: "#solicitudesRecl" },
        { label: "Contrataciones TH", hash: "#onboardingTH" },
        { label: "Anexo tecnico individual", hash: "#anexoTecnicoIndividual" },
        { label: "Firma de Contratos", hash: "#firma-contratos-admin" }
    ];
}

function getAllowedViewsForCurrentRole() {
    const views = getAllSearchViews();
    const roleKey = window.auth?.getRoleKey?.() || "other";
    const roleRoutes = getRoleRoutes();
    const allowed = new Set(roleRoutes[roleKey] || ["inicio"]);
    return views.filter((v) => allowed.has(v.hash.replace("#", "")));
}

function initNavbar() {
    const navbarRoot = document.querySelector(".navbar");
    if (!navbarRoot) return;

    const navLinks = document.querySelectorAll(".nav-link");
    const userNameEl = document.querySelector(".user-name");
    const userRoleEl = document.querySelector(".user-role");
    const userAvatarEl = document.getElementById("navbarUserAvatar");
    const userMenu = document.getElementById("userMenu");
    const userMenuToggle = document.getElementById("userMenuToggle");
    const searchInput = document.querySelector(".search-input");
    const viewsList = document.getElementById("views-list");
    const mobileSidebarToggle = document.getElementById("mobileSidebarToggle");

    if (window.__navbarMounted) return;
    window.__navbarMounted = true;

    async function loadAvatarFromToken(accessToken) {
        if (!accessToken || !userAvatarEl) return false;
        try {
            const appToken = window.auth?.getToken?.() || null;
            const apiBase = window.API_BASE || "";
            if (!appToken || !apiBase) return false;

            const response = await fetch(`${apiBase}/auth/photo`, {
                headers: {
                    Authorization: `Bearer ${appToken}`,
                    "X-Graph-Access-Token": accessToken
                }
            });
            if (!response.ok) return false;

            const data = await response.json();
            if (!data?.hasPhoto || !data?.data) {
                if (!window.__avatarNoPhotoLogged) {
                    console.info(data?.message || "No tiene foto de perfil");
                    window.__avatarNoPhotoLogged = true;
                }
                return false;
            }

            const contentType = String(data.contentType || "image/jpeg");
            userAvatarEl.src = `data:${contentType};base64,${data.data}`;
            return true;
        } catch (e) {
            return false;
        }
    }

    async function loadMicrosoftAvatar() {
        if (!userAvatarEl) return;
        if (window.LOAD_GRAPH_AVATAR !== true) return;

        const storedGraphToken = window.auth?.getGraphToken?.() || null;
        const loadedFromStoredToken = await loadAvatarFromToken(storedGraphToken);
        if (loadedFromStoredToken) return;

        if (!window.msal || !window.msal.PublicClientApplication) return;

        const clientId = window.AZURE_CLIENT_ID;
        const tenantId = window.AZURE_TENANT_ID;
        const redirectUri = `${window.location.origin}${window.AZURE_REDIRECT_PATH || "/auth/callback"}`;
        if (!clientId || !tenantId) return;

        const msalInstance = new window.msal.PublicClientApplication({
            auth: {
                clientId,
                authority: `https://login.microsoftonline.com/${tenantId}`,
                redirectUri,
                navigateToLoginRequestUrl: false
            },
            cache: {
                cacheLocation: "localStorage",
                storeAuthStateInCookie: false
            }
        });

        try {
            await msalInstance.handleRedirectPromise();
        } catch (e) {
            // Ignore callback-handling errors in app shell.
        }

        const account = msalInstance.getAllAccounts?.()[0];
        if (!account) return;

        try {
            const tokenResponse = await msalInstance.acquireTokenSilent({
                account,
                scopes: ["User.Read"]
            });
            await loadAvatarFromToken(tokenResponse.accessToken);
        } catch (e) {
            // Keep fallback avatar when photo is unavailable.
        }
    }

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

    if (viewsList) {
        const allowedViews = getAllowedViewsForCurrentRole();
        viewsList.innerHTML = "";
        allowedViews.forEach((view) => {
            const option = document.createElement("option");
            option.value = view.label;
            viewsList.appendChild(option);
        });
    }

    if (searchInput) {
        searchInput.addEventListener("keypress", function (e) {
            if (e.key === "Enter") {
                performSearch(this.value);
            }
        });
    }

    if (mobileSidebarToggle) {
        mobileSidebarToggle.addEventListener("click", function () {
            const sidebar = document.querySelector(".sidebar");
            if (!sidebar) return;
            const nextOpen = !sidebar.classList.contains("mobile-open");
            sidebar.classList.toggle("mobile-open", nextOpen);
            document.body.classList.toggle("sidebar-mobile-open", nextOpen);
        });
    }

    if (window.auth) {
        const user = window.auth.getUser();
        if (userNameEl && user) userNameEl.textContent = user.nombre_usuario || "Usuario";
        if (userRoleEl && user) userRoleEl.textContent = user.rol || "Usuario";
    }

    loadMicrosoftAvatar();

    if (userMenuToggle && userMenu) {
        userMenuToggle.addEventListener("click", function () {
            userMenu.classList.toggle("open");
        });

        document.addEventListener("click", function (e) {
            if (!userMenu.contains(e.target) && !userMenuToggle.contains(e.target)) {
                userMenu.classList.remove("open");
            }
        });

        userMenu.addEventListener("click", function (e) {
            const action = e.target?.getAttribute("data-action");
            if (!action) return;
            if (action === "logout") {
                if (window.auth) window.auth.clearSession();
                window.location.href = "/login.html";
            } else if (action === "perfil") {
                alert("Perfil: pendiente");
            } else if (action === "contacto") {
                alert("Contacto: pendiente");
            }
            userMenu.classList.remove("open");
        });
    }
}

function performSearch(query) {
    const q = query.trim().toLowerCase();
    if (!q) return;

    const allowedViews = getAllowedViewsForCurrentRole();

    const match = allowedViews.find((v) => v.label.toLowerCase() === q) ||
        allowedViews.find((v) => v.label.toLowerCase().includes(q));

    if (match) {
        window.location.hash = match.hash;
    } else {
        alert("No se encontro esa vista");
    }
}

window.initNavbar = initNavbar;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNavbar);
} else {
    initNavbar();
}
