window.roleAccess = (function () {
    const roleRoutes = {
        admin: [
            "inicio",
            "cliente",
            "permisos-coordinador",
            "asignacion-coordinador",
            "asociar-subconsultores",
            "tarifas",
            "solicitudesCoord",
            "preregistrosCoord",
            "solicitudesRecl",
            "onboardingTH",
            "anexoTecnicoIndividual",
            "soportes-cuentas-cobro",
            "catalogos-admin",
            "gestion-licencias-admin",
            "azure-devops-prueba",
            "capacidad-fabrica",
            "firma-contratos-admin",
            "temp-crear-usuarios",
            "aprobar-rechazar-coordinador",
            "asignacion-consultor"
        ],
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
            "capacidad-fabrica",
            "azure-devops-prueba"
        ],
        fabrica: ["inicio"],
        comercial: [
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
        talento_humano: ["inicio", "onboardingTH", "anexoTecnicoIndividual", "soportes-cuentas-cobro", "firma-contratos-admin", "temp-crear-usuarios", "capacidad-fabrica"]
    };

    const searchViews = [
        { label: "Inicio", hash: "#inicio" },
        { label: "Clientes", hash: "#cliente" },
        { label: "Tarifas", hash: "#tarifas" },
        { label: "Asignacion Coordinador", hash: "#asignacion-coordinador" },
        { label: "Permisos Coordinador", hash: "#permisos-coordinador" },
        { label: "Asociar Subconsultores", hash: "#asociar-subconsultores" },
        { label: "Asignacion Consultor", hash: "#asignacion-consultor" },
        { label: "Mis Asignaciones", hash: "#mis-asignaciones-coordinador" },
        { label: "Mis Asignaciones Consultor", hash: "#mis-asignaciones-consultor" },
        { label: "Fabrica Mesa Servicio", hash: "#asignacion-fabrica-mesa-servicio" },
        { label: "Registro Horas Consultor", hash: "#registro-horas-consultor" },
        { label: "Aprobar/Rechazar", hash: "#aprobar-rechazar-coordinador" },
        { label: "Mis Cuentas Cobros", hash: "#mis-cuentas-cobros" },
        { label: "Soportes Cuentas Cobro", hash: "#soportes-cuentas-cobro" },
        { label: "Generar Cuenta Cobro", hash: "#generar-cuenta-cobro" },
        { label: "Catalogos Admin", hash: "#catalogos-admin" },
        { label: "Licencias de Acceso", hash: "#gestion-licencias-admin" },
        { label: "Azure historial", hash: "#azure-devops-prueba" },
        { label: "Capacidad de Fabrica", hash: "#capacidad-fabrica" },
        { label: "Solicitudes RRHH", hash: "#solicitudesCoord" },
        { label: "Contrataciones", hash: "#preregistrosCoord" },
        { label: "Pool de Solicitudes", hash: "#solicitudesRecl" },
        { label: "Contrataciones TH", hash: "#onboardingTH" },
        { label: "Anexo tecnico individual", hash: "#anexoTecnicoIndividual" },
        { label: "Firma de Contratos", hash: "#firma-contratos-admin" },
        { label: "Crear Usuarios Temp.", hash: "#temp-crear-usuarios" }
    ];

    function getRoleRoutes() {
        return roleRoutes;
    }

    function getAllowedRoutesForRole(roleKey) {
        return roleRoutes[roleKey] || ["inicio"];
    }

    function getAllowedRoutesForCurrentRole() {
        const roleKey = window.auth?.getRoleKey?.() || "other";
        return getAllowedRoutesForRole(roleKey);
    }

    function getAllSearchViews() {
        return searchViews;
    }

    function getAllowedViewsForCurrentRole() {
        const allowed = new Set(getAllowedRoutesForCurrentRole());
        return searchViews.filter((view) => allowed.has(view.hash.replace("#", "")));
    }

    return {
        getRoleRoutes,
        getAllowedRoutesForRole,
        getAllowedRoutesForCurrentRole,
        getAllSearchViews,
        getAllowedViewsForCurrentRole
    };
})();
