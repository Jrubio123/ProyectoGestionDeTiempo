// js/auth.js
window.auth = (function () {
    const TOKEN_KEY = "token";
    const USER_KEY = "user";

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

    async function hydrateUser() {
        const token = getToken();
        if (!token || !window.axios) return null;
        window.axios.defaults.headers.common.Authorization = `Bearer ${token}`;
        try {
            const res = await window.axios.get("http://localhost:4000/auth/me");
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
        setSession,
        clearSession,
        isAuthenticated,
        hydrateUser,
        requireAuth
    };
})();

// Protect SPA routes by default.
document.addEventListener("DOMContentLoaded", () => {
    if (window.location.pathname.endsWith("/index.html") || window.location.pathname === "/" || window.location.pathname === "") {
        window.auth.requireAuth();
    }
});
