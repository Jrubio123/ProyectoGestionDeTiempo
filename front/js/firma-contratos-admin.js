window.firmaContratosApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    const MODALIDAD_LABELS = {
        full_time: "Full time",
        medio_tiempo: "Medio tiempo",
        horas: "Por horas",
        capacitacion: "Capacitación",
        proyecto: "Proyecto"
    };

    function getHeaders() {
        const token = window.auth?.getToken?.() || localStorage.getItem("token");
        const graphToken = window.auth?.getGraphToken?.() || localStorage.getItem("graph_access_token");
        const headers = { Authorization: `Bearer ${token}` };
        if (graphToken) {
            headers["X-Graph-Access-Token"] = graphToken;
        }
        return headers;
    }

    return {
        tokens: [],
        // candidatos: lista unificada de personas (de tabla personas + en-vuelo)
        // Cada entrada tiene: persona_key, nombre_completo, correo_personal, numero_documento,
        //   origen ('persona' | 'en_vuelo'), asignaciones[]
        // Cada asignacion: { id, fuente ('solicitud'|'preregistro'), modalidad, estado, tiene_token_activo }
        candidatos: { candidatos: [] },
        cargando: false,
        autoRefreshMs: 10000,
        _refreshTimer: null,
        filtroTexto: "",
        filtroEstado: "todos",

        modal: {
            tipo: null,        // 'generar' | 'detalle' | 'anular'
            persona_key: "",
            asignacion_id: "",
            nombre_persona: "",
            correo_personal: "",
            item: null,
            error: "",
            exito: false,
            guardando: false
        },

        async init() {
            await Promise.all([this.cargar(), this.cargarCandidatos()]);
            this.iniciarAutoRefresh();
            if (!this._onUnload) {
                this._onUnload = () => this.detenerAutoRefresh();
                window.addEventListener("beforeunload", this._onUnload);
            }
        },

        async cargar({ silencioso = false } = {}) {
            if (!silencioso) this.cargando = true;
            try {
                const res = await axios.get(`${API}/admin/firma-contratos`, {
                    headers: getHeaders(),
                    params: { _ts: Date.now() }
                });
                this.tokens = res.data || [];
            } catch (e) {
                console.error("Error cargando tokens:", e);
                if (!silencioso) this.tokens = [];
            } finally {
                if (!silencioso) this.cargando = false;
            }
        },

        async cargarCandidatos() {
            try {
                const res = await axios.get(`${API}/admin/firma-contratos/candidatos`, { headers: getHeaders() });
                this.candidatos = res.data || { candidatos: [] };
            } catch (e) {
                this.candidatos = { candidatos: [] };
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

        get personaSeleccionada() {
            if (!this.modal.persona_key) return null;
            return (this.candidatos.candidatos || []).find(p => p.persona_key === this.modal.persona_key) || null;
        },

        get asignacionesDePersona() {
            return this.personaSeleccionada?.asignaciones || [];
        },

        get asignacionSeleccionada() {
            if (!this.modal.asignacion_id) return null;
            return this.asignacionesDePersona.find(a => a.id === this.modal.asignacion_id) || null;
        },

        formatModalidad(modalidad) {
            if (!modalidad) return "Sin modalidad";
            return MODALIDAD_LABELS[modalidad] || modalidad;
        },

        labelAsignacion(a) {
            const modalidad = this.formatModalidad(a.modalidad);
            const estado = a.estado || "";
            const warning = a.tiene_token_activo ? " ⚠ proceso activo" : "";
            return `${modalidad} — ${estado}${warning}`;
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

        iniciarAutoRefresh() {
            this.detenerAutoRefresh();
            this._refreshTimer = setInterval(() => {
                this.cargar({ silencioso: true });
            }, this.autoRefreshMs);
        },

        detenerAutoRefresh() {
            if (this._refreshTimer) {
                clearInterval(this._refreshTimer);
                this._refreshTimer = null;
            }
        },

        abrirModalGenerar() {
            this.modal = {
                tipo: "generar",
                persona_key: "",
                asignacion_id: "",
                nombre_persona: "",
                correo_personal: "",
                item: null,
                error: "",
                exito: false,
                guardando: false
            };
        },

        onPersonaSeleccionada() {
            this.modal.asignacion_id = "";
            this.modal.nombre_persona = "";
            this.modal.correo_personal = "";
            const persona = this.personaSeleccionada;
            if (!persona) return;
            this.modal.nombre_persona = persona.nombre_completo || "";
            this.modal.correo_personal = persona.correo_personal || "";
            const asignaciones = persona.asignaciones || [];
            if (asignaciones.length === 1) {
                this.modal.asignacion_id = asignaciones[0].id;
            }
        },

        async generarToken() {
            this.modal.error = "";
            if (!this.modal.asignacion_id) {
                this.modal.error = "Selecciona la persona y la asignación para generar el contrato.";
                return;
            }
            if (!this.modal.nombre_persona.trim() || !this.modal.correo_personal.trim()) {
                this.modal.error = "Nombre y correo son obligatorios.";
                return;
            }

            const asignacion = this.asignacionSeleccionada;
            if (!asignacion) {
                this.modal.error = "Asignación no válida.";
                return;
            }

            this.modal.guardando = true;
            try {
                const payload = {
                    nombre_persona: this.modal.nombre_persona,
                    correo_personal: this.modal.correo_personal,
                    solicitud_id: asignacion.fuente === "solicitud" ? asignacion.id : null,
                    preregistro_id: asignacion.fuente === "preregistro" ? asignacion.id : null
                };

                const res = await axios.post(`${API}/admin/firma-contratos/generar`, payload, { headers: getHeaders() });
                const correoDestino = String(res?.data?.correo_destino || "").trim();
                if (correoDestino) {
                    this.modal.correo_personal = correoDestino;
                }
                this.modal.exito = true;
                await Promise.all([this.cargar(), this.cargarCandidatos()]);
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
                await Promise.all([this.cargar(), this.cargarCandidatos()]);
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
