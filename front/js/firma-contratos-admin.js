window.firmaContratosApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    function getHeaders() {
        const token = window.auth?.getToken?.() || localStorage.getItem("token");
        const graphToken = window.auth?.getGraphToken?.() || localStorage.getItem("graph_access_token");
        const headers = { Authorization: `Bearer ${token}` };
        if (graphToken) {
            headers["X-Graph-Access-Token"] = graphToken;
        }
        return headers;
    }

    function defaultDatosLaborales() {
        return {
            tipo_trabajador: "",
            cargo: "",
            salario_mensual: "",
            salario_moneda: "COP",
            periodo_pago: "",
            periodo_prueba: "",
            jefe_inmediato: "",
            caja_compensacion: "",
            condiciones_especiales: "",
            duracion_contrato: "",
            fecha_inicio_labores: "",
            lugar_celebracion: "",
            eps: "",
            afp: "",
            arl: ""
        };
    }

    function normalizeDateInput(value) {
        if (!value) return "";
        return String(value).slice(0, 10);
    }

    function mergeDatosLaborales(datos = {}) {
        return {
            ...defaultDatosLaborales(),
            ...datos,
            salario_mensual: datos.salario_mensual ?? "",
            salario_moneda: datos.salario_moneda || "COP",
            fecha_inicio_labores: normalizeDateInput(datos.fecha_inicio_labores)
        };
    }

    function validarDatosLaborales(datos = {}) {
        const requeridos = [
            ["tipo_trabajador", "Tipo de trabajador"],
            ["cargo", "Cargo u oficio"],
            ["periodo_pago", "Periodo de pago"],
            ["periodo_prueba", "Periodo de prueba"],
            ["jefe_inmediato", "Jefe inmediato"],
            ["eps", "EPS"],
            ["afp", "AFP"],
            ["arl", "ARL"],
            ["caja_compensacion", "Caja de compensacion"],
            ["fecha_inicio_labores", "Fecha de inicio de labores"]
        ];
        const faltantes = requeridos
            .filter(([key]) => !String(datos[key] || "").trim())
            .map(([, label]) => label);
        const salario = Number(datos.salario_mensual);
        if (!Number.isFinite(salario) || salario <= 0) faltantes.push("Salario mensual");
        return faltantes;
    }

    function mensajeFaltantes(faltantes = []) {
        return `Faltan datos laborales obligatorios para el contrato: ${faltantes.join(", ")}`;
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
            nombre_persona: "",
            correo_personal: "",
            tipo_contratacion: "",
            item: null,
            error: "",
            exito: false,
            guardando: false,
            requiere_laboral: false,
            datos_laborales: defaultDatosLaborales(),
            faltantes: []
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
                nombre_persona: "",
                correo_personal: "",
                tipo_contratacion: "",
                item: null,
                error: "",
                exito: false,
                guardando: false,
                requiere_laboral: false,
                datos_laborales: defaultDatosLaborales(),
                faltantes: []
            };
        },

        async onPersonaSeleccionada() {
            this.modal.nombre_persona = "";
            this.modal.correo_personal = "";
            this.modal.tipo_contratacion = "";
            this.modal.requiere_laboral = false;
            this.modal.datos_laborales = defaultDatosLaborales();
            this.modal.faltantes = [];
            this.modal.error = "";
            const persona = this.personaSeleccionada;
            if (!persona) return;
            this.modal.nombre_persona = persona.nombre_completo || "";
            this.modal.correo_personal = persona.correo_personal || "";
            try {
                const params = {};
                if (persona.numero_documento) params.numero_documento = persona.numero_documento;
                if (persona.correo_personal) params.correo_personal = persona.correo_personal;
                const res = await axios.get(`${API}/admin/firma-contratos/datos-laborales`, {
                    headers: getHeaders(),
                    params
                });
                this.modal.tipo_contratacion = res.data?.tipo_contrato === "Vinculado" ? "vinculado" : "todosilver";
                this.modal.requiere_laboral = Boolean(res.data?.requiere_laboral);
                this.modal.datos_laborales = mergeDatosLaborales(res.data?.datos || {});
                this.modal.faltantes = Array.isArray(res.data?.faltantes) ? res.data.faltantes : [];
            } catch (e) {
                this.modal.error = e?.response?.data?.error || "No fue posible consultar datos laborales.";
            }
        },

        async generarToken() {
            this.modal.error = "";
            if (!this.modal.persona_key) {
                this.modal.error = "Selecciona una persona para generar el contrato.";
                return;
            }
            if (!this.modal.nombre_persona.trim() || !this.modal.correo_personal.trim()) {
                this.modal.error = "Nombre y correo son obligatorios.";
                return;
            }
            if (!["vinculado", "todosilver"].includes(this.modal.tipo_contratacion)) {
                this.modal.error = "Selecciona el tipo de contratación.";
                return;
            }

            const persona = this.personaSeleccionada;
            this.modal.guardando = true;
            try {
                if (this.modal.requiere_laboral) {
                    const faltantes = validarDatosLaborales(this.modal.datos_laborales);
                    if (faltantes.length) {
                        this.modal.faltantes = faltantes;
                        this.modal.error = mensajeFaltantes(faltantes);
                        return;
                    }
                    await axios.put(`${API}/admin/firma-contratos/datos-laborales`, {
                        numero_documento: persona?.numero_documento || null,
                        correo_personal: persona?.correo_personal || this.modal.correo_personal || null,
                        ...this.modal.datos_laborales
                    }, { headers: getHeaders() });
                }

                const payload = {
                    nombre_persona: this.modal.nombre_persona,
                    correo_personal: this.modal.correo_personal,
                    tipo_contratacion: this.modal.tipo_contratacion,
                    numero_documento: persona?.numero_documento || null
                };

                const res = await axios.post(`${API}/admin/firma-contratos/generar`, payload, { headers: getHeaders() });
                const correoDestino = String(res?.data?.correo_destino || "").trim();
                if (correoDestino) {
                    this.modal.correo_personal = correoDestino;
                }
                this.modal.exito = true;
                await Promise.all([this.cargar(), this.cargarCandidatos()]);
            } catch (e) {
                const missing = e?.response?.data?.missing;
                if (Array.isArray(missing) && missing.length) {
                    this.modal.faltantes = missing;
                    this.modal.error = mensajeFaltantes(missing);
                } else {
                    this.modal.error = e?.response?.data?.error || "Error generando el proceso. Intenta de nuevo.";
                }
            } finally {
                this.modal.guardando = false;
            }
        },

        getTipoContratacionToken(token) {
            const docs = Array.isArray(token?.docs_firma) ? token.docs_firma : [];
            const esVinculado = docs.some(d => {
                const docKey = String(d?.doc_key || "").trim();
                return d?.folder === "vinculado" || docKey === "cl_termino_indefinido" || docKey.endsWith("_vinculado");
            });
            return esVinculado ? "vinculado" : "todosilver";
        },

        async reenviarCorreo(token) {
            if (!confirm(`¿Reenviar el correo a ${token.correo_personal}?`)) return;
            try {
                await axios.post(`${API}/admin/firma-contratos/generar`, {
                    nombre_persona: token.nombre_persona,
                    correo_personal: token.correo_personal,
                    tipo_contratacion: this.getTipoContratacionToken(token),
                    solicitud_id: token.solicitud_public_id || null,
                    preregistro_id: token.preregistro_public_id || null
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
