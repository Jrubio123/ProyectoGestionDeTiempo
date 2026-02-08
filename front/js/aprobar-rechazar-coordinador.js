// js/aprobar-rechazar-coordinador.js
window.aprobacionApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        reportes: [],
        filters: { cliente: "", tipo: "", search: "" },
        modalRechazo: { open: false, id: null, motivo: "" },

        async init() {
            await this.cargarDatos();
        },

        async cargarDatos() {
            try {
                const res = await axios.get(`${API}/aprobaciones/pendientes`);
                this.reportes = res.data || [];
            } catch (e) {
                this.reportes = [];
            }
        },

        get reportesFiltrados() {
            return this.reportes.filter((r) => {
                const f = this.filters;
                const matchCli = !f.cliente || r.nombre_cliente === f.cliente;
                const matchTipo = !f.tipo || r.nombre_tipo_asignacion === f.tipo;
                const search = (f.search || "").toLowerCase();
                const matchSearch =
                    !search ||
                    (r.nombre_consultor || "").toLowerCase().includes(search) ||
                    (r.nro_caso_int_ext || "").toLowerCase().includes(search);
                return matchCli && matchTipo && matchSearch;
            });
        },

        get uniqueClientes() {
            return [...new Set(this.reportes.map((r) => r.nombre_cliente).filter(Boolean))];
        },

        get uniqueTipos() {
            return [...new Set(this.reportes.map((r) => r.nombre_tipo_asignacion).filter(Boolean))];
        },

        get totalPendiente() {
            return this.reportesFiltrados.reduce((sum, r) => sum + Number(r.total_cobrar || 0), 0);
        },

        async aprobar(id) {
            if (!confirm("¿Aprobar reporte?")) return;
            try {
                await axios.put(`${API}/aprobaciones/${id}`, { estado: "Aprobado" });
                this.quitar(id);
            } catch (e) {
                alert("Error");
            }
        },

        abrirRechazo(id) {
            this.modalRechazo = { open: true, id: id, motivo: "" };
        },

        async confirmarRechazo() {
            try {
                await axios.put(`${API}/aprobaciones/${this.modalRechazo.id}`, {
                    estado: "Rechazado",
                    motivo: this.modalRechazo.motivo
                });
                this.quitar(this.modalRechazo.id);
                this.modalRechazo.open = false;
            } catch (e) {
                alert("Error");
            }
        },

        quitar(id) {
            this.reportes = this.reportes.filter((r) => r.id !== id);
        },

        exportarExcel() {
            const csvContent =
                "data:text/csv;charset=utf-8," +
                ["Fecha,Consultor,Cliente,Total"].join(",") +
                "\n" +
                this.reportesFiltrados
                    .map((r) => `${r.fecha_reporte},${r.nombre_consultor},${r.nombre_cliente},${r.total_cobrar}`)
                    .join("\n");
            const encodedUri = encodeURI(csvContent);
            window.open(encodedUri);
        },

        formatearDinero(val) {
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency: "COP",
                maximumFractionDigits: 0
            }).format(val || 0);
        },

        formatDate(d) {
            return d ? d.split("T")[0] : "";
        }
    };
};
