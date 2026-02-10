(function () {
    const config = {
        mode: "local",
        api_local: "http://localhost:4000",
        api_tunnel: "https://d053flnv-4000.use.devtunnels.ms",
        api_prod: "https://appgestion-dwdqd8hhbpfva5ea.brazilsouth-01.azurewebsites.net",
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
    const mode = modeParam || storedMode || config.mode;
    if (modeParam) setSafe("APP_MODE", modeParam);

    let apiFromMode = config.api_local;
    if (mode === "tunnel" && config.api_tunnel) apiFromMode = config.api_tunnel;
    if (mode === "prod" && config.api_prod) apiFromMode = config.api_prod;

    window.APP_MODE = mode;
    window.API_BASE = apiParam || apiFromMode;
    window.AZURE_TENANT_ID = config.azure_tenant_id;
    window.AZURE_CLIENT_ID = config.azure_client_id;
    window.AZURE_REDIRECT_PATH = config.azure_redirect_path;
})();
