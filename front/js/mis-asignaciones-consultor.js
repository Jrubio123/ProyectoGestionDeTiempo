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

        esTipoMensual(tipoAsignacion) {
            const tipo = String(tipoAsignacion || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .replace(/\s+/g, " ")
                .trim();
            const compacto = tipo.replace(/\s+/g, "");
            return (
                tipo.includes("full") ||
                tipo.includes("part") ||
                tipo.includes("tiempo completo") ||
                compacto.includes("tiempocompleto") ||
                tipo.includes("medio tiempo") ||
                compacto.includes("mediotiempo")
            );
        },

        tarifaMostrar(asignacion) {
            const esMensual = this.esTipoMensual(asignacion?.nombre_tipo_asignacion || "");
            if (esMensual) {
                const valorDia = Number(asignacion?.valor_dia || 0);
                const tarifaMensual = valorDia ? valorDia * 20 : Number(asignacion?.valor_hora || 0);
                return tarifaMensual;
            }
            return Number(asignacion?.valor_hora || 0);
        },

        totalMostrar(asignacion) {
            const tipo = String(asignacion?.nombre_tipo_asignacion || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .replace(/\s+/g, " ")
                .trim();
            const compacto = tipo.replace(/\s+/g, "");
            const esMensual = this.esTipoMensual(tipo);
            const esHorasDemanda = tipo.includes("horas por demanda");
            const esHorasDemandaCompacto = compacto.includes("horaspordemanda");
            if (esHorasDemanda || esHorasDemandaCompacto) return 0;

            const totalBackend = Number(asignacion?.total_pagar || 0);
            const tarifa = this.tarifaMostrar(asignacion);
            if (!(tarifa > 0)) return 0;

            const horas = Number(asignacion?.horas_asignadas || 0);
            const dias = Number(asignacion?.cantidad_dias || 0);
            const valorDia = Number(asignacion?.valor_dia || 0);

            if (esMensual) {
                if (dias > 0 && valorDia > 0) return valorDia * dias;
                if (dias > 0) return (tarifa / 20) * dias;
                return totalBackend > 0 ? totalBackend : 0;
            }

            if (totalBackend > 0) return totalBackend;
            if (horas > 0) return tarifa * horas;
            if (dias > 0) return tarifa * dias;
            return esMensual ? tarifa : 0;
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
