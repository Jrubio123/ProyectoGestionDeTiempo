// js/mis-cuentas-cobros.js
window.misCuentasApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        usuario: { id: null },
        cuentas: [],
        filtros: { inicio: "", fin: "" },
        modal: { open: false, data: null, detalles: [] },
        modalSubir: { open: false, cuenta: null, archivos: [], subiendo: false, error: "" },
        modalDocs: { open: false, docs: [] },
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
            const firma = cuenta?.datos_adjuntos?.firma || {};
            const firmaEstado = String(firma.estado || "").toLowerCase().trim();
            if (["signed", "firmado", "completed", "aprobado"].includes(firmaEstado)) {
                return !firma.documento_firmado?.url;
            }
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
                a.download = `CuentaCobro_${cuenta.id.split("-")[0]}.pdf`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (e) {
                alert("No se pudo descargar el PDF");
            }
        },

        abrirSubir(cuenta) {
            if (!cuenta?.id) return;
            this.modalSubir = {
                open: true,
                cuenta,
                archivos: [],
                subiendo: false,
                error: ""
            };
        },

        cerrarSubir() {
            if (this.modalSubir.subiendo) return;
            this.modalSubir = {
                open: false,
                cuenta: null,
                archivos: [],
                subiendo: false,
                error: ""
            };
        },

        async onSeleccionArchivos(event) {
            const input = event?.target;
            const seleccionados = Array.from(input?.files || []);
            const extensionesPermitidas = new Set(["pdf", "jpg", "jpeg", "png"]);
            const tiposPermitidos = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png"]);
            const errores = [];
            this.modalSubir.error = "";

            try {
                for (const file of seleccionados) {
                    const extension = String(file.name || "").toLowerCase().split(".").pop();
                    const tipo = String(file.type || "").toLowerCase();
                    if (!extensionesPermitidas.has(extension) || (tipo && !tiposPermitidos.has(tipo))) {
                        errores.push(`${file.name}: formato no permitido.`);
                        continue;
                    }
                    if (file.size > 8 * 1024 * 1024) {
                        errores.push(`${file.name}: supera el máximo de 8MB.`);
                        continue;
                    }

                    try {
                        const base64 = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(String(reader.result || ""));
                            reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
                            reader.readAsDataURL(file);
                        });
                        this.modalSubir.archivos.push({
                            nombre: file.name,
                            base64,
                            size: file.size,
                            tipo: file.type
                        });
                    } catch (e) {
                        errores.push(`${file.name}: no se pudo leer.`);
                    }
                }
            } finally {
                if (input) input.value = "";
            }

            if (errores.length) {
                this.modalSubir.error = errores.join(" ");
            }
        },

        quitarArchivo(idx) {
            this.modalSubir.archivos.splice(idx, 1);
            this.modalSubir.error = "";
        },

        get puedeAceptarSubida() {
            return this.modalSubir.archivos.length >= 2 && !this.modalSubir.subiendo;
        },

        async confirmarSubida() {
            if (!this.puedeAceptarSubida || !this.modalSubir.cuenta?.id) return;
            this.modalSubir.subiendo = true;
            this.modalSubir.error = "";

            try {
                await axios.post(
                    `${API}/cuentas-cobro/${this.modalSubir.cuenta.id}/documentos`,
                    {
                        archivos: this.modalSubir.archivos.map((archivo) => ({
                            base64: archivo.base64,
                            nombre: archivo.nombre
                        }))
                    }
                );
                this.modalSubir = {
                    open: false,
                    cuenta: null,
                    archivos: [],
                    subiendo: false,
                    error: ""
                };
                await this.cargarHistorial({ reconciliar: false });
                alert("Documentos subidos correctamente.");
            } catch (e) {
                this.modalSubir.error = e?.response?.data?.error || "No se pudieron subir los documentos.";
            } finally {
                this.modalSubir.subiendo = false;
            }
        },

        getDocumentosSubidos(cuenta) {
            const documentos = cuenta?.datos_adjuntos?.soportes?.documentos_manuales;
            return Array.isArray(documentos) ? documentos : [];
        },

        verDocumentos(cuenta) {
            this.modalDocs = {
                open: true,
                docs: this.getDocumentosSubidos(cuenta)
            };
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
            if (this.estaFirmada(cuenta)) return "Registrada";
            const firmaEstado = String(cuenta?.datos_adjuntos?.firma?.estado || "").toLowerCase().trim();
            if (["pending", "in_progress", "en_firma", "started", "sent"].includes(firmaEstado)) return "En proceso";
            return "Pendiente";
        },

        puedeSubir(cuenta) {
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
