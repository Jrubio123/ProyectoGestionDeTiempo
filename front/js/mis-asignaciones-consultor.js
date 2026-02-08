// js/mis-asignaciones-consultor.js
window.misAsignacionesConsultorApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        cargando: false,
        asignaciones: [],
        modalOpen: false,
        detalle: {},
        esAsociado: false,

        async init() {
            this.esAsociado = window.auth?.isAsociado?.() || false;
            await this.cargarAsignaciones();
        },

        async cargarAsignaciones() {
            this.cargando = true;
            try {
                const user = window.auth?.getUser?.();
                const consultorId = user?.id || null;
                const url = consultorId
                    ? `${API}/mis-asignaciones?consultor_id=${encodeURIComponent(consultorId)}`
                    : `${API}/mis-asignaciones`;
                const res = await axios.get(url);
                this.asignaciones = res.data || [];
            } catch (e) {
                this.asignaciones = [];
            } finally {
                this.cargando = false;
            }
        },

        verDetalle(item) {
            this.detalle = { ...item };
            this.modalOpen = true;
        },

        tarifaMostrar(asignacion) {
            const tipo = String(asignacion?.nombre_tipo_asignacion || "").toLowerCase();
            const esMensual = tipo.includes("full") || tipo.includes("part");
            if (esMensual) {
                const valorDia = Number(asignacion?.valor_dia || 0);
                const tarifaMensual = valorDia ? valorDia * 20 : Number(asignacion?.valor_hora || 0);
                return tarifaMensual;
            }
            return Number(asignacion?.valor_hora || 0);
        },

        formatearDinero(valor) {
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency: "COP",
                maximumFractionDigits: 0
            }).format(valor || 0);
        }
    };
};
