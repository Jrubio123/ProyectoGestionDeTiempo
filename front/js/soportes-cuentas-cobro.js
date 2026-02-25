window.soportesCuentasCobroApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        soportes: [],
        consultores: [],
        filtros: {
            consultor_id: ""
        },
        loading: false,

        async init() {
            await Promise.all([this.cargarConsultores(), this.cargarSoportes()]);
        },

        async cargarConsultores() {
            try {
                const res = await axios.get(`${API}/consultores`);
                this.consultores = Array.isArray(res.data) ? res.data : [];
            } catch (e) {
                this.consultores = [];
            }
        },

        async cargarSoportes() {
            this.loading = true;
            try {
                let url = `${API}/cuentas-cobro/soportes`;
                if (this.filtros.consultor_id) {
                    url += `?consultor_id=${encodeURIComponent(this.filtros.consultor_id)}`;
                }
                const res = await axios.get(url);
                this.soportes = Array.isArray(res.data) ? res.data : [];
            } catch (e) {
                this.soportes = [];
            } finally {
                this.loading = false;
            }
        },

        limpiarFiltros() {
            this.filtros.consultor_id = "";
            this.cargarSoportes();
        },

        getSoporteUrl(item, tipo) {
            const soporte = item?.datos_adjuntos?.soportes || {};
            if (tipo === "cuenta") {
                return (
                    soporte?.cuenta_cobro?.url ||
                    item?.datos_adjuntos?.firma?.documento_firmado?.url ||
                    ""
                );
            }
            if (tipo === "seguridad") return soporte?.seguridad_social?.url || "";
            return "";
        },

        abrirSoporte(item, tipo) {
            const url = this.getSoporteUrl(item, tipo);
            if (!url) {
                alert("No hay archivo disponible para este soporte.");
                return;
            }
            window.open(url, "_blank", "noopener,noreferrer");
        },

        formatDate(d) {
            return d ? String(d).split("T")[0] : "";
        },

        formatearDinero(val) {
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency: "COP",
                maximumFractionDigits: 0
            }).format(Number(val || 0));
        }
    };
};
