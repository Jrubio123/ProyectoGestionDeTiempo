// js/asignacion-consultor.js
window.asignacionConsultorApp = function () {
    const API = "http://localhost:4000";

    return {
        proyectos: [],
        cat: { consultores: [], modulos: [] },
        search: "",
        proyectoSelected: null,
        alertaTarifa: { mostrar: false, tipo: "", mensaje: "", valor: 0 },
        form: {
            consultor_id: "",
            modulo_id: "",
            fecha_inicio: "",
            fecha_fin: "",
            cantidad_dias: 0,
            horas_asignadas: 0,
            estado_mesa: "Abierto",
            fecha_cierre: ""
        },

        async init() {
            await Promise.all([this.cargarCatalogos(), this.cargarProyectos()]);
        },

        async cargarCatalogos() {
            try {
                const [resConsultores, resModulos] = await Promise.all([
                    axios.get(`${API}/consultores`),
                    axios.get(`${API}/modulos`)
                ]);
                this.cat.consultores = resConsultores.data || [];
                this.cat.modulos = resModulos.data || [];
            } catch (e) {
                this.cat.consultores = [];
                this.cat.modulos = [];
            }
        },

        async cargarProyectos() {
            try {
                const res = await axios.get(`${API}/mis-asignaciones-coordinador`);
                this.proyectos = (res.data || []).map((p) => ({
                    ...p,
                    _key: `${p.consultoria_id || "c"}-${p.id || "na"}`
                }));
            } catch (e) {
                this.proyectos = [];
            }
        },

        get proyectosFiltrados() {
            if (!this.search) return this.proyectos;
            const s = this.search.toLowerCase();
            return this.proyectos.filter((p) => {
                const cliente = String(p.cliente || "").toLowerCase();
                const tipo = String(p.tipo_asignacion || "").toLowerCase();
                return cliente.includes(s) || tipo.includes(s);
            });
        },

        seleccionarProyecto(p) {
            this.proyectoSelected = p;
            this.alertaTarifa = { mostrar: false, tipo: "", mensaje: "", valor: 0 };
            this.form.consultor_id = "";
            this.form.modulo_id = "";
            this.form.fecha_inicio = "";
            this.form.fecha_fin = "";
            this.form.cantidad_dias = 0;
            this.form.horas_asignadas = 0;
        },

        async buscarTarifa() {
            if (!this.form.consultor_id || !this.form.modulo_id || !this.proyectoSelected) return;

            try {
                const res = await axios.get(`${API}/tarifa-consultor`, {
                    params: {
                        consultor_id: this.form.consultor_id,
                        cliente_id: this.proyectoSelected.cliente_id,
                        modulo_id: this.form.modulo_id,
                        tipo_asignacion_id: this.proyectoSelected.tipo_asignacion_id
                    }
                });

                const tarifa = Number(res.data?.valor_tarifa || 0);
                if (tarifa > 0) {
                    this.alertaTarifa = {
                        mostrar: true,
                        tipo: "success",
                        mensaje: "Tarifa Encontrada:",
                        valor: tarifa
                    };
                } else {
                    this.alertaTarifa = {
                        mostrar: true,
                        tipo: "error",
                        mensaje: "No existe tarifa para esta combinación.",
                        valor: 0
                    };
                }
            } catch (e) {
                this.alertaTarifa = {
                    mostrar: true,
                    tipo: "error",
                    mensaje: "Error consultando tarifa.",
                    valor: 0
                };
            }
        },

        calcularDias() {
            if (this.form.fecha_inicio && this.form.fecha_fin) {
                const diff = new Date(this.form.fecha_fin) - new Date(this.form.fecha_inicio);
                const days = Math.ceil(diff / (1000 * 60 * 60 * 24)) + 1;
                this.form.cantidad_dias = days > 0 ? days : 0;
            }
        },

        get esPorHora() {
            const tipo = this.proyectoSelected?.tipo_asignacion || "";
            return ["Horas por demanda", "Bolsa de horas", "Tiempo y costo fijo"].includes(tipo);
        },

        get esMesaServicio() {
            const tipo = this.proyectoSelected?.tipo_asignacion || "";
            return ["Mesa de servicio", "Fábrica"].includes(tipo);
        },

        get formValido() {
            return this.form.consultor_id && this.form.modulo_id && this.alertaTarifa.valor > 0;
        },

        calcularTotal() {
            const tarifa = this.alertaTarifa.valor || 0;
            let total = 0;
            if (this.esPorHora) {
                total = tarifa * (this.form.horas_asignadas || 0);
            } else {
                total = tarifa * (this.form.cantidad_dias || 0);
            }
            return this.formatearDinero(total);
        },

        async guardarAsignacion() {
            if (!this.proyectoSelected) return;
            const payload = {
                id_consultoria: this.proyectoSelected.consultoria_id || this.proyectoSelected.id,
                id_modulo: this.form.modulo_id,
                consultor_responsable_id: this.form.consultor_id,
                fecha_inicio: this.form.fecha_inicio || null,
                fecha_fin: this.form.fecha_fin || null,
                cantidad_dias: this.form.cantidad_dias || null,
                horas_asignadas: this.form.horas_asignadas || null,
                valor_hora: this.alertaTarifa.valor || null
            };

            try {
                await axios.post(`${API}/registro-asignaciones`, payload);
                alert("Asignación creada exitosamente");
                this.proyectoSelected = null;
                await this.cargarProyectos();
            } catch (e) {
                alert("Error al guardar");
            }
        },

        enviarCorreoTarifa() {
            alert("Correo de solicitud enviado al administrador.");
        },

        formatDate(d) {
            return d ? d.split("T")[0] : "";
        },

        formatearDinero(v) {
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency: "COP",
                maximumFractionDigits: 0
            }).format(v || 0);
        }
    };
};
