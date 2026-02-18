// js/mis-cuentas-cobros.js
window.misCuentasApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        usuario: { id: null },
        cuentas: [],
        filtros: { inicio: "", fin: "" },
        modal: { open: false, data: null, detalles: [] },
        modalAdjuntos: {
            open: false,
            cuenta: null,
            files: { cuenta: null, seguridad: null },
            loading: false
        },

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

        abrirModalAdjuntos(cuenta) {
            this.modalAdjuntos.open = true;
            this.modalAdjuntos.cuenta = cuenta;
            this.modalAdjuntos.files = { cuenta: null, seguridad: null };
            this.modalAdjuntos.loading = false;
        },

        cerrarModalAdjuntos() {
            this.modalAdjuntos.open = false;
            this.modalAdjuntos.cuenta = null;
            this.modalAdjuntos.files = { cuenta: null, seguridad: null };
            this.modalAdjuntos.loading = false;
        },

        fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ""));
                reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
                reader.readAsDataURL(file);
            });
        },

        validarPdf(file, etiqueta) {
            if (!file) return `${etiqueta} es obligatorio`;
            if (file.type !== "application/pdf") return `${etiqueta} debe estar en PDF`;
            const maxBytes = 8 * 1024 * 1024;
            if (file.size > maxBytes) return `${etiqueta} supera el máximo de 8MB`;
            return null;
        },

        async subirAdjuntos() {
            const cuentaId = this.modalAdjuntos.cuenta?.id;
            const fileCuenta = this.modalAdjuntos.files.cuenta;
            const fileSeguridad = this.modalAdjuntos.files.seguridad;

            const errCuenta = this.validarPdf(fileCuenta, "Cuenta de cobro firmada");
            if (errCuenta) return alert(errCuenta);
            const errSeguridad = this.validarPdf(fileSeguridad, "Seguridad social");
            if (errSeguridad) return alert(errSeguridad);
            if (!cuentaId) return alert("No se encontró la cuenta de cobro");

            this.modalAdjuntos.loading = true;
            try {
                const cuentaBase64 = await this.fileToBase64(fileCuenta);
                const seguridadBase64 = await this.fileToBase64(fileSeguridad);

                await axios.post(`${API}/cuentas-cobro/${cuentaId}/adjuntos`, {
                    cuenta_pdf_nombre: fileCuenta.name,
                    cuenta_pdf_base64: cuentaBase64,
                    seguridad_social_nombre: fileSeguridad.name,
                    seguridad_social_base64: seguridadBase64
                });

                alert("Soportes cargados exitosamente");
                this.cerrarModalAdjuntos();
                await this.cargarHistorial();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al cargar el archivo. Por favor verifique su conexión o intente más tarde.";
                alert(msg);
            } finally {
                this.modalAdjuntos.loading = false;
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
