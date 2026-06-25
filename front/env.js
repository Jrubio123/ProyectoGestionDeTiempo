(function () {
    const config = {
        mode: "auto",
        api_local: "http://localhost:4000",
        api_container: "",
        api_tunnel: "https://d053flnv-4000.use.devtunnels.ms",
        api_test: "https://proyectogestiondetiempo.onrender.com",
        api_prod: "https://backapp-eghxaxfafuecc2dr.westus-01.azurewebsites.net",
        test_front_hosts: [
            "lively-sky-00d667a0f.4.azurestaticapps.net"
        ],
        azure_tenant_id: "9c6fde39-4030-44e7-aeb7-c6c97aa49ba4",
        azure_client_id: "8544473b-8df2-49c7-8916-264a0b4cbc6b",
        azure_redirect_path: "/auth/callback"
    };

    const normalizeApiBase = (value) => {
        const raw = String(value || "").trim();
        if (!raw) return "";

        if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
        if (raw.startsWith("//")) return `${window.location.protocol}${raw}`.replace(/\/+$/, "");
        if (raw.startsWith("/")) return `${window.location.origin}${raw}`.replace(/\/+$/, "");

        if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(raw)) {
            return `https://${raw}`.replace(/\/+$/, "");
        }

        return raw.replace(/\/+$/, "");
    };

    const getSafe = (key) => {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    };

    const setSafe = (key, value) => {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
        }
    };

    const params = new URLSearchParams(window.location.search);
    const modeParam = params.get("mode");
    const apiParam = params.get("api");

    const storedMode = getSafe("APP_MODE");
    const storedApi = getSafe("APP_API_BASE");
    const host = window.location.hostname || "";
    const isLocalHost =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host.endsWith(".local") ||
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host);

    const isKnownTestFront = (config.test_front_hosts || []).includes(host);
    const isAzureStaticHost = host.includes("azurestaticapps.net");
    const isProdHost = isAzureStaticHost && !isKnownTestFront;
    const inferredMode = isKnownTestFront
        ? "test"
        : isProdHost
            ? "prod"
            : (isLocalHost ? "local" : null);

    const localSafeStoredMode = isLocalHost && storedMode === "prod" ? null : storedMode;
    const storedModeCandidate = (isProdHost || isKnownTestFront) ? null : localSafeStoredMode;
    let mode = modeParam || inferredMode || storedModeCandidate || config.mode;
    if (mode === "auto") {
        mode = inferredMode || (isProdHost ? "prod" : "local");
    }
    if (isProdHost && !modeParam) mode = "prod";
    if (isKnownTestFront && !modeParam) mode = "test";

    if (modeParam) setSafe("APP_MODE", modeParam);
    if (apiParam) setSafe("APP_API_BASE", normalizeApiBase(apiParam));
    if ((isProdHost || isKnownTestFront) && !modeParam) {
        setSafe("APP_MODE", mode);
    }

    const sameHostApi =
        host && !host.includes("azurestaticapps.net")
            ? `${window.location.protocol}//${host}:4000`
            : config.api_local;

    let apiFromMode = config.api_local || sameHostApi;
    if (mode === "local" && config.api_container) apiFromMode = config.api_container;
    if (mode === "local" && sameHostApi) apiFromMode = sameHostApi;
    if (mode === "tunnel" && config.api_tunnel) apiFromMode = config.api_tunnel;
    if (mode === "test" && config.api_test) apiFromMode = config.api_test;
    if (mode === "prod" && config.api_prod) apiFromMode = config.api_prod;

    const shouldIgnoreStoredApi = isKnownTestFront && !apiParam;
    if (shouldIgnoreStoredApi && config.api_test) {
        setSafe("APP_API_BASE", normalizeApiBase(config.api_test));
    }

    window.APP_MODE = mode;
    window.APP_IS_PROD = mode === "prod";
    window.APP_IS_TEST = mode === "test";
    window.API_BASE = normalizeApiBase(apiParam || (shouldIgnoreStoredApi ? "" : storedApi) || apiFromMode);
    window.AZURE_TENANT_ID = config.azure_tenant_id;
    window.AZURE_CLIENT_ID = config.azure_client_id;
    window.AZURE_REDIRECT_PATH = config.azure_redirect_path;
    window.LOAD_GRAPH_AVATAR = true;

    window.setApiBase = function (apiBase) {
        if (!apiBase) return;
        const normalized = normalizeApiBase(apiBase);
        setSafe("APP_API_BASE", normalized);
        window.API_BASE = normalized;
    };
})();
