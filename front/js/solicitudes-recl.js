// js/solicitudes-recl.js
window.solicitudesReclApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        solicitudes: [],
        filtro: "Todos",
        modalDetalle: false,
        modalNotas: false,
        itemActivo: {},

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async init() {
            await this.cargarSolicitudes();
        },

        async cargarSolicitudes() {
            try {
                const res = await axios.get(`${API}/rrhh/solicitudes`, this.getAuthConfig());
                this.solicitudes = res.data || [];
            } catch (e) {
                this.solicitudes = [];
            }
        },

        get solicitudesFiltradas() {
            if (this.filtro === "Todos") return this.solicitudes;
            return this.solicitudes.filter((s) => s.estado === this.filtro);
        },

        async cambiarEstado(id, nuevoEstado) {
            try {
                await axios.put(
                    `${API}/rrhh/solicitudes/${id}`,
                    { estado: nuevoEstado },
                    this.getAuthConfig()
                );
                this.solicitudes = this.solicitudes.map((s) =>
                    s.id === id ? { ...s, estado: nuevoEstado } : s
                );
            } catch (e) {
                const msg = e?.response?.data?.error || "Error actualizando estado";
                alert(msg);
            }
        },

        abrirDetalle(s) {
            this.itemActivo = { ...s };
            this.modalNotas = false;
            this.modalDetalle = true;
        },

        abrirNotas(s) {
            this.itemActivo = { ...s };
            this.modalDetalle = false;
            this.modalNotas = true;
        },

        async guardarNotas() {
            if (!this.itemActivo?.id) return;
            try {
                await axios.put(
                    `${API}/rrhh/solicitudes/${this.itemActivo.id}`,
                    { observaciones_rrhh: this.itemActivo.observaciones_rrhh || "" },
                    this.getAuthConfig()
                );
                this.solicitudes = this.solicitudes.map((s) =>
                    s.id === this.itemActivo.id
                        ? { ...s, observaciones_rrhh: this.itemActivo.observaciones_rrhh || "" }
                        : s
                );
                this.modalDetalle = false;
                this.modalNotas = false;
            } catch (e) {
                const msg = e?.response?.data?.error || "Error guardando notas";
                alert(msg);
            }
        },

        formatFecha(fecha) {
            if (!fecha) return "-";

            const valor = String(fecha).trim();
            if (!valor) return "-";

            const soloFecha = valor.match(/^(\d{4})-(\d{2})-(\d{2})/);
            let dateObj;

            if (soloFecha) {
                const [, year, month, day] = soloFecha;
                dateObj = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
            } else {
                dateObj = new Date(valor);
            }

            if (Number.isNaN(dateObj.getTime())) return valor;

            return dateObj.toLocaleDateString("es-CO", {
                day: "2-digit",
                month: "long",
                year: "numeric",
                timeZone: "UTC"
            });
        }
    };
};
