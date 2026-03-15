// js/tarifas.js
window.tarifasApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },
        cat: {
            clientes: [],
            consultores: [],
            modulos: [],
            tipos: []
        },
        tarifas: [],
        filters: { cliente: "", consultor: "" },
        form: {
            id: null,
            cliente_id: "",
            consultor_id: "",
            modulo_id: "",
            tipo_asignacion_id: "",
            valor: ""
        },
        formDisplay: {
            cliente: "",
            consultor: "",
            modulo: "",
            tipo: ""
        },
        errors: { duplicado: false },
        monedaSymbol: "$",

        async init() {
            if (!this.getAuthConfig()) {
                window.location.href = "/login.html";
                return;
            }
            await Promise.all([
                this.cargarCatalogos(),
                this.cargarDatos()
            ]);
        },

        async cargarCatalogos() {
            try {
                const [resClientes, resConsultores, resModulos, resTipos] = await Promise.all([
                    axios.get(`${API}/clientes`, this.getAuthConfig()),
                    axios.get(`${API}/consultores`, this.getAuthConfig()),
                    axios.get(`${API}/modulos`, this.getAuthConfig()),
                    axios.get(`${API}/tipos-asignacion`, this.getAuthConfig())
                ]);

                this.cat.clientes = resClientes.data || [];
                this.cat.consultores = resConsultores.data || [];
                this.cat.modulos = resModulos.data || [];
                this.cat.tipos = resTipos.data || [];
            } catch (e) {
                this.cat.clientes = [];
                this.cat.consultores = [];
                this.cat.modulos = [];
                this.cat.tipos = [];
            }
        },

        async cargarDatos() {
            try {
                const res = await axios.get(`${API}/tarifas`, this.getAuthConfig());
                this.tarifas = res.data || [];
            } catch (e) {
                this.tarifas = [];
            }
        },

        cambiarMoneda() {
            const consultor = this.cat.consultores.find(
                (c) => c.id == this.form.consultor_id
            );
            if (consultor && consultor.moneda === "Dólar") {
                this.monedaSymbol = "USD";
            } else {
                this.monedaSymbol = "$";
            }
        },

        get esFullTime() {
            const tipo = this.cat.tipos.find(
                (t) => t.id == this.form.tipo_asignacion_id
            );
            const titulo = String(tipo?.titulo || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .replace(/\s+/g, " ")
                .trim();
            const compacto = titulo.replace(/\s+/g, "");
            return (
                titulo.includes("full") ||
                titulo.includes("part") ||
                titulo.includes("tiempo completo") ||
                compacto.includes("tiempocompleto") ||
                titulo.includes("medio tiempo") ||
                compacto.includes("mediotiempo")
            );
        },

        validarDuplicado() {
            if (
                !this.form.cliente_id ||
                !this.form.consultor_id ||
                !this.form.modulo_id ||
                !this.form.tipo_asignacion_id
            ) {
                this.errors.duplicado = false;
                return;
            }

            const existe = this.tarifas.some(
                (t) =>
                    t.cliente_id == this.form.cliente_id &&
                    t.consultor_id == this.form.consultor_id &&
                    t.modulo_id == this.form.modulo_id &&
                    t.tipo_asignacion_id == this.form.tipo_asignacion_id &&
                    t.id !== this.form.id
            );

            this.errors.duplicado = existe;
        },

        setClienteId() {
            const q = this.formDisplay.cliente.trim().toLowerCase();
            const match = this.cat.clientes.find(
                (c) => String(c.titulo || "").toLowerCase() === q
            );
            this.form.cliente_id = match ? match.id : "";
            this.validarDuplicado();
        },

        setConsultorId() {
            const q = this.formDisplay.consultor.trim().toLowerCase();
            const match = this.cat.consultores.find(
                (c) => String(c.nombre || "").toLowerCase() === q
            );
            this.form.consultor_id = match ? match.id : "";
            this.cambiarMoneda();
            this.validarDuplicado();
        },

        setModuloId() {
            const q = this.formDisplay.modulo.trim().toLowerCase();
            const match = this.cat.modulos.find(
                (m) => String(m.titulo || "").toLowerCase() === q
            );
            this.form.modulo_id = match ? match.id : "";
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

        get formValido() {
            return (
                this.form.cliente_id &&
                this.form.consultor_id &&
                this.form.modulo_id &&
                this.form.tipo_asignacion_id &&
                this.form.valor > 0
            );
        },

        get tarifasFiltradas() {
            return this.tarifas.filter((t) => {
                const matchCliente = this.filters.cliente
                    ? t.nombre_cliente === this.filters.cliente
                    : true;
                const matchConsultor = this.filters.consultor
                    ? t.nombre_consultor === this.filters.consultor
                    : true;
                return matchCliente && matchConsultor;
            });
        },

        formatearDinero(valor) {
            return new Intl.NumberFormat("es-CO").format(valor);
        },

        limpiarFormulario() {
            this.form = {
                id: null,
                cliente_id: "",
                consultor_id: "",
                modulo_id: "",
                tipo_asignacion_id: "",
                valor: ""
            };
            this.formDisplay = {
                cliente: "",
                consultor: "",
                modulo: "",
                tipo: ""
            };
            this.errors.duplicado = false;
            this.monedaSymbol = "$";
        },

        editar(t) {
            this.form = {
                id: t.id,
                cliente_id: t.cliente_id,
                consultor_id: t.consultor_id,
                modulo_id: t.modulo_id,
                tipo_asignacion_id: t.tipo_asignacion_id,
                valor: t.valor
            };
            this.formDisplay = {
                cliente: t.nombre_cliente || "",
                consultor: t.nombre_consultor || "",
                modulo: t.nombre_modulo || "",
                tipo: t.tipo_asignacion || ""
            };
            this.cambiarMoneda();
            this.errors.duplicado = false;
        },

        async guardarTarifa() {
            try {
                const method = this.form.id ? "put" : "post";
                const url = this.form.id
                    ? `${API}/tarifas/${this.form.id}`
                    : `${API}/tarifas`;

                await axios[method](url, this.form);
                alert("Guardado exitoso");
                this.limpiarFormulario();
                await this.cargarDatos();
            } catch (e) {
                alert("Error guardando");
            }
        },

        async eliminar(id) {
            if (!confirm("¿Eliminar tarifa?")) return;
            try {
                await axios.delete(`${API}/tarifas/${id}`, this.getAuthConfig());
                await this.cargarDatos();
            } catch (e) {
                alert("Error eliminando");
            }
        }
    };
};
