// js/mis-cuentas-cobros.js
window.misCuentasApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        usuario: { id: null },
        cuentas: [],
        filtros: { inicio: "", fin: "" },
        modal: { open: false, data: null, detalles: [] },

        async init() {
            if (window.auth) {
                const u = window.auth.getUser();
                if (u) this.usuario = u;
            }
            await this.cargarHistorial();
        },

        async cargarHistorial() {
            try {
                let url = `${API}/cuentas-cobro/historial/${this.usuario.id || ""}`;
                if (this.filtros.inicio && this.filtros.fin) {
                    url += `?fecha_inicio=${this.filtros.inicio}&fecha_fin=${this.filtros.fin}`;
                }
                const res = await axios.get(url);
                this.cuentas = res.data || [];
            } catch (e) {
                this.cuentas = [];
            }
        },

        async verDetalle(cuenta) {
            this.modal.data = cuenta;
            this.modal.open = true;
            this.modal.detalles = [];
            try {
                const res = await axios.get(`${API}/cuentas-cobro/detalle/${cuenta.id}`);
                this.modal.detalles = res.data || [];
            } catch (e) {
                this.modal.detalles = [];
            }
        },

        async descargarPDF(cuenta) {
            try {
                const res = await axios.get(`${API}/cuentas-cobro/${cuenta.id}/pdf`, {
                    responseType: "blob"
                });
                const blob = new Blob([res.data], { type: "application/pdf" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `CuentaCobro_${cuenta.id}.pdf`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (e) {
                alert("No se pudo descargar el PDF");
            }
        },

        limpiarFiltros() {
            this.filtros = { inicio: "", fin: "" };
            this.cargarHistorial();
        },

        get totalAnual() {
            return this.cuentas.reduce((sum, c) => sum + Number(c.total_numeros || 0), 0);
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
