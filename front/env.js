(function () {
    const config = {
        mode: "prod",
        api_local: "http://localhost:4000",
        api_tunnel: "https://d053flnv-4000.use.devtunnels.ms",
        api_prod: "https://appgestion-dwdqd8hhbpfva5ea.brazilsouth-01.azurewebsites.net"
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
})();
