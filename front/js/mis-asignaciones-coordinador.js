// js/mis-asignaciones-coordinador.js
window.misAsignacionesApp = function () {
    const API = "http://localhost:4000";

    return {
        cargando: false,
        guardando: false,
        tarifaEncontrada: true,
        mostrarModal: false,

        asignaciones: [],
        filtros: { cliente: "", consultor: "" },

        consultores: [],
        modulos: [],

        asignacionSeleccionada: null,

        consultoriaInfo: {
            cliente: "",
            proyecto: "",
            tipo_asignacion: "",
            cliente_id: null,
            tipo_asignacion_id: null
        },

        form: {
            id: null,
            consultor_responsable_id: "",
            id_modulo: "",
            fecha_inicio: "",
            fecha_fin: "",
            cantidad_dias: 0,
            valor_hora: 0,
            valor_dia: 0,
            nro_caso_interno: "",
            nro_caso_cliente: "",
            tipo_servicio: "",
            estado: "Activo",
            observacion: ""
        },

        toast: {
            visible: false,
            tipo: "info",
            mensaje: ""
        },

        async init() {
            await Promise.all([this.cargarCatalogos(), this.cargarAsignaciones()]);
        },

        async cargarCatalogos() {
            try {
                const [resConsultores, resModulos] = await Promise.all([
                    axios.get(`${API}/consultores`),
                    axios.get(`${API}/modulos`)
                ]);
                this.consultores = resConsultores.data || [];
                this.modulos = resModulos.data || [];
            } catch (e) {
                this.consultores = [];
                this.modulos = [];
            }
        },

        async cargarAsignaciones() {
            this.cargando = true;
            try {
                const res = await axios.get(`${API}/mis-asignaciones-coordinador`);
                this.asignaciones = (res.data || []).map((a, idx) => ({
                    ...a,
                    _key: `${a.consultoria_id || "c"}-${a.id || "na"}-${idx}`,
                    valor_hora: Number(a.valor_hora || 0),
                    cantidad_dias: Number(a.cantidad_dias || 0)
                }));
            } catch (e) {
                this.asignaciones = [];
            } finally {
                this.cargando = false;
            }
        },

        get asignacionesFiltradas() {
            const qCliente = this.filtros.cliente.trim().toLowerCase();
            const qConsultor = this.filtros.consultor.trim().toLowerCase();
            return this.asignaciones.filter((a) => {
                const cliente = String(a.cliente || "").toLowerCase();
                const consultor = String(a.consultor_responsable || "").toLowerCase();
                const matchCliente = qCliente ? cliente.includes(qCliente) : true;
                const matchConsultor = qConsultor ? consultor.includes(qConsultor) : true;
                return matchCliente && matchConsultor;
            });
        },

        get clientesUnicos() {
            return [...new Set(this.asignaciones.map((a) => a.cliente).filter(Boolean))].sort();
        },

        get consultoresUnicos() {
            return [...new Set(this.asignaciones.map((a) => a.consultor_responsable).filter(Boolean))].sort();
        },

        seleccionarAsignacion(asignacion) {
            this.asignacionSeleccionada = asignacion;
        },

        editarAsignacion(asignacion) {
            this.asignacionSeleccionada = asignacion;
            this.consultoriaInfo = {
                cliente: asignacion.cliente || "",
                proyecto: asignacion.descripcion_consultoria || "",
                tipo_asignacion: asignacion.tipo_asignacion || "",
                cliente_id: asignacion.cliente_id || null,
                tipo_asignacion_id: asignacion.tipo_asignacion_id || null
            };

            this.form = {
                id: asignacion.id,
                consultor_responsable_id: asignacion.consultor_responsable_id || "",
                id_modulo: asignacion.id_modulo || "",
                fecha_inicio: asignacion.fecha_inicio || "",
                fecha_fin: asignacion.fecha_fin || "",
                cantidad_dias: Number(asignacion.cantidad_dias || 0),
                valor_hora: Number(asignacion.valor_hora || 0),
                valor_dia: Number(asignacion.valor_dia || 0),
                nro_caso_interno: asignacion.nro_caso_interno || "",
                nro_caso_cliente: asignacion.nro_caso_cliente || "",
                tipo_servicio: asignacion.tipo_servicio || "",
                estado: asignacion.estado || "Activo",
                observacion: asignacion.observacion || ""
            };

            this.tarifaEncontrada = true;
            this.mostrarModal = true;
        },

        cerrarModal() {
            this.mostrarModal = false;
        },

        async validarTarifa() {
            if (!this.consultoriaInfo.cliente_id || !this.form.consultor_responsable_id || !this.form.id_modulo) {
                this.tarifaEncontrada = true;
                this.form.valor_hora = 0;
                this.form.valor_dia = 0;
                return;
            }

            try {
                const res = await axios.get(`${API}/tarifa-consultor`, {
                    params: {
                        consultor_id: this.form.consultor_responsable_id,
                        cliente_id: this.consultoriaInfo.cliente_id,
                        modulo_id: this.form.id_modulo,
                        tipo_asignacion_id: this.consultoriaInfo.tipo_asignacion_id
                    }
                });
                const valor = Number(res.data?.valor_tarifa || 0);
                this.form.valor_hora = valor;
                this.form.valor_dia = this.esMensualTipo() && valor ? (valor / 20) : 0;
                this.tarifaEncontrada = valor > 0;
            } catch (e) {
                this.form.valor_hora = 0;
                this.form.valor_dia = 0;
                this.tarifaEncontrada = false;
            }
        },

        mostrarCamposPorTipo(tipos) {
            const t = String(this.consultoriaInfo.tipo_asignacion || "").toLowerCase();
            return tipos.some((x) => t === String(x).toLowerCase());
        },

        parseLocalDate(value) {
            if (!value) return null;
            const [y, m, d] = String(value).split("-").map(Number);
            if (!y || !m || !d) return null;
            return new Date(y, m - 1, d);
        },

        calcularDias() {
            if (!this.form.fecha_inicio || !this.form.fecha_fin) return;
            if (this.esMensualTipo()) {
                const dias = this.calcularDiasMensual(this.form.fecha_inicio, this.form.fecha_fin);
                this.form.cantidad_dias = dias || 20;
                return;
            }
            const inicio = this.parseLocalDate(this.form.fecha_inicio);
            const fin = this.parseLocalDate(this.form.fecha_fin);
            if (!inicio || !fin || fin < inicio) {
                this.form.cantidad_dias = 0;
                return;
            }
            const diff = Math.ceil((fin - inicio) / (1000 * 60 * 60 * 24)) + 1;
            this.form.cantidad_dias = diff > 0 ? diff : 0;
        },

        calcularTotalPagar() {
            if (!this.form.valor_hora) return 0;
            if (this.esMensualTipo()) {
                const dias = this.calcularDiasMensual(this.form.fecha_inicio, this.form.fecha_fin) || this.form.cantidad_dias || 20;
                const meses = dias / 20;
                return this.form.valor_hora * (meses || 1);
            }
            if (this.consultoriaInfo.tipo_asignacion === "Tiempo y costo fijo") {
                return this.form.valor_hora * (this.form.cantidad_dias || 0);
            }
            return this.form.valor_hora * (this.form.cantidad_dias || 0);
        },

        esMensualTipo() {
            const t = String(this.consultoriaInfo.tipo_asignacion || "").toLowerCase();
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

        tarifaMostrar(asignacion) {
            const tipo = String(asignacion?.tipo_asignacion || "").toLowerCase();
            const esMensual = tipo.includes("full") || tipo.includes("part");
            if (esMensual) {
                const valorDia = Number(asignacion?.valor_dia || 0);
                const tarifaMensual = valorDia ? valorDia * 20 : Number(asignacion?.valor_hora || 0);
                return tarifaMensual;
            }
            return Number(asignacion?.valor_hora || 0);
        },

        async guardarAsignacion() {
            if (!this.form.id) return;
            this.guardando = true;
            try {
                const payload = {
                    consultor_responsable_id: this.form.consultor_responsable_id,
                    id_modulo: this.form.id_modulo,
                    fecha_inicio: this.form.fecha_inicio || null,
                    fecha_fin: this.form.fecha_fin || null,
                    cantidad_dias: this.form.cantidad_dias || null,
                    valor_hora: this.form.valor_hora || null,
                    valor_dia: this.form.valor_dia || null,
                    nro_caso_interno: this.form.nro_caso_interno || null,
                    nro_caso_cliente: this.form.nro_caso_cliente || null,
                    tipo_servicio: this.form.tipo_servicio || null,
                    estado: this.form.estado || null,
                    observacion: this.form.observacion || null,
                    total_pagar: this.calcularTotalPagar() || null
                };
                await axios.put(`${API}/registro-asignaciones/${this.form.id}`, payload);
                this.toastMensaje("success", "Asignación actualizada");
                this.cerrarModal();
                await this.cargarAsignaciones();
            } catch (e) {
                this.toastMensaje("error", "Error al guardar la asignación");
            } finally {
                this.guardando = false;
            }
        },

        enviarNotificacionTarifa() {
            this.toastMensaje("info", "Notificación enviada al administrador");
        },

        toastMensaje(tipo, mensaje) {
            this.toast = { visible: true, tipo, mensaje };
            setTimeout(() => {
                this.toast.visible = false;
            }, 2500);
        }
    };
};
