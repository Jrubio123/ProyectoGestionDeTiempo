// js/auth-callback.js
(function () {
    const API = window.API_BASE || "http://localhost:4000";
    const clientId = window.AZURE_CLIENT_ID;
    const tenantId = window.AZURE_TENANT_ID;
    const redirectUri = `${window.location.origin}${window.AZURE_REDIRECT_PATH || "/auth/callback"}`;

    async function run() {
        if (!window.msal || !window.msal.PublicClientApplication) {
            console.error("MSAL no estÃ¡ disponible");
            return;
        }
        if (!clientId || !tenantId) {
            console.error("Faltan variables de Azure en env.js");
            return;
        }

        const msalInstance = new window.msal.PublicClientApplication({
            auth: {
                clientId,
                authority: `https://login.microsoftonline.com/${tenantId}`,
                redirectUri
            },
            cache: {
                cacheLocation: "localStorage",
                storeAuthStateInCookie: false
            }
        });

        try {
            const response = await msalInstance.handleRedirectPromise();
            const account = response?.account || msalInstance.getAllAccounts()[0];
            if (!account) {
                window.location.href = "/login.html";
                return;
            }

            const tokenResp = await msalInstance.acquireTokenSilent({
                scopes: ["User.Read"],
                account
            });

            const res = await axios.post(`${API}/auth/microsoft`, {
                access_token: tokenResp.accessToken
            });

            const data = res.data || {};
            if (data.token && data.user && window.auth?.setSession) {
                window.auth.setSession(data.token, data.user);
            } else {
                localStorage.setItem("token", data.token);
                localStorage.setItem("user", JSON.stringify(data.user || {}));
            }
            window.location.href = "/index.html#inicio";
        } catch (err) {
            console.error("Error en callback:", err);
            window.location.href = "/login.html?error=ms";
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run);
    } else {
        run();
    }
})();
