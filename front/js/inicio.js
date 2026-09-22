window.inicioApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    function todayInBogota() {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Bogota",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    }

    return {
        roleKey: "other",
        cargando: false,
        guardando: false,
        error: "",
        mensaje: "",
        fechaConsulta: todayInBogota(),
        clientes: [],
        capacidad: { semana: {}, bolsa: null, actividades: [], movimientos: [] },
        reunion: { titulo: "", cliente_id: "", fecha: todayInBogota(), horas: "" },

        async init() {
            this.roleKey = window.auth?.getRoleKey?.() || "other";
            if (this.esFabrica) {
                await Promise.all([this.cargarCatalogos(), this.cargarCapacidad()]);
            }
        },

        get esFabrica() {
            return this.roleKey === "fabrica";
        },

        authConfig(extra = {}) {
            return {
                ...extra,
                headers: {
                    ...(extra.headers || {}),
                    Authorization: `Bearer ${window.auth?.getToken?.() || ""}`
                }
            };
        },

        errorText(error, fallback) {
            return error?.response?.data?.error || error?.message || fallback;
        },

        async cargarCatalogos() {
            try {
                const response = await axios.get(`${API}/capacidad-fabrica/catalogos`, this.authConfig());
                this.clientes = response.data?.clientes || [];
            } catch (error) {
                this.error = this.errorText(error, "No se cargaron los clientes.");
            }
        },

        async cargarCapacidad() {
            this.cargando = true;
            this.error = "";
            try {
                const response = await axios.get(`${API}/capacidad-fabrica/mi-capacidad`, this.authConfig({
                    params: { fecha: this.fechaConsulta }
                }));
                this.capacidad = response.data || { semana: {}, bolsa: null, actividades: [], movimientos: [] };
                if (this.capacidad.semana?.fecha_inicio) {
                    this.reunion.fecha = this.fechaConsulta;
                }
            } catch (error) {
                this.error = this.errorText(error, "No se cargó tu capacidad semanal.");
            } finally {
                this.cargando = false;
            }
        },

        async guardarReunion() {
            this.guardando = true;
            this.error = "";
            try {
                await axios.post(`${API}/capacidad-fabrica/mi-reuniones`, {
                    ...this.reunion,
                    categoria_codigo: "REUNIONES"
                }, this.authConfig());
                this.reunion = {
                    titulo: "",
                    cliente_id: "",
                    fecha: this.reunion.fecha,
                    horas: ""
                };
                this.mensaje = "Reunión registrada y descontada de tu bolsa semanal.";
                await this.cargarCapacidad();
            } catch (error) {
                this.error = this.errorText(error, "No se registró la reunión.");
            } finally {
                this.guardando = false;
            }
        },

        async cancelarActividad(activity) {
            if (!activity?.id || activity.estado === "CANCELADA") return;
            if (!window.confirm("¿Cancelar esta reunión y devolver sus horas a la bolsa?")) return;
            this.error = "";
            try {
                await axios.patch(
                    `${API}/capacidad-fabrica/actividades/${activity.id}/cancelar`,
                    {},
                    this.authConfig()
                );
                this.mensaje = "Reunión cancelada; las horas regresaron a la bolsa.";
                await this.cargarCapacidad();
            } catch (error) {
                this.error = this.errorText(error, "No se canceló la reunión.");
            }
        },

        get porcentajeConsumido() {
            const assigned = Number(this.capacidad.bolsa?.horas_asignadas || 0);
            const consumed = Number(this.capacidad.bolsa?.horas_consumidas || 0);
            return assigned > 0 ? Math.min(100, Math.round(consumed * 10000 / assigned) / 100) : 0;
        },

        formatNumber(value) {
            return new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(Number(value || 0));
        },

        formatDate(value, includeTime = false) {
            if (!value) return "—";
            return new Intl.DateTimeFormat("es-CO", includeTime
                ? { dateStyle: "short", timeStyle: "short", timeZone: "America/Bogota" }
                : { dateStyle: "medium", timeZone: "UTC" }
            ).format(new Date(value));
        }
    };
};
