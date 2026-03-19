window.firmaContratosApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    function getHeaders() {
        const token = window.auth?.getToken?.() || localStorage.getItem("token");
        return { Authorization: `Bearer ${token}` };
    }

    return {
        tokens: [],
        candidatos: { solicitudes: [], preregistros: [] },
        cargando: false,
        filtroTexto: "",
        filtroEstado: "todos",

        modal: {
            tipo: null,        // 'generar' | 'detalle' | 'anular'
            fuente: "solicitud",
            solicitud_id: "",
            preregistro_id: "",
            nombre_persona: "",
            correo_personal: "",
            item: null,
            error: "",
            exito: false,
            guardando: false
        },

        async init() {
            await Promise.all([this.cargar(), this.cargarCandidatos()]);
        },

        async cargar() {
            this.cargando = true;
            try {
                const res = await axios.get(`${API}/admin/firma-contratos`, { headers: getHeaders() });
                this.tokens = res.data || [];
            } catch (e) {
                console.error("Error cargando tokens:", e);
                this.tokens = [];
            } finally {
                this.cargando = false;
            }
        },

        async cargarCandidatos() {
            try {
                const res = await axios.get(`${API}/admin/firma-contratos/candidatos`, { headers: getHeaders() });
                this.candidatos = res.data || { solicitudes: [], preregistros: [] };
            } catch (e) {
                this.candidatos = { solicitudes: [], preregistros: [] };
            }
        },

        get tokensFiltrados() {
            const q = (this.filtroTexto || "").toLowerCase().trim();
            return this.tokens.filter(t => {
                if (this.filtroEstado !== "todos" && t.estado !== this.filtroEstado) return false;
                if (q) {
                    const nombre = (t.nombre_persona || "").toLowerCase();
                    const correo = (t.correo_personal || "").toLowerCase();
                    if (!nombre.includes(q) && !correo.includes(q)) return false;
                }
                return true;
            });
        },

        normalizeDocIndex(value) {
            const n = Number(value);
            return Number.isInteger(n) && n > 0 ? n : 0;
        },

        getDocFirmaEstado(token, idx) {
            const docs = Array.isArray(token.docs_firma) ? token.docs_firma : [];
            const target = this.normalizeDocIndex(idx);
            return docs.find(d => this.normalizeDocIndex(d?.doc_index) === target)?.estado || null;
        },

        getDocFirmaIndices(token) {
            const docs = Array.isArray(token?.docs_firma) ? token.docs_firma : [];
            return [...new Set(
                docs
                    .map(d => this.normalizeDocIndex(d?.doc_index))
                    .filter(n => n > 0)
            )].sort((a, b) => a - b);
        },

        getChecksRequiredKeys(token) {
            const fromApi = Array.isArray(token?.checks_requeridos) ? token.checks_requeridos.filter(Boolean) : [];
            if (fromApi.length) return fromApi;
            const checks = token?.checks_completados && typeof token.checks_completados === "object"
                ? token.checks_completados
                : {};
            const keys = Object.keys(checks);
            if (!keys.length) return ["pdf1", "pdf2", "pdf3", "pdf4", "pdf5"];
            return keys.sort((a, b) => {
                const aMatch = String(a).match(/^pdf(\d+)$/i);
                const bMatch = String(b).match(/^pdf(\d+)$/i);
                if (aMatch && bMatch) return Number(aMatch[1]) - Number(bMatch[1]);
                if (aMatch) return -1;
                if (bMatch) return 1;
                return String(a).localeCompare(String(b));
            });
        },

        isCheckDone(token, key) {
            const checks = token?.checks_completados && typeof token.checks_completados === "object"
                ? token.checks_completados
                : {};
            return !!checks[key];
        },

        getCheckLabel(key, idx = 0) {
            const raw = String(key || "").trim();
            const legacy = raw.match(/^pdf(\d+)$/i);
            if (legacy) return `Doc ${legacy[1]}`;
            if (!raw) return `Doc ${idx + 1}`;
            const pretty = raw.replace(/_/g, " ").replace(/\s+/g, " ").trim();
            if (!pretty) return `Doc ${idx + 1}`;
            return pretty.charAt(0).toUpperCase() + pretty.slice(1);
        },

        abrirModalGenerar() {
            this.modal = {
                tipo: "generar",
                fuente: "solicitud",
                solicitud_id: "",
                preregistro_id: "",
                nombre_persona: "",
                correo_personal: "",
                item: null,
                error: "",
                exito: false,
                guardando: false
            };
        },

        autocompletarDesde(fuente) {
            if (fuente === "solicitud" && this.modal.solicitud_id) {
                const s = this.candidatos.solicitudes.find(x => x.id === this.modal.solicitud_id);
                if (s) {
                    this.modal.nombre_persona = s.nombre_completo || "";
                    this.modal.correo_personal = s.correo_personal || "";
                }
            } else if (fuente === "preregistro" && this.modal.preregistro_id) {
                const p = this.candidatos.preregistros.find(x => x.id === this.modal.preregistro_id);
                if (p) {
                    this.modal.nombre_persona = p.nombre_completo || "";
                    this.modal.correo_personal = p.correo_personal || "";
                }
            }
        },

        async generarToken() {
            this.modal.error = "";
            if (!this.modal.nombre_persona.trim() || !this.modal.correo_personal.trim()) {
                this.modal.error = "Nombre y correo son obligatorios.";
                return;
            }

            this.modal.guardando = true;
            try {
                const payload = {
                    nombre_persona: this.modal.nombre_persona,
                    correo_personal: this.modal.correo_personal,
                    solicitud_id: this.modal.fuente === "solicitud" ? this.modal.solicitud_id || null : null,
                    preregistro_id: this.modal.fuente === "preregistro" ? this.modal.preregistro_id || null : null
                };

                if (!payload.solicitud_id && !payload.preregistro_id) {
                    payload.solicitud_id = null;
                    payload.preregistro_id = null;
                }

                await axios.post(`${API}/admin/firma-contratos/generar`, payload, { headers: getHeaders() });
                this.modal.exito = true;
                await this.cargar();
            } catch (e) {
                this.modal.error = e?.response?.data?.error || "Error generando el proceso. Intenta de nuevo.";
            } finally {
                this.modal.guardando = false;
            }
        },

        async reenviarCorreo(token) {
            if (!confirm(`¿Reenviar el correo a ${token.correo_personal}?`)) return;
            try {
                const solId = token.solicitud_public_id || null;
                const preId = token.preregistro_public_id || null;
                await axios.post(`${API}/admin/firma-contratos/generar`, {
                    nombre_persona: token.nombre_persona,
                    correo_personal: token.correo_personal,
                    solicitud_id: solId,
                    preregistro_id: preId
                }, { headers: getHeaders() });
                alert("Correo reenviado correctamente.");
                await this.cargar();
            } catch (e) {
                alert(e?.response?.data?.error || "Error reenviando correo.");
            }
        },

        verDetalle(token) {
            this.modal = { ...this.modal, tipo: "detalle", item: token };
        },

        confirmarAnular(token) {
            this.modal = { ...this.modal, tipo: "anular", item: token };
        },

        async anularToken() {
            if (!this.modal.item?.id) return;
            try {
                await axios.delete(`${API}/admin/firma-contratos/${this.modal.item.id}`, { headers: getHeaders() });
                this.modal.tipo = null;
                await this.cargar();
            } catch (e) {
                alert(e?.response?.data?.error || "Error anulando el proceso.");
            }
        },

        formatDate(dateStr) {
            if (!dateStr) return "—";
            try {
                return new Date(dateStr).toLocaleDateString("es-CO", {
                    day: "2-digit", month: "short", year: "numeric"
                });
            } catch { return dateStr; }
        }
    };
};
