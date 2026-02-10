// js/login.js
window.authApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    function safeSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // ignore
        }
    }

    function safeGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    const existingToken = safeGet("token");
    if (existingToken) {
        window.location.href = "/index.html#inicio";
    }

    function buildMsalConfig() {
        const clientId = window.AZURE_CLIENT_ID;
        const tenantId = window.AZURE_TENANT_ID;
        const redirectUri = `${window.location.origin}${window.AZURE_REDIRECT_PATH || "/auth/callback"}`;
        if (!clientId || !tenantId) return null;
        return {
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
        };
    }

    function clearMsalInteraction() {
        try {
            sessionStorage.removeItem("msal.interaction.status");
        } catch (e) {
            // ignore
        }
    }

    return {
        loading: false,
        error: "",
        msalInstance: null,

        async init() {
            if (!window.msal || !window.msal.PublicClientApplication) return;
            const config = buildMsalConfig();
            if (!config) return;
            this.msalInstance = new window.msal.PublicClientApplication(config);
            try {
                await this.msalInstance.handleRedirectPromise();
            } catch (e) {
                if (String(e?.errorCode || "").includes("interaction_in_progress")) {
                    clearMsalInteraction();
                }
            }
        },

        async loginMicrosoft() {
            this.loading = true;
            this.error = "";
            try {
                if (!window.msal || !window.msal.PublicClientApplication) {
                    throw new Error("MSAL no estÃ¡ disponible");
                }
                const config = buildMsalConfig();
                if (!config) {
                    throw new Error("Faltan variables de Azure en env.js");
                }
                if (!this.msalInstance) {
                    this.msalInstance = new window.msal.PublicClientApplication(config);
                }
                clearMsalInteraction();
                await this.msalInstance.loginRedirect({
                    scopes: ["User.Read"]
                });
            } catch (e) {
                if (String(e?.errorCode || "").includes("interaction_in_progress")) {
                    this.error = "Hay una sesiÃ³n en progreso. Recarga la pÃ¡gina e intenta de nuevo.";
                } else {
                    this.error = e.message || "Error iniciando sesiÃ³n";
                }
                this.loading = false;
            }
        }
    };
};
