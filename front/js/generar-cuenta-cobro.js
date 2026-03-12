// js/generar-cuenta-cobro.js
window.cuentaCobroApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        registros: [],
        usuarioId: null,
        totalBackend: 0,
        monedaBackend: "",
        modalFirma: {
            open: false,
            loading: false,
            cuentaId: "",
            urlFirma: "",
            mensaje: ""
        },

        form: {
            fecha_inicio: "",
            fecha_fin: "",
            total_letras: "",
            ciudad_cobro: ""
        },

        async init() {
            if (window.auth) {
                const u = window.auth.getUser();
                if (u) this.usuarioId = u.id;
            }
            await this.cargarRegistros();
        },

        async cargarRegistros() {
            try {
                const id = this.usuarioId || "";
                const res = await axios.get(`${API}/horas-por-cobrar/${id}`);
                this.registros = (res.data || []).map((r) => ({
                    ...r,
                    ...this.parseCaseData(r.nro_caso_int_ext, r),
                    checked: false
                }));
                this.actualizarPeriodo();
            } catch (e) {
                this.registros = [];
            }
        },

        get totalSeleccionado() {
            if (this.totalBackend > 0) return this.totalBackend;
            return this.registros
                .filter((r) => r.checked)
                .reduce((sum, r) => sum + parseFloat(r.total_cobrar || 0), 0);
        },

        get isValid() {
            return (
                this.totalSeleccionado > 0 &&
                this.form.fecha_inicio &&
                this.form.fecha_fin &&
                this.form.total_letras &&
                this.form.ciudad_cobro
            );
        },

        toDateOnly(value) {
            return String(value || "").split("T")[0];
        },

        toggleAll() {
            const allChecked = this.registros.every((r) => r.checked);
            this.registros.forEach((r) => (r.checked = !allChecked));
            this.actualizarPeriodo();
            this.actualizarLetras();
        },

        actualizarPeriodo() {
            const sel = this.registros.filter((r) => r.checked);
            if (sel.length === 0) {
                this.form.fecha_inicio = "";
                this.form.fecha_fin = "";
                this.form.total_letras = "";
                this.totalBackend = 0;
                return;
            }
            // El periodo se diligencia manualmente por el usuario.
        },

        async actualizarLetras() {
            const seleccionados = this.registros.filter((r) => r.checked).map((r) => r.id);
            if (seleccionados.length === 0 || !this.usuarioId) return;

            try {
                const res = await axios.post(`${API}/cuentas-cobro/preview`, {
                    consultor_id: this.usuarioId,
                    ids_reportes: seleccionados
                });

                this.totalBackend = Number(res.data?.total || 0);
                this.form.total_letras = res.data?.total_letras || "";
                this.monedaBackend = res.data?.moneda || "";
            } catch (e) {
                this.totalBackend = 0;
            }
        },

        async iniciarFirma(cuentaId) {
            this.modalFirma = {
                open: true,
                loading: true,
                cuentaId,
                urlFirma: "",
                mensaje: "Iniciando proceso de firma digital..."
            };

            try {
                const res = await axios.post(`${API}/cuentas-cobro/${cuentaId}/firma/iniciar`);
                const urlFirma = res?.data?.url_firma || "";
                if (!urlFirma) {
                    this.modalFirma.mensaje = "La cuenta se genero, pero no se recibio URL de firma.";
                    return;
                }

                this.modalFirma.urlFirma = urlFirma;
                this.modalFirma.mensaje = "Cuenta generada. Abre el enlace para firmar.";
                window.open(urlFirma, "_blank", "noopener");
            } catch (e) {
                const msg = e?.response?.data?.error || "La cuenta se genero, pero no se pudo iniciar firma en este momento.";
                this.modalFirma.mensaje = msg;
            } finally {
                this.modalFirma.loading = false;
            }
        },

        async generarCuenta() {
            if (!confirm("Estas seguro de generar e iniciar firma de esta cuenta de cobro?")) return;

            const seleccionados = this.registros.filter((r) => r.checked).map((r) => r.id);
            if (seleccionados.length === 0) return;

            const payload = {
                consultor_id: this.usuarioId,
                fecha_inicio: this.toDateOnly(this.form.fecha_inicio),
                fecha_fin: this.toDateOnly(this.form.fecha_fin),
                total_letras: this.form.total_letras,
                ciudad_cobro: this.form.ciudad_cobro,
                total_numeros: this.totalSeleccionado,
                ids_reportes: seleccionados
            };

            try {
                const created = await axios.post(`${API}/cuentas-cobro`, payload);
                const cuentaId = created?.data?.cuenta?.id || "";

                this.form = { fecha_inicio: "", fecha_fin: "", total_letras: "", ciudad_cobro: "" };
                await this.cargarRegistros();

                if (!cuentaId) {
                    alert("Cuenta generada, pero no se pudo obtener el id para firma.");
                    return;
                }

                await this.iniciarFirma(cuentaId);
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al generar la cuenta";
                alert(msg);
            }
        },

        cerrarModalFirma() {
            this.modalFirma = {
                open: false,
                loading: false,
                cuentaId: "",
                urlFirma: "",
                mensaje: ""
            };
        },

        async copiarEnlaceFirma() {
            if (!this.modalFirma.urlFirma) return;
            try {
                await navigator.clipboard.writeText(this.modalFirma.urlFirma);
                alert("Enlace de firma copiado");
            } catch (e) {
                alert("No se pudo copiar el enlace");
            }
        },

        irHistorialCobros() {
            window.location.hash = "#mis-cuentas-cobros";
        },

        parseCaseData(rawValue, row = {}) {
            const fallbackCliente = String(row?.nro_caso_cliente || "").trim() || null;
            const fallbackInterno = String(row?.nro_caso_interno || "").trim() || null;
            const raw = String(rawValue ?? "").trim();
            if (!raw) {
                return {
                    nro_caso_cliente: fallbackCliente,
                    nro_caso_interno: fallbackInterno
                };
            }
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    const cliente = String(
                        parsed.nro_caso_cliente ?? parsed.cliente ?? parsed.caso_cliente ?? fallbackCliente ?? ""
                    ).trim() || null;
                    const interno = String(
                        parsed.nro_caso_interno ?? parsed.interno ?? parsed.caso_interno ?? fallbackInterno ?? ""
                    ).trim() || null;
                    if (cliente || interno) {
                        return { nro_caso_cliente: cliente, nro_caso_interno: interno };
                    }
                }
            } catch (err) {
                // Texto legacy: se replica en ambos campos por compatibilidad visual.
            }
            return {
                nro_caso_cliente: fallbackCliente || raw,
                nro_caso_interno: fallbackInterno || raw
            };
        },

        resumenCaso(item) {
            const cliente = String(item?.nro_caso_cliente || "").trim();
            const interno = String(item?.nro_caso_interno || "").trim();
            if (cliente && interno) return `Caso cliente: ${cliente} | Caso interno: ${interno}`;
            if (cliente) return `Caso cliente: ${cliente}`;
            if (interno) return `Caso interno: ${interno}`;
            const req = String(item?.requerimiento || "").trim();
            if (req) return `Req: ${req}`;
            return "Sin caso";
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
