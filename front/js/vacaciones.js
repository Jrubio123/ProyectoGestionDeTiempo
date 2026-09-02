function vacacionesApp() {
    return {
        api: `${window.API_BASE || "http://localhost:4000"}/vacaciones`,
        cargando: true,
        guardando: false,
        error: "",
        exito: "",
        tab: "solicitar",
        contexto: { solicitante: {}, jefe_sugerido: null, jefes_fijos: [], puede_configurar: false },
        permisos: { puede_configurar: false, puede_ver_panorama: false },
        solicitudes: [],
        saldoLoggro: { cargando: true, dias_disponibles: null, fecha_corte: null, error: "" },
        form: { fecha_inicio: "", fecha_fin: "", observaciones: "", jefe: null },
        calculo: null,
        busquedaJefe: "",
        jefes: [],
        buscandoJefe: false,
        _jefeTimer: null,
        configuracion: [],
        busquedaConfig: "",
        resultadosConfig: [],
        _configTimer: null,

        async init() {
            await Promise.all([this.cargarContexto(), this.cargarSolicitudes(), this.cargarDiasDisponibles()]);
            if (this.permisos.puede_configurar) await this.cargarConfiguracion();
            this.cargando = false;
        },

        get mias() {
            return this.solicitudes.filter((item) => item.es_mia);
        },

        get porAprobar() {
            return this.solicitudes.filter((item) => item.para_mi_aprobacion);
        },

        get vigentes() {
            const today = this.hoy();
            return this.solicitudes.filter((item) => item.estado === "aprobada" && item.fecha_fin >= today);
        },

        get historial() {
            const today = this.hoy();
            return this.solicitudes.filter((item) =>
                (item.estado === "aprobada" && item.fecha_fin < today)
                || ["rechazada", "cancelada"].includes(item.estado)
            );
        },

        hoy() {
            const now = new Date();
            return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        },

        async cargarContexto() {
            try {
                const { data } = await axios.get(`${this.api}/contexto`);
                this.contexto = data;
                this.jefes = data.jefes_fijos || [];
                if (data.jefe_sugerido) this.seleccionarJefe(data.jefe_sugerido);
            } catch (error) {
                this.mostrarError(error, "No fue posible cargar tu información");
            }
        },

        async cargarSolicitudes() {
            try {
                const { data } = await axios.get(`${this.api}/solicitudes`);
                this.solicitudes = data.solicitudes || [];
                this.permisos = data.permisos || this.permisos;
            } catch (error) {
                this.mostrarError(error, "No fue posible cargar las solicitudes");
            }
        },

        async cargarDiasDisponibles() {
            this.saldoLoggro.cargando = true;
            this.saldoLoggro.error = "";
            try {
                const { data } = await axios.get(`${this.api}/dias-disponibles`);
                this.saldoLoggro.dias_disponibles = data.dias_disponibles;
                this.saldoLoggro.fecha_corte = data.fecha_corte;
            } catch (error) {
                this.saldoLoggro.dias_disponibles = null;
                this.saldoLoggro.fecha_corte = null;
                this.saldoLoggro.error = error?.response?.data?.error || "No fue posible consultar el saldo en Loggro";
            } finally {
                this.saldoLoggro.cargando = false;
            }
        },

        buscarJefes() {
            clearTimeout(this._jefeTimer);
            const query = this.busquedaJefe.trim();
            if (query.length < 2) {
                this.jefes = this.contexto.jefes_fijos || [];
                return;
            }
            this.buscandoJefe = true;
            this._jefeTimer = setTimeout(async () => {
                try {
                    const { data } = await axios.get(`${this.api}/personas`, { params: { q: query } });
                    this.jefes = data || [];
                } catch (error) {
                    this.jefes = [];
                } finally {
                    this.buscandoJefe = false;
                }
            }, 300);
        },

        seleccionarJefe(persona) {
            this.form.jefe = { ...persona };
            this.busquedaJefe = `${persona.nombre} · ${persona.email}`;
            this.jefes = [];
        },

        async calcular() {
            this.calculo = null;
            if (!this.form.fecha_inicio || !this.form.fecha_fin) return;
            try {
                const { data } = await axios.post(`${this.api}/calcular`, {
                    fecha_inicio: this.form.fecha_inicio,
                    fecha_fin: this.form.fecha_fin
                });
                this.calculo = data;
                this.error = "";
            } catch (error) {
                this.mostrarError(error, "Fechas inválidas");
            }
        },

        async solicitar() {
            if (!this.form.jefe) return this.error = "Selecciona el jefe inmediato";
            if (!this.calculo?.dias_habiles) return this.error = "Selecciona un periodo con días hábiles";
            this.guardando = true;
            this.error = "";
            this.exito = "";
            try {
                const { data } = await axios.post(`${this.api}/solicitudes`, this.form);
                this.exito = data.advertencia_correo
                    ? `Solicitud creada, pero el correo no pudo enviarse: ${data.advertencia_correo}`
                    : "Solicitud enviada al jefe inmediato";
                this.form = { fecha_inicio: "", fecha_fin: "", observaciones: "", jefe: null };
                this.busquedaJefe = "";
                this.calculo = null;
                await this.cargarSolicitudes();
            } catch (error) {
                this.mostrarError(error, "No fue posible enviar la solicitud");
            } finally {
                this.guardando = false;
            }
        },

        async decidir(item, accion) {
            let comentario = "";
            if (accion === "rechazar") {
                const ingresado = window.prompt("Motivo del rechazo (opcional):");
                if (ingresado === null) return;
                comentario = ingresado;
            } else if (!window.confirm(`¿Aprobar las vacaciones de ${item.solicitante.nombre}?`)) {
                return;
            }
            try {
                const { data } = await axios.patch(`${this.api}/solicitudes/${item.id}/decision`, { accion, comentario });
                this.exito = data.advertencias_correo?.length
                    ? `Solicitud procesada; hubo errores de correo: ${data.advertencias_correo.join(", ")}`
                    : "Solicitud procesada correctamente";
                await this.cargarSolicitudes();
            } catch (error) {
                this.mostrarError(error, "No fue posible procesar la solicitud");
            }
        },

        async cargarConfiguracion() {
            try {
                const { data } = await axios.get(`${this.api}/configuracion/destinatarios`);
                this.configuracion = data || [];
            } catch (error) {
                this.mostrarError(error, "No fue posible cargar los destinatarios");
            }
        },

        buscarParaConfig() {
            clearTimeout(this._configTimer);
            const query = this.busquedaConfig.trim();
            if (query.length < 2) return this.resultadosConfig = [];
            this._configTimer = setTimeout(async () => {
                try {
                    const { data } = await axios.get(`${this.api}/personas`, { params: { q: query } });
                    const actuales = new Set(this.configuracion.map((item) => item.correo || item.email));
                    this.resultadosConfig = (data || []).filter((item) => !actuales.has(item.email));
                } catch (_) {
                    this.resultadosConfig = [];
                }
            }, 300);
        },

        agregarDestinatario(persona) {
            this.configuracion.push({ ...persona, correo: persona.email });
            this.busquedaConfig = "";
            this.resultadosConfig = [];
        },

        async guardarConfiguracion() {
            this.guardando = true;
            try {
                const destinatarios = this.configuracion.map((item) => ({
                    origen: item.origen,
                    usuario_id: item.usuario_id,
                    persona_id: item.persona_id,
                    azure_oid: item.azure_oid,
                    nombre: item.nombre,
                    email: item.correo || item.email
                }));
                const { data } = await axios.put(`${this.api}/configuracion/destinatarios`, { destinatarios });
                this.configuracion = data || [];
                this.exito = "Destinatarios actualizados";
            } catch (error) {
                this.mostrarError(error, "No fue posible guardar los destinatarios");
            } finally {
                this.guardando = false;
            }
        },

        formatDate(value) {
            if (!value) return "-";
            return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeZone: "UTC" })
                .format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
        },

        estadoClase(estado) {
            return {
                pendiente: "bg-amber-100 text-amber-800",
                aprobada: "bg-emerald-100 text-emerald-800",
                rechazada: "bg-red-100 text-red-800",
                cancelada: "bg-slate-100 text-slate-700"
            }[estado] || "bg-slate-100 text-slate-700";
        },

        mostrarError(error, fallback) {
            this.error = error?.response?.data?.error || fallback;
        }
    };
}

window.vacacionesApp = vacacionesApp;
