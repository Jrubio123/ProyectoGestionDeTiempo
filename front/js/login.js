// js/login.js
window.authApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const graphScopes = ["openid", "profile", "email", "User.Read", "Mail.Send"];
    const SAVED_USERS_KEY = "LOCAL_LOGIN_USERS";
    const isLocalMode = String(window.APP_MODE || "").toLowerCase() === "local";
    const forceSwitch =
        window.location.search.includes("switch=1") ||
        window.location.search.includes("forceLogin=1");
    const isCallback =
        window.location.pathname.includes("/auth/callback") ||
        window.location.search.includes("code=") ||
        window.location.hash.includes("code=");

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

    function getSavedUsers() {
        try {
            const raw = localStorage.getItem(SAVED_USERS_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return [];
            return parsed
                .map((email) => String(email || "").trim().toLowerCase())
                .filter(Boolean)
                .slice(0, 8);
        } catch (e) {
            return [];
        }
    }

    function saveUserEmail(email) {
        const normalized = String(email || "").trim().toLowerCase();
        if (!normalized) return;
        const users = getSavedUsers().filter((u) => u !== normalized);
        users.unshift(normalized);
        safeSet(SAVED_USERS_KEY, JSON.stringify(users.slice(0, 8)));
    }

    function removeUserEmail(email) {
        const normalized = String(email || "").trim().toLowerCase();
        if (!normalized) return getSavedUsers();
        const users = getSavedUsers().filter((u) => u !== normalized);
        safeSet(SAVED_USERS_KEY, JSON.stringify(users));
        return users;
    }

    const existingToken = safeGet("token");
    if (forceSwitch && window.auth?.clearSession) {
        window.auth.clearSession();
    }
    if (existingToken && !isCallback && !forceSwitch) {
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
        email: "",
        password: "",
        isLocalMode,
        savedUsers: [],
        msalInstance: null,

        async init() {
            if (isCallback) return;
            this.savedUsers = getSavedUsers();

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
                    throw new Error("MSAL no está disponible");
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
                    scopes: graphScopes
                });
            } catch (e) {
                if (String(e?.errorCode || "").includes("interaction_in_progress")) {
                    this.error = "Hay una sesión en progreso. Recarga la página e intenta de nuevo.";
                } else {
                    this.error = e.message || "Error iniciando sesión";
                }
                this.loading = false;
            }
        },

        usarUsuarioGuardado(email) {
            this.email = email || "";
            this.error = "";
        },

        eliminarUsuarioGuardado(email) {
            this.savedUsers = removeUserEmail(email);
            if (this.email === email) this.email = "";
        },

        async loginLocal() {
            this.loading = true;
            this.error = "";
            try {
                const email = String(this.email || "").trim().toLowerCase();
                const password = String(this.password || "");
                if (!email || !password) {
                    throw new Error("Correo y contraseña son obligatorios");
                }

                const res = await axios.post(`${API}/auth/login`, { email, password });
                const data = res.data || {};
                if (!data.token || !data.user) {
                    throw new Error("Respuesta de autenticación inválida");
                }

                if (window.auth?.setSession) {
                    window.auth.setSession(data.token, data.user, null);
                } else {
                    safeSet("token", data.token);
                    safeSet("user", JSON.stringify(data.user || {}));
                }

                saveUserEmail(email);
                this.savedUsers = getSavedUsers();
                this.password = "";
                window.location.href = "/index.html#inicio";
            } catch (e) {
                this.error = e?.response?.data?.error || e?.message || "Error iniciando sesión";
                this.loading = false;
            }
        }
    };
};
