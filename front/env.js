(function () {
    const config = {
        mode: "auto",
        api_local: "http://localhost:4000",
        api_container: "",
        api_tunnel: "https://d053flnv-4000.use.devtunnels.ms",
        api_prod: "https://proyectogestiondetiempo.onrender.com",
        azure_tenant_id: "9c6fde39-4030-44e7-aeb7-c6c97aa49ba4",
        azure_client_id: "8544473b-8df2-49c7-8916-264a0b4cbc6b",
        azure_redirect_path: "/auth/callback"
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
            // ignore storage errors
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

    const inferredMode = host.includes("azurestaticapps.net")
        ? "prod"
        : (isLocalHost ? "local" : null);

    const localSafeStoredMode = isLocalHost && storedMode === "prod" ? null : storedMode;
    let mode = modeParam || localSafeStoredMode || inferredMode || config.mode;
    if (mode === "auto") {
        mode = inferredMode || "local";
    }

    if (modeParam) setSafe("APP_MODE", modeParam);
    if (apiParam) setSafe("APP_API_BASE", apiParam);

    const sameHostApi =
        host && !host.includes("azurestaticapps.net")
            ? `${window.location.protocol}//${host}:4000`
            : config.api_local;

    let apiFromMode = config.api_local || sameHostApi;
    if (mode === "local" && config.api_container) apiFromMode = config.api_container;
    if (mode === "local" && sameHostApi) apiFromMode = sameHostApi;
    if (mode === "tunnel" && config.api_tunnel) apiFromMode = config.api_tunnel;
    if (mode === "prod" && config.api_prod) apiFromMode = config.api_prod;

    window.APP_MODE = mode;
    window.API_BASE = apiParam || storedApi || apiFromMode;
    window.AZURE_TENANT_ID = config.azure_tenant_id;
    window.AZURE_CLIENT_ID = config.azure_client_id;
    window.AZURE_REDIRECT_PATH = config.azure_redirect_path;

    window.setApiBase = function (apiBase) {
        if (!apiBase) return;
        setSafe("APP_API_BASE", String(apiBase));
        window.API_BASE = String(apiBase);
    };
})();
