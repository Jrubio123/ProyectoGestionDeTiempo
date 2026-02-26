// js/mis-cuentas-cobros.js
window.misCuentasApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const SIGNATURE_SIZE_PERCENT = 20;

    return {
        usuario: { id: null },
        cuentas: [],
        filtros: { inicio: "", fin: "" },
        modal: { open: false, data: null, detalles: [] },
        syncFirmas: {
            reconciling: false,
            lastRunAt: 0,
            cooldownMs: 15000,
            maxPendientes: 4,
            listenersReady: false
        },

        async init() {
            if (window.auth) {
                const u = window.auth.getUser();
                if (u) this.usuario = u;
            }
            this.inicializarAutoSyncFirmas();
            await this.cargarHistorial({ reconciliar: true });
        },

        inicializarAutoSyncFirmas() {
            if (this.syncFirmas.listenersReady) return;
            const refreshFirmas = async () => {
                await this.cargarHistorial({ reconciliar: true });
            };
            window.addEventListener("focus", refreshFirmas);
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") refreshFirmas();
            });
            this.syncFirmas.listenersReady = true;
        },

        async cargarHistorial({ reconciliar = false } = {}) {
            try {
                let url = `${API}/cuentas-cobro/historial/${this.usuario.id || ""}`;
                if (this.filtros.inicio && this.filtros.fin) {
                    url += `?fecha_inicio=${this.filtros.inicio}&fecha_fin=${this.filtros.fin}`;
                }
                const res = await axios.get(url);
                this.cuentas = res.data || [];
                if (reconciliar) {
                    await this.reconciliarFirmasPendientes();
                }
            } catch (e) {
                this.cuentas = [];
            }
        },

        firmaPendiente(cuenta) {
            const firmaEstado = String(cuenta?.datos_adjuntos?.firma?.estado || "").toLowerCase().trim();
            if (["signed", "firmado", "completed", "aprobado"].includes(firmaEstado)) return false;
            if (["pending", "in_progress", "en_firma", "started", "sent", "open", "created"].includes(firmaEstado)) return true;
            const estadoCuenta = String(cuenta?.estado || "").toLowerCase().trim();
            return ["en firma", "pendiente"].includes(estadoCuenta);
        },

        getFirmaReconcilePayload(cuenta) {
            const firma = cuenta?.datos_adjuntos?.firma || {};
            const payload = {};
            if (firma.request_id) payload.request_id = firma.request_id;
            if (firma.contract_id) payload.contract_id = firma.contract_id;
            if (firma.signature_id) payload.signature_id = firma.signature_id;
            if (firma.estado) payload.status = firma.estado;
            return payload;
        },

        async reconciliarFirmasPendientes() {
            if (this.syncFirmas.reconciling) return;
            const now = Date.now();
            if (now - this.syncFirmas.lastRunAt < this.syncFirmas.cooldownMs) return;

            const pendientes = (this.cuentas || [])
                .filter((cuenta) => this.firmaPendiente(cuenta))
                .filter((cuenta) => {
                    const firma = cuenta?.datos_adjuntos?.firma || {};
                    return Boolean(firma.request_id || firma.contract_id || firma.signature_id);
                })
                .slice(0, this.syncFirmas.maxPendientes);

            this.syncFirmas.lastRunAt = now;
            if (pendientes.length === 0) return;

            this.syncFirmas.reconciling = true;
            let huboCambios = false;
            try {
                for (const cuenta of pendientes) {
                    try {
                        const payload = this.getFirmaReconcilePayload(cuenta);
                        const res = await axios.post(`${API}/cuentas-cobro/${cuenta.id}/firma/reconciliar`, payload);
                        const estadoFirma = String(res?.data?.estado_firma || "").toLowerCase().trim();
                        if (["signed", "firmado", "completed", "aprobado"].includes(estadoFirma) || res?.data?.documento_firmado_url) {
                            huboCambios = true;
                        }
                    } catch (e) {
                        // Mantener silencioso para no interrumpir al usuario.
                    }
                }
            } finally {
                this.syncFirmas.reconciling = false;
            }

            if (huboCambios) {
                await this.cargarHistorial({ reconciliar: false });
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

        async iniciarFirma(cuenta) {
            if (!cuenta?.id) return;
            const confirmar = confirm(`Se iniciara la firma digital de la cuenta #${cuenta.id}. Deseas continuar?`);
            if (!confirmar) return;

            try {
                const res = await axios.post(`${API}/cuentas-cobro/${cuenta.id}/firma/iniciar`, {
                    signature_size_percent: SIGNATURE_SIZE_PERCENT
                });
                const urlFirma = res?.data?.url_firma || "";
                if (urlFirma) {
                    window.open(urlFirma, "_blank", "noopener");
                    alert("Proceso de firma iniciado. Completa la firma en la nueva pestana.");
                    setTimeout(() => this.cargarHistorial({ reconciliar: true }), 10000);
                    setTimeout(() => this.cargarHistorial({ reconciliar: true }), 25000);
                } else {
                    alert("Se inicio el proceso, pero no se recibio una URL de firma.");
                }
                await this.cargarHistorial({ reconciliar: true });
            } catch (e) {
                const msg = e?.response?.data?.error || "No se pudo iniciar la firma digital.";
                alert(msg);
            }
        },

        getUrlCuentaFirmada(cuenta) {
            return (
                cuenta?.datos_adjuntos?.soportes?.cuenta_cobro_firmada?.url ||
                cuenta?.datos_adjuntos?.firma?.documento_firmado?.url ||
                ""
            );
        },

        abrirCuentaFirmada(cuenta) {
            const url = this.getUrlCuentaFirmada(cuenta);
            if (!url) {
                alert("La cuenta firmada aun no esta disponible.");
                return;
            }
            window.open(url, "_blank", "noopener,noreferrer");
        },

        estaFirmada(cuenta) {
            const estado = String(cuenta?.estado || "").toLowerCase().trim();
            if (estado === "aprobado") return true;

            const firmaEstado = String(cuenta?.datos_adjuntos?.firma?.estado || "").toLowerCase().trim();
            if (["signed", "firmado", "completed", "aprobado"].includes(firmaEstado)) return true;

            return Boolean(this.getUrlCuentaFirmada(cuenta));
        },

        estadoFirma(cuenta) {
            if (this.estaFirmada(cuenta)) return "Firmada";
            const firmaEstado = String(cuenta?.datos_adjuntos?.firma?.estado || "").toLowerCase().trim();
            if (["pending", "in_progress", "en_firma"].includes(firmaEstado)) return "En firma";
            if (["rejected", "rechazado", "cancelado", "failed"].includes(firmaEstado)) return "Rechazada";
            if (firmaEstado) return firmaEstado;
            return String(cuenta?.estado || "Pendiente");
        },

        puedeFirmar(cuenta) {
            return !this.estaFirmada(cuenta);
        },

        limpiarFiltros() {
            this.filtros = { inicio: "", fin: "" };
            this.cargarHistorial({ reconciliar: true });
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
