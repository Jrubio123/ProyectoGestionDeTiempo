// js/auth.js
window.auth = (function () {
    const TOKEN_KEY = "token";
    const USER_KEY = "user";
    const API_BASE = window.API_BASE || "http://localhost:4000";

    function safeGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function safeSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // Storage might be blocked.
        }
    }

    function safeRemove(key) {
        try {
            localStorage.removeItem(key);
        } catch (e) {
            // ignore
        }
    }

    function getToken() {
        return safeGet(TOKEN_KEY);
    }

    function getUser() {
        const raw = safeGet(USER_KEY);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    function setSession(token, user) {
        if (token) safeSet(TOKEN_KEY, token);
        if (user) safeSet(USER_KEY, JSON.stringify(user));
        if (window.axios && token) {
            window.axios.defaults.headers.common.Authorization = `Bearer ${token}`;
        }
    }

    function clearSession() {
        safeRemove(TOKEN_KEY);
        safeRemove(USER_KEY);
        if (window.axios) {
            delete window.axios.defaults.headers.common.Authorization;
        }
    }

    function isAuthenticated() {
        return !!getToken();
    }

    function isAsociado() {
        const user = getUser();
        return String(user?.tipo_consultor || "").toLowerCase() === "asociado";
    }

    function getRoleKey() {
        const user = getUser();
        const rol = String(user?.rol || "").toLowerCase().trim();
        const tipoConsultor = String(user?.tipo_consultor || "").toLowerCase().trim();

        if (rol === "administrador") return "admin";
        if (rol === "coordinador") return "coordinador";
        if (tipoConsultor === "asociado") return "consultor_asociado";
        if (rol === "consultor principal" || rol === "consultor" || rol === "mesa de servicio") {
            return "consultor_principal";
        }
        return "other";
    }

    async function hydrateUser() {
        const token = getToken();
        if (!token || !window.axios) return null;
        window.axios.defaults.headers.common.Authorization = `Bearer ${token}`;
        try {
            const res = await window.axios.get(`${API_BASE}/auth/me`);
            if (res?.data?.user) {
                safeSet(USER_KEY, JSON.stringify(res.data.user));
                return res.data.user;
            }
        } catch (e) {
            clearSession();
        }
        return null;
    }

    async function requireAuth() {
        if (!isAuthenticated()) {
            window.location.href = "/login.html";
            return false;
        }
        await hydrateUser();
        return true;
    }

    return {
        getToken,
        getUser,
        isAsociado,
        getRoleKey,
        setSession,
        clearSession,
        isAuthenticated,
        hydrateUser,
        requireAuth
    };
})();

// Ensure axios always sends token when available.
function setupAxiosAuth() {
    if (!window.axios || window.__authAxiosReady) return;
    window.__authAxiosReady = true;
    const token = window.auth?.getToken?.();
    if (token) {
        window.axios.defaults.headers.common.Authorization = `Bearer ${token}`;
    }
    window.axios.interceptors.request.use((config) => {
        const t = window.auth?.getToken?.();
        if (t) {
            config.headers = config.headers || {};
            config.headers.Authorization = `Bearer ${t}`;
        }
        return config;
    });
}

setupAxiosAuth();
document.addEventListener("DOMContentLoaded", setupAxiosAuth);

// Protect SPA routes by default.
document.addEventListener("DOMContentLoaded", () => {
    if (window.location.pathname.endsWith("/index.html") || window.location.pathname === "/" || window.location.pathname === "") {
        window.auth.requireAuth();
    }
});
