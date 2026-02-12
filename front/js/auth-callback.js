// js/auth-callback.js
(function () {
    const API = window.API_BASE || "http://localhost:4000";
    const clientId = window.AZURE_CLIENT_ID;
    const tenantId = window.AZURE_TENANT_ID;
    const redirectUri = `${window.location.origin}${window.AZURE_REDIRECT_PATH || "/auth/callback"}`;
    const graphScopes = ["openid", "profile", "email", "User.Read", "Mail.Send"];

    function setError(msg) {
        const title = document.getElementById("auth-title");
        const text = document.getElementById("auth-msg");
        const err = document.getElementById("auth-error");
        if (title) title.textContent = "No pudimos iniciar sesión";
        if (text) text.textContent = "Revisa el error y vuelve a intentarlo.";
        if (err) {
            err.textContent = msg;
            err.classList.remove("hidden");
        }
    }

    async function run() {
        if (!window.msal || !window.msal.PublicClientApplication) {
            console.error("MSAL no está disponible");
            setError("MSAL no está disponible");
            return;
        }
        if (!clientId || !tenantId) {
            console.error("Faltan variables de Azure en env.js");
            setError("Faltan variables de Azure en env.js");
            return;
        }

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
            const response = await msalInstance.handleRedirectPromise();
            const account = response?.account || msalInstance.getAllAccounts()[0];
            if (!account) {
                setError("No se encontró una cuenta activa en MSAL.");
                return;
            }

            const accessToken =
                response?.accessToken ||
                (await msalInstance.acquireTokenSilent({
                    scopes: graphScopes,
                    account
                })).accessToken;

            if (!accessToken) {
                throw new Error("No se pudo obtener access_token de Microsoft");
            }

            const res = await axios.post(`${API}/auth/microsoft`, {
                access_token: accessToken
            });

            const data = res.data || {};
            if (data.token && data.user && window.auth?.setSession) {
                window.auth.setSession(data.token, data.user, accessToken);
            } else {
                localStorage.setItem("token", data.token);
                localStorage.setItem("user", JSON.stringify(data.user || {}));
                localStorage.setItem("graph_access_token", accessToken);
            }
            window.location.href = "/index.html#inicio";
        } catch (err) {
            const msg =
                err?.response?.data?.error ||
                err?.message ||
                "Error desconocido";
            console.error("Error en callback:", {
                status: err?.response?.status,
                data: err?.response?.data,
                message: err?.message
            });
            setError(msg);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run);
    } else {
        run();
    }
})();
