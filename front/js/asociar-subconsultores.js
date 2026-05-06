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
        terminoBusqueda: "",
        resultadosBusqueda: [],
        busquedaLoading: false,
        busquedaAbierta: false,
        busquedaTimer: null,
        busquedaSeq: 0,
        asociadoResaltadoId: "",
        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token
                ? { headers: { Authorization: `Bearer ${token}` } }
                : null;
        },

        get mostrarResultadosBusqueda() {
            const termino = (this.terminoBusqueda || "").trim();
            return this.busquedaAbierta && termino.length >= 2;
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

        programarBusqueda() {
            const termino = (this.terminoBusqueda || "").trim();
            clearTimeout(this.busquedaTimer);
            this.busquedaAbierta = true;

            if (termino.length < 2) {
                this.resultadosBusqueda = [];
                this.busquedaLoading = false;
                this.busquedaSeq += 1;
                return;
            }

            const seq = this.busquedaSeq + 1;
            this.busquedaSeq = seq;
            this.busquedaLoading = true;
            this.busquedaTimer = setTimeout(() => {
                this.buscarConsultores(termino, seq);
            }, 300);
        },

        async buscarConsultores(termino, seq) {
            this.busquedaLoading = true;

            try {
                const authConfig = this.getAuthConfig();
                const res = await axios.get(`${this.API}/consultores/buscar`, {
                    ...(authConfig || {}),
                    params: { q: termino }
                });

                if (seq !== this.busquedaSeq || termino !== (this.terminoBusqueda || "").trim()) return;
                this.resultadosBusqueda = res.data || [];
            } catch (e) {
                if (seq === this.busquedaSeq) this.resultadosBusqueda = [];
                console.error(e);
            } finally {
                if (seq === this.busquedaSeq) this.busquedaLoading = false;
            }
        },

        abrirResultadosBusqueda() {
            if ((this.terminoBusqueda || "").trim().length >= 2) {
                this.busquedaAbierta = true;
            }
        },

        cerrarBusqueda() {
            this.busquedaAbierta = false;
        },

        limpiarBusqueda() {
            clearTimeout(this.busquedaTimer);
            this.terminoBusqueda = "";
            this.resultadosBusqueda = [];
            this.busquedaLoading = false;
            this.busquedaAbierta = false;
            this.busquedaSeq += 1;
        },

        async seleccionarResultadoBusqueda(item) {
            if (!item) return;
            this.limpiarBusqueda();

            if (item.tipo === "asociado") {
                if (!item.principal_id) return;
                let principal = this.principales.find((p) => p.id === item.principal_id);
                if (!principal) {
                    principal = {
                        id: item.principal_id,
                        nombre_usuario: item.principal_nombre || "Principal",
                        email: item.principal_email || ""
                    };
                    this.principales = [principal, ...this.principales];
                }

                await this.seleccionarPrincipal(principal);
                this.asociadoResaltadoId = item.id;
                setTimeout(() => {
                    if (this.asociadoResaltadoId === item.id) this.asociadoResaltadoId = "";
                }, 2500);
                return;
            }

            let principal = this.principales.find((p) => p.id === item.id);
            if (!principal) {
                principal = {
                    id: item.id,
                    nombre_usuario: item.nombre_usuario,
                    email: item.email
                };
                this.principales = [principal, ...this.principales];
            }

            await this.seleccionarPrincipal(principal);
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
