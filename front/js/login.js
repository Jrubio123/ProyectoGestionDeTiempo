// js/login.js
window.authApp = function () {
    const API = "http://localhost:4000";

    function safeSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // Storage might be blocked.
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

    return {
        isLogin: true,
        showPass: false,
        loading: false,
        error: "",
        form: {
            nombre: "",
            email: "",
            password: ""
        },

        toggleMode() {
            this.isLogin = !this.isLogin;
            this.error = "";
            this.form = { nombre: "", email: "", password: "" };
        },

        async submit() {
            this.loading = true;
            this.error = "";

            const endpoint = this.isLogin ? "/auth/login" : "/auth/register";
            const payload = this.isLogin
                ? { email: this.form.email, password: this.form.password }
                : {
                      nombre_usuario: this.form.nombre,
                      email: this.form.email,
                      password: this.form.password
                  };

            try {
                const res = await fetch(API + endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error || "Error en la solicitud");

                if (this.isLogin) {
                    safeSet("token", data.token);
                    safeSet("user", JSON.stringify(data.user));
                    window.location.href = "/index.html#inicio";
                } else {
                    alert("Cuenta creada exitosamente. Por favor inicia sesión.");
                    this.toggleMode();
                    this.form.email = payload.email;
                }
            } catch (e) {
                this.error = e.message;
            } finally {
                this.loading = false;
            }
        }
    };
};
