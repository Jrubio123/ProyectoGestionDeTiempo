// js/asignacion-consultor.js
window.asignacionConsultorApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

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
            tipo_servicio: "Servicio",
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
                const user = window.auth?.getUser?.();
                const coordId = user?.id || null;
                const url = coordId
                    ? `${API}/consultorias?coordinador_id=${encodeURIComponent(coordId)}`
                    : `${API}/consultorias`;
                const res = await axios.get(url);
                const items = res.data || [];
                const uniq = new Map();
                items.forEach((p) => {
                    const key = p.id || p.consultoria_id;
                    if (!uniq.has(key)) {
                        uniq.set(key, {
                            ...p,
                            consultoria_id: p.id,
                            cliente: p.nombre_cliente,
                            _key: String(key)
                        });
                    }
                });
                this.proyectos = Array.from(uniq.values());
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
            this.form.cantidad_dias = this.esMensual ? 20 : 0;
            this.form.horas_asignadas = 0;
            this.form.tipo_servicio = "Servicio";
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

        parseLocalDate(value) {
            if (!value) return null;
            const [y, m, d] = String(value).split("-").map(Number);
            if (!y || !m || !d) return null;
            return new Date(y, m - 1, d);
        },

        calcularDias() {
            if (this.esMensual) {
                const dias = this.calcularDiasMensual(
                    this.form.fecha_inicio,
                    this.form.fecha_fin
                );
                this.form.cantidad_dias = dias || 20;
                return;
            }
            if (this.form.fecha_inicio && this.form.fecha_fin) {
                const inicio = this.parseLocalDate(this.form.fecha_inicio);
                const fin = this.parseLocalDate(this.form.fecha_fin);
                if (!inicio || !fin || fin < inicio) {
                    this.form.cantidad_dias = 0;
                    return;
                }
                const diff = fin - inicio;
                const days = Math.ceil(diff / (1000 * 60 * 60 * 24)) + 1;
                this.form.cantidad_dias = days > 0 ? days : 0;
            }
        },

        get esMensual() {
            const tipo = this.proyectoSelected?.tipo_asignacion || "";
            const t = String(tipo).toLowerCase();
            return t.includes("full") || t.includes("part");
        },

        calcularDiasMensual(fechaInicio, fechaFin) {
            if (!fechaInicio || !fechaFin) return 0;
            const inicio = this.parseLocalDate(fechaInicio);
            const fin = this.parseLocalDate(fechaFin);
            if (!inicio || !fin || isNaN(inicio) || isNaN(fin) || fin < inicio) return 0;
            if (
                inicio.getFullYear() === fin.getFullYear() &&
                inicio.getMonth() === fin.getMonth()
            ) {
                return 20;
            }
            const months =
                (fin.getFullYear() - inicio.getFullYear()) * 12 +
                (fin.getMonth() - inicio.getMonth()) +
                1;
            return months > 0 ? months * 20 : 0;
        },

        get esPorHora() {
            return !this.esMensual;
        },

        get esMesaServicio() {
            const tipo = this.proyectoSelected?.tipo_asignacion || "";
            return ["Mesa de servicio", "Fábrica"].includes(tipo);
        },

        get formValido() {
            if (!this.form.consultor_id || !this.form.modulo_id || !(this.alertaTarifa.valor > 0)) return false;
            if (this.esPorHora) {
                return (this.form.horas_asignadas || 0) > 0;
            }
            return true;
        },

        calcularTotal() {
            const tarifa = this.alertaTarifa.valor || 0;
            let total = 0;
            if (this.esMensual) {
                const dias = this.calcularDiasMensual(
                    this.form.fecha_inicio,
                    this.form.fecha_fin
                );
                const meses = dias ? dias / 20 : 1;
                total = tarifa * meses;
            } else {
                total = tarifa * (this.form.horas_asignadas || 0);
            }
            return this.formatearDinero(total);
        },

        async guardarAsignacion() {
            if (!this.proyectoSelected) return;
            const tarifa = this.alertaTarifa.valor || 0;
            const diasMensual = this.esMensual
                ? this.calcularDiasMensual(this.form.fecha_inicio, this.form.fecha_fin) || 20
                : 0;
            const meses = this.esMensual ? (diasMensual / 20) : 0;
            const total = this.esMensual
                ? tarifa * (meses || 1)
                : tarifa * (this.form.horas_asignadas || 0);
            const valorDia = this.esMensual ? (tarifa / 20) : null;
            const payload = {
                id_consultoria: this.proyectoSelected.consultoria_id || this.proyectoSelected.id,
                id_modulo: this.form.modulo_id,
                consultor_responsable_id: this.form.consultor_id,
                fecha_inicio: this.form.fecha_inicio || null,
                fecha_fin: this.form.fecha_fin || null,
                cantidad_dias: this.esMensual ? diasMensual : (this.form.cantidad_dias || null),
                horas_asignadas: this.esMensual ? null : (this.form.horas_asignadas || null),
                valor_hora: this.esMensual ? null : tarifa || null,
                valor_dia: valorDia,
                total_pagar: total,
                tipo_servicio: this.form.tipo_servicio || "Servicio"
            };

            try {
                await axios.post(`${API}/registro-asignaciones`, payload);
                alert("Asignación creada exitosamente");
                this.proyectoSelected = null;
                await this.cargarProyectos();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al guardar";
                alert(msg);
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
