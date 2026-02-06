// js/asignacion-coordinador.js
window.asignacionCoordApp = function () {
    const API = "http://localhost:4000";

    return {
        cat: {
            clientes: [],
            coordinadores: [],
            tipos: []
        },

        asignaciones: [],

        form: {
            id: null,
            cliente_id: "",
            coordinador_id: "",
            tipo_asignacion_id: "",
            descripcion_consultoria: ""
        },

        formDisplay: {
            cliente: "",
            coordinador: "",
            tipo: ""
        },

        filters: { cliente: "", coordinador: "", tipo: "" },
        errors: { duplicado: false },

        async init() {
            await Promise.all([this.cargarCatalogos(), this.cargarDatos()]);
        },

        async cargarCatalogos() {
            try {
                const [resCli, resCoord, resTipos] = await Promise.all([
                    axios.get(`${API}/clientes`),
                    axios.get(`${API}/coordinadores`),
                    axios.get(`${API}/tipos-asignacion`)
                ]);

                this.cat.clientes = resCli.data || [];
                this.cat.coordinadores = resCoord.data || [];
                this.cat.tipos = resTipos.data || [];
            } catch (e) {
                console.error("Error cargando catálogos", e);
                this.cat.clientes = [];
                this.cat.coordinadores = [];
                this.cat.tipos = [];
            }
        },

        async cargarDatos() {
            try {
                const res = await axios.get(`${API}/consultorias`);
                this.asignaciones = res.data || [];
            } catch (e) {
                this.asignaciones = [];
            }
        },

        setClienteId() {
            const q = this.formDisplay.cliente.trim().toLowerCase();
            const match = this.cat.clientes.find(
                (c) => String(c.titulo || "").toLowerCase() === q
            );
            this.form.cliente_id = match ? match.id : "";
            this.validarDuplicado();
        },

        setCoordinadorId() {
            const q = this.formDisplay.coordinador.trim().toLowerCase();
            const match = this.cat.coordinadores.find(
                (u) => String(u.nombre || "").toLowerCase() === q
            );
            this.form.coordinador_id = match ? match.id : "";
            this.validarDuplicado();
        },

        setTipoId() {
            const q = this.formDisplay.tipo.trim().toLowerCase();
            const match = this.cat.tipos.find(
                (t) => String(t.titulo || "").toLowerCase() === q
            );
            this.form.tipo_asignacion_id = match ? match.id : "";
            this.validarDuplicado();
        },

        validarDuplicado() {
            if (!this.form.cliente_id || !this.form.coordinador_id || !this.form.tipo_asignacion_id) {
                this.errors.duplicado = false;
                return;
            }

            const existe = this.asignaciones.some(
                (a) =>
                    a.cliente_id == this.form.cliente_id &&
                    a.coordinador_id == this.form.coordinador_id &&
                    a.tipo_asignacion_id == this.form.tipo_asignacion_id &&
                    a.id !== this.form.id
            );
            this.errors.duplicado = existe;
        },

        get formValido() {
            return this.form.cliente_id && this.form.coordinador_id && this.form.tipo_asignacion_id;
        },

        get filtrados() {
            const qCliente = this.filters.cliente.trim().toLowerCase();
            const qCoord = this.filters.coordinador.trim().toLowerCase();
            const qTipo = this.filters.tipo.trim().toLowerCase();
            return this.asignaciones.filter((a) => {
                const nombreCliente = String(a.nombre_cliente || "").toLowerCase();
                const nombreCoord = String(a.nombre_coordinador || "").toLowerCase();
                const nombreTipo = String(a.tipo_asignacion || "").toLowerCase();
                const matchCli = qCliente ? nombreCliente.includes(qCliente) : true;
                const matchCoord = qCoord ? nombreCoord.includes(qCoord) : true;
                const matchTipo = qTipo ? nombreTipo.includes(qTipo) : true;
                return matchCli && matchCoord && matchTipo;
            });
        },

        limpiarFormulario() {
            this.form = {
                id: null,
                cliente_id: "",
                coordinador_id: "",
                tipo_asignacion_id: "",
                descripcion_consultoria: ""
            };
            this.formDisplay = { cliente: "", coordinador: "", tipo: "" };
            this.errors.duplicado = false;
        },

        editar(item) {
            this.form = {
                id: item.id,
                cliente_id: item.cliente_id,
                coordinador_id: item.coordinador_id,
                tipo_asignacion_id: item.tipo_asignacion_id,
                descripcion_consultoria: item.descripcion_consultoria || ""
            };
            this.formDisplay = {
                cliente: item.nombre_cliente || "",
                coordinador: item.nombre_coordinador || "",
                tipo: item.tipo_asignacion || ""
            };
            this.errors.duplicado = false;
        },

        async guardar() {
            try {
                const method = this.form.id ? "put" : "post";
                const url = this.form.id
                    ? `${API}/consultorias/${this.form.id}`
                    : `${API}/consultorias`;

                await axios[method](url, this.form);

                alert("Guardado correctamente");
                this.limpiarFormulario();
                await this.cargarDatos();
            } catch (e) {
                alert("Error: " + (e.response?.data?.error || "Error al guardar"));
            }
        },

        async eliminar(id) {
            if (!confirm("¿Eliminar asignación?")) return;
            try {
                await axios.delete(`${API}/consultorias/${id}`);
                await this.cargarDatos();
            } catch (e) {
                alert("Error al eliminar");
            }
        }
    };
};
