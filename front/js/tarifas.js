// js/tarifas.js
window.tarifasApp = function () {
    const API = "http://localhost:4000";

    return {
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
        errors: { duplicado: false },
        monedaSymbol: "$",

        async init() {
            await Promise.all([
                this.cargarCatalogos(),
                this.cargarDatos()
            ]);
        },

        async cargarCatalogos() {
            try {
                const [resClientes, resConsultores, resModulos, resTipos] = await Promise.all([
                    axios.get(`${API}/clientes`),
                    axios.get(`${API}/consultores`),
                    axios.get(`${API}/modulos`),
                    axios.get(`${API}/tipos-asignacion`)
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
                const res = await axios.get(`${API}/tarifas`);
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
            return tipo && tipo.titulo === "Full time";
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
                await axios.delete(`${API}/tarifas/${id}`);
                await this.cargarDatos();
            } catch (e) {
                alert("Error eliminando");
            }
        }
    };
};
