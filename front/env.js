(function () {
    const config = {
        mode: "local",
        api_local: "http://localhost:4000",
        api_tunnel: "https://fxlgp5hf-4000.use2.devtunnels.ms"
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

    const apiFromMode =
        mode === "tunnel" && config.api_tunnel
            ? config.api_tunnel
            : config.api_local;

    window.APP_MODE = mode;
    window.API_BASE = apiParam || apiFromMode;
})();
