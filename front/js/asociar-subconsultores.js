// js/asociar-subconsultores.js
window.subConsultoresApp = function () {
    return {
        API: window.API_BASE || "http://localhost:4000",
        principales: [],
        principalSeleccionado: null,
        asociados: [],
        disponibles: [],
        modal: { open: false },
        seleccionadoId: "",
        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token
                ? { headers: { Authorization: `Bearer ${token}` } }
                : null;
        },

        async init() {
            const authConfig = this.getAuthConfig();
            if (!authConfig) {
                window.location.href = "/login.html";
                return;
            }
            await this.cargarPrincipales();
            if (this.principales.length > 0) {
                this.seleccionarPrincipal(this.principales[0]);
            }
        },

        async cargarPrincipales() {
            try {
                const res = await axios.get(`${this.API}/consultores/principales`, this.getAuthConfig());
                this.principales = res.data || [];
            } catch (e) {
                this.principales = [];
                console.error(e);
            }
        },

        async seleccionarPrincipal(p) {
            this.principalSeleccionado = p;
            await this.cargarAsociados();
        },

        async cargarAsociados() {
            if (!this.principalSeleccionado) return;
            try {
                const res = await axios.get(
                    `${this.API}/sub-consultores/${this.principalSeleccionado.id}`,
                    this.getAuthConfig()
                );
                this.asociados = res.data || [];
            } catch (e) {
                this.asociados = [];
                console.error(e);
            }
        },

        async abrirModal() {
            this.modal.open = true;
            this.seleccionadoId = "";
            await this.cargarDisponibles();
        },

        async cargarDisponibles() {
            if (!this.principalSeleccionado) return;
            try {
                const res = await axios.get(
                    `${this.API}/sub-consultores/disponibles/${this.principalSeleccionado.id}`,
                    this.getAuthConfig()
                );
                this.disponibles = res.data || [];
            } catch (e) {
                this.disponibles = [];
                console.error(e);
            }
        },

        async asociar() {
            if (!this.principalSeleccionado || !this.seleccionadoId) return;
            try {
                await axios.post(`${this.API}/sub-consultores/asociar`, {
                    principal_id: this.principalSeleccionado.id,
                    asociado_id: this.seleccionadoId
                }, this.getAuthConfig());
                this.modal.open = false;
                await this.cargarAsociados();
            } catch (e) {
                alert("Error al asociar");
            }
        },

        async eliminar(c) {
            if (!this.principalSeleccionado) return;
            if (!confirm(`¿Desvincular a ${c.nombre_usuario}?`)) return;
            try {
                await axios.delete(`${this.API}/sub-consultores/${c.id}`, {
                    ...(this.getAuthConfig() || {}),
                    data: { principal_id: this.principalSeleccionado.id }
                });
                await this.cargarAsociados();
            } catch (e) {
                alert("Error al desvincular");
            }
        }
    };
};
