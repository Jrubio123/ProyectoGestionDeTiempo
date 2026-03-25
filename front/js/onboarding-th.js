window.onboardingThApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    const FILTER_LABELS = Object.freeze({
        all: "Mostrando todos",
        coord: "Filtrando: Pendiente Coordinador",
        th: "Filtrando: Pendiente Revision TH",
        silver: "Filtrando: Pendiente Correo Silver",
        done: "Filtrando: Completado",
        voided: "Filtrando: Anulado"
    });

    const PILL_TEXT = Object.freeze({
        coord: "P. COORD",
        th: "P. TH",
        silver: "P. SILVER",
        done: "COMPLETADO",
        voided: "ANULADO",
        all: "REGISTRO"
    });

    const ANEXO_TIPO_LABELS = Object.freeze({
        full_time: "Full time",
        medio_tiempo: "Medio tiempo",
        proyecto: "Proyecto",
        horas: "Horas",
        capacitacion: "Capacitacion"
    });

    const emptyS3 = () => ({
        direccion: "",
        tipo_persona: "Natural",
        banco_id: "",
        tipo_cuenta: "Ahorros",
        numero_cuenta: "",
        correo_silver: ""
    });

    const todayYmd = () => {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    };

    const emptyAnexoItemForm = () => ({
        usuario_id: "",
        tipo_asignacion: "full_time",
        cliente_id: "",
        modulo_id: "",
        moneda: "COP",
        valor_tarifa: "",
        fecha_inicio: todayYmd(),
        fecha_fin: "",
        correo_personal: ""
    });

    return {
        vistaActiva: "contrataciones",

        preregistros: [],
        bancos: [],
        filtro: "all",
        busqueda: "",
        modalDetalle: false,
        modalAnular: false,
        guardandoS3: false,
        aprobando: false,
        anulando: false,
        itemActivo: null,
        formS3: emptyS3(),
        motivoAnulacion: "",
        estadoCards: [
            { key: "all", label: "Todos", tone: "tone-all" },
            { key: "coord", label: "Pendiente Coordinador", tone: "tone-coord" },
            { key: "th", label: "Pendiente Revision TH", tone: "tone-th" },
            { key: "silver", label: "Pendiente Correo Silver", tone: "tone-silver" },
            { key: "done", label: "Completado", tone: "tone-done" },
            { key: "voided", label: "Anulado", tone: "tone-voided" }
        ],

        anexoCatalogos: {
            clientes: [],
            modulos: []
        },
        anexoBusqueda: "",
        anexoBuscando: false,
        anexoResultados: [],
        usuarioAnexo: null,
        anexoCargandoItems: false,
        anexoItemsActivos: [],
        anexoItemsFinalizados: [],
        anexoTokenActivo: null,
        anexoUltimoTokenFirmado: null,
        anexoTieneCambiosDesdeFirma: false,
        anexoCorreoSugerido: "",
        anexoError: "",
        anexoSuccess: "",
        anexoMostrarHistorial: false,
        _anexoSearchTimer: null,

        anexoModalItem: {
            open: false,
            mode: "create",
            loading: false,
            saving: false,
            error: "",
            itemId: "",
            form: emptyAnexoItemForm()
        },
        anexoModalFirma: {
            open: false,
            saving: false,
            downloading: false,
            error: "",
            correo_firmante: ""
        },
        anexoModalCancelar: {
            open: false,
            saving: false,
            error: ""
        },
        anexoModalFinalizar: {
            open: false,
            saving: false,
            error: "",
            item: null
        },

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async requestWithApiFallback(method, path, payload) {
            const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${String(path || "")}`;
            const candidates = [normalizedPath];
            if (normalizedPath.startsWith("/api/")) {
                candidates.push(normalizedPath.replace(/^\/api/, ""));
            } else {
                candidates.push(`/api${normalizedPath}`);
            }

            let lastError = null;
            for (const routePath of [...new Set(candidates)]) {
                try {
                    return await axios({
                        method,
                        url: `${API}${routePath}`,
                        data: payload,
                        ...(this.getAuthConfig() || {})
                    });
                } catch (e) {
                    lastError = e;
                    if (e?.response?.status !== 404) throw e;
                }
            }
            throw lastError;
        },

        async init() {
            await Promise.all([
                this.cargarBancos(),
                this.cargarRegistros(),
                this.cargarCatalogosAnexo()
            ]);
        },

        setVistaActiva(vista) {
            this.vistaActiva = vista;
        },

        async cargarBancos() {
            try {
                const res = await axios.get(`${API}/bancos`, this.getAuthConfig());
                this.bancos = res.data || [];
            } catch (_) {
                this.bancos = [];
            }
        },

        async cargarCatalogosAnexo() {
            try {
                const [clientesRes, modulosRes] = await Promise.all([
                    axios.get(`${API}/clientes`, this.getAuthConfig()),
                    axios.get(`${API}/modulos`, this.getAuthConfig())
                ]);
                this.anexoCatalogos.clientes = Array.isArray(clientesRes?.data) ? clientesRes.data : [];
                this.anexoCatalogos.modulos = Array.isArray(modulosRes?.data) ? modulosRes.data : [];
            } catch (_) {
                this.anexoCatalogos.clientes = [];
                this.anexoCatalogos.modulos = [];
            }
        },

        async cargarRegistros() {
            const [preregistros, solicitudes] = await Promise.all([
                this.fetchPreregistros(),
                this.fetchSolicitudesContratacion()
            ]);

            const itemsPreregistro = preregistros.map((item) => ({
                ...item,
                origen_flujo: "preregistro"
            }));

            const preregistroIds = new Set(
                itemsPreregistro
                    .map((item) => this.normalizarId(item?.id))
                    .filter(Boolean)
            );

            const rrhhSolicitudIds = new Set(
                itemsPreregistro
                    .map((item) => this.normalizarId(item?.solicitud?.id))
                    .filter(Boolean)
            );

            const itemsContratacion = solicitudes
                .filter((item) => {
                    const origen = this.normalizar(item?.datos_extra?.origen || "");
                    if (origen !== "rrhh") return true;

                    const preregistroId = this.normalizarId(item?.datos_extra?.preregistro_id);
                    if (preregistroId && preregistroIds.has(preregistroId)) return false;

                    const rrhhSolicitudId = this.normalizarId(item?.datos_extra?.rrhh_solicitud_id);
                    if (rrhhSolicitudId && rrhhSolicitudIds.has(rrhhSolicitudId)) return false;

                    return true;
                })
                .map((item) => this.mapContratacionToRegistro(item));

            this.preregistros = [...itemsPreregistro, ...itemsContratacion].sort((a, b) => {
                const ta = new Date(a?.updated_at || a?.created_at || 0).getTime();
                const tb = new Date(b?.updated_at || b?.created_at || 0).getTime();
                return tb - ta;
            });
        },

        async fetchPreregistros() {
            try {
                const res = await this.requestWithApiFallback("get", "/api/preregistros?limit=400&page=1");
                return Array.isArray(res?.data?.data) ? res.data.data : [];
            } catch (_) {
                return [];
            }
        },

        async fetchSolicitudesContratacion() {
            try {
                const res = await axios.get(`${API}/contrataciones/solicitudes?limit=400`, this.getAuthConfig());
                return Array.isArray(res?.data) ? res.data : [];
            } catch (_) {
                return [];
            }
        },

        mapContratacionToRegistro(item) {
            const tipoDocumentoTitulo = item?.tipo_documento?.titulo || item?.tipo_documento?.codigo || null;
            const clienteNombre = item?.cliente?.nombre || item?.datos_extra?.cliente_nombre || null;
            const moduloNombre = item?.datos_extra?.modulo || item?.datos_extra?.modulo_nombre || null;
            const origenContratacion = this.normalizar(item?.datos_extra?.origen || "");
            return {
                id: item?.id,
                origen_flujo: "contratacion",
                origen_contratacion: origenContratacion,
                preregistro_id: item?.datos_extra?.preregistro_id || null,
                rrhh_solicitud_id: item?.datos_extra?.rrhh_solicitud_id || null,
                datos_extra: item?.datos_extra || {},
                solicitud: {
                    id: item?.id,
                    perfil: item?.perfil || null,
                    nivel: item?.datos_extra?.nivel || null,
                    estado: item?.estado || null,
                    cliente: { id: item?.cliente?.id || null, nombre: clienteNombre },
                    modulo: { id: item?.datos_extra?.modulo_id || null, nombre: moduloNombre },
                    coordinador: item?.coordinador || null
                },
                nombre: item?.nombre || "",
                apellidos: item?.apellidos || "",
                tipo_documento: tipoDocumentoTitulo,
                numero_documento: item?.numero_documento || null,
                telefono: item?.telefono || null,
                correo_personal: item?.correo_personal || null,
                pais_ubicacion: item?.ubicacion || null,
                ciudad: null,
                responsable_supervisor: null,
                fecha_fin: item?.fecha_fin || null,
                moneda: item?.moneda || null,
                pais_pago: null,
                tarifa_hora: item?.tarifa_hora ?? null,
                tarifa_mes: item?.tarifa_mes ?? null,
                tarifa_medio_tiempo: item?.tarifa_medio_tiempo ?? null,
                tarifa_capacitacion: item?.tarifa_capacitacion ?? null,
                modalidad_contrato: item?.modalidad_contrato || item?.datos_extra?.modalidad_contrato || null,
                vpn_corona: null,
                necesita_s_user: null,
                grupo_usuario: item?.grupo_app_tiempos || null,
                grupo_distribucion: item?.grupo_distribucion || null,
                observaciones: item?.observaciones || null,
                direccion: item?.datos_extra?.direccion || null,
                tipo_persona: item?.datos_extra?.tipo_persona || "Natural",
                banco: item?.datos_extra?.banco_id ? { id: item.datos_extra.banco_id } : null,
                tipo_cuenta: item?.datos_extra?.tipo_cuenta || null,
                numero_cuenta: item?.datos_extra?.numero_cuenta || null,
                correo_silver: item?.correo_empresarial || null,
                estado: item?.estado || "",
                creado_por: item?.coordinador?.id || null,
                creado_por_nombre: item?.coordinador?.nombre || null,
                completado_coordinador_por: item?.coordinador?.id || null,
                completado_coordinador_por_nombre: item?.coordinador?.nombre || null,
                completado_th_por: null,
                completado_th_por_nombre: null,
                aprobado_por: null,
                aprobado_por_nombre: null,
                anulado_por: null,
                anulado_por_nombre: null,
                motivo_anulacion: null,
                id_usuario_creado: item?.persona?.id || null,
                usuario_creado: item?.persona || null,
                fecha_completado_coordinador: item?.updated_at || item?.created_at || null,
                fecha_completado_th: item?.fecha_revision_th || null,
                fecha_aprobacion: item?.estado === "Completado" ? (item?.updated_at || item?.created_at || null) : null,
                fecha_anulacion: null,
                observaciones_th: item?.observaciones_th || null,
                created_at: item?.created_at || null,
                updated_at: item?.updated_at || item?.created_at || null
            };
        },

        normalizar(value) {
            return String(value || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .trim();
        },

        normalizarId(value) {
            return String(value || "")
                .trim()
                .toLowerCase();
        },

        flujoLabel(item) {
            if (item?.origen_flujo === "contratacion" && item?.origen_contratacion === "rrhh") {
                return "Contratacion desde RRHH";
            }
            return item?.origen_flujo === "contratacion" ? "Contratacion directa" : "Preregistro RRHH";
        },

        setFiltro(key) {
            this.filtro = key;
        },

        estadoToKey(estado) {
            const e = this.normalizar(estado);
            if (
                e === "pendiente coordinador" ||
                e === "pendiente" ||
                e === "pendiente confirmacion cliente" ||
                e.startsWith("pendiente confirm")
            ) {
                return "coord";
            }
            if (e === "pendiente revision th" || e === "en proceso") {
                return "th";
            }
            if (e === "pendiente correo silver") return "silver";
            if (e === "completado") return "done";
            if (e === "anulado") return "voided";
            return "all";
        },

        cardTone(estado) {
            return `estado-${this.estadoToKey(estado)}`;
        },

        pillClass(key) {
            return `tone-${key}`;
        },

        pillText(estado) {
            const key = this.estadoToKey(estado);
            return PILL_TEXT[key] || "REGISTRO";
        },

        contarPorKey(key) {
            if (key === "all") return this.preregistros.length;
            return this.preregistros.filter((p) => this.estadoToKey(p?.estado) === key).length;
        },

        coincideBusqueda(item) {
            if (!this.busqueda) return true;
            const q = this.normalizar(this.busqueda);
            const campos = [
                `${item?.nombre || ""} ${item?.apellidos || ""}`,
                item?.solicitud?.perfil || "",
                item?.solicitud?.cliente?.nombre || "",
                item?.numero_documento || "",
                item?.correo_personal || ""
            ].map((value) => this.normalizar(value));
            return campos.some((campo) => campo.includes(q));
        },

        get preregistrosFiltrados() {
            let items = this.preregistros;
            if (this.filtro !== "all") {
                items = items.filter((item) => this.estadoToKey(item?.estado) === this.filtro);
            }
            if (this.busqueda) {
                items = items.filter((item) => this.coincideBusqueda(item));
            }
            return items;
        },

        get tituloFiltro() {
            return FILTER_LABELS[this.filtro] || FILTER_LABELS.all;
        },

        esContratacionPendienteRevisionTh(item) {
            return item?.origen_flujo === "contratacion" && this.normalizar(item?.estado) === "pendiente revision th";
        },

        accionPrincipalLabel(item) {
            if (this.esContratacionPendienteRevisionTh(item)) return "Marcar revision TH";
            if (item?.origen_flujo !== "preregistro") return "Ver detalle";
            if (item.estado === "Pendiente Revision TH") return "Completar revision";
            if (item.estado === "Pendiente Correo Silver") return "Ingresar correo Silver";
            return "Ver detalle";
        },

        accionPrincipalClass(item) {
            if (this.esContratacionPendienteRevisionTh(item)) return "prereg-btn prereg-btn-teal";
            if (item?.origen_flujo !== "preregistro") return "prereg-btn prereg-btn-ghost";
            if (item.estado === "Pendiente Correo Silver") return "prereg-btn prereg-btn-purple";
            if (item.estado === "Pendiente Revision TH") return "prereg-btn prereg-btn-teal";
            return "prereg-btn prereg-btn-ghost";
        },

        buscarPreregistroVinculado(item) {
            if (!item || item?.origen_flujo !== "contratacion") return null;

            const preregistroId = this.normalizarId(item?.preregistro_id || item?.datos_extra?.preregistro_id);
            if (preregistroId) {
                const byPreregistroId = this.preregistros.find(
                    (candidate) => candidate?.origen_flujo === "preregistro" && this.normalizarId(candidate?.id) === preregistroId
                );
                if (byPreregistroId) return byPreregistroId;
            }

            const rrhhSolicitudId = this.normalizarId(item?.rrhh_solicitud_id || item?.datos_extra?.rrhh_solicitud_id);
            if (rrhhSolicitudId) {
                const bySolicitud = this.preregistros.find(
                    (candidate) => candidate?.origen_flujo === "preregistro" && this.normalizarId(candidate?.solicitud?.id) === rrhhSolicitudId
                );
                if (bySolicitud) return bySolicitud;
            }

            return null;
        },

        abrirDetalleResuelto(item, focoCorreo = false) {
            const preregistroVinculado = this.buscarPreregistroVinculado(item);
            if (preregistroVinculado) {
                this.abrirDetalle(preregistroVinculado, preregistroVinculado?.estado === "Pendiente Correo Silver");
                return;
            }
            this.abrirDetalle(item, focoCorreo);
        },

        async ejecutarAccionPrincipal(item) {
            if (!item?.id) return;

            const preregistroVinculado = this.buscarPreregistroVinculado(item);
            if (preregistroVinculado) {
                this.abrirDetalle(preregistroVinculado, preregistroVinculado?.estado === "Pendiente Correo Silver");
                return;
            }

            if (this.esContratacionPendienteRevisionTh(item)) {
                this.abrirDetalle(item, false);
                return;
            }
            this.abrirDetalleResuelto(item, item?.estado === "Pendiente Correo Silver");
        },

        abrirDetalle(item, focoCorreo = false) {
            this.itemActivo = JSON.parse(JSON.stringify(item || {}));
            const rawBancoId = item?.banco?.id ?? item?.banco_id ?? "";
            this.formS3 = {
                direccion: item?.direccion || "",
                tipo_persona: item?.tipo_persona || "Natural",
                banco_id: rawBancoId !== "" && rawBancoId !== null ? String(rawBancoId) : "",
                tipo_cuenta: item?.tipo_cuenta || "Ahorros",
                numero_cuenta: item?.numero_cuenta || "",
                correo_silver: item?.correo_silver || ""
            };
            this.modalDetalle = true;
            if (focoCorreo) {
                setTimeout(() => document.getElementById("thCorreoSilver")?.focus(), 90);
            }
        },

        cerrarDetalle() {
            this.modalDetalle = false;
            this.modalAnular = false;
            this.itemActivo = null;
            this.formS3 = emptyS3();
            this.motivoAnulacion = "";
            this.guardandoS3 = false;
            this.aprobando = false;
            this.anulando = false;
        },

        get seccion3Editable() {
            if (this.itemActivo?.origen_flujo === "preregistro") {
                const estado = this.itemActivo?.estado;
                return estado === "Pendiente Revision TH" || estado === "Pendiente Correo Silver";
            }
            if (this.itemActivo?.origen_flujo === "contratacion") {
                return this.itemActivo?.estado === "Pendiente Revision TH";
            }
            return false;
        },

        get s3BaseValida() {
            const form = this.formS3;
            return !!String(form.direccion || "").trim()
                && !!String(form.tipo_persona || "").trim()
                && !!String(form.banco_id || "").trim()
                && !!String(form.tipo_cuenta || "").trim()
                && !!String(form.numero_cuenta || "").trim();
        },

        get puedeAprobar() {
            if (!this.seccion3Editable || !this.s3BaseValida) return false;
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(this.formS3.correo_silver || "").trim());
        },

        bancoIdPayload() {
            const raw = String(this.formS3.banco_id || "").trim();
            return raw || null;
        },

        modalidadContratoDetalle() {
            return this.itemActivo?.modalidad_contrato
                || this.itemActivo?.solicitud?.modalidad
                || "-";
        },

        formatCurrencyValue(value, moneda) {
            if (value === null || value === undefined || value === "") return null;
            const num = Number(value);
            if (!Number.isFinite(num)) return null;
            try {
                return new Intl.NumberFormat("es-CO", {
                    style: "currency",
                    currency: (moneda || "COP").toUpperCase(),
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2
                }).format(num);
            } catch (_) {
                return `${(moneda || "COP").toUpperCase()} ${num}`;
            }
        },

        tarifaPrincipalDetalle() {
            const modalidad = this.normalizar(this.modalidadContratoDetalle());
            const moneda = this.itemActivo?.moneda || "COP";
            const hora = this.formatCurrencyValue(this.itemActivo?.tarifa_hora, moneda);
            const mes = this.formatCurrencyValue(this.itemActivo?.tarifa_mes, moneda);
            const medio = this.formatCurrencyValue(this.itemActivo?.tarifa_medio_tiempo, moneda);
            const cap = this.formatCurrencyValue(this.itemActivo?.tarifa_capacitacion, moneda);

            if (modalidad === "porhoras") return hora ? `${hora} / hora` : "-";
            if (modalidad === "mediotiempo") return medio || mes || hora || "-";
            if (modalidad === "fulltime" || modalidad === "tiempocompleto") return mes || hora || "-";
            return mes || hora || medio || cap || "-";
        },

        get puedeCompletarContratacion() {
            if (this.itemActivo?.origen_flujo !== "contratacion") return false;
            if (!this.seccion3Editable) return false;
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(this.formS3.correo_silver || "").trim());
        },

        async guardarS3() {
            if (!this.itemActivo?.id || !this.seccion3Editable) return;
            if (!this.s3BaseValida) {
                alert("Completa todos los campos requeridos de la seccion 3.");
                return;
            }
            this.guardandoS3 = true;
            try {
                const payload = {
                    direccion: String(this.formS3.direccion || "").trim(),
                    tipo_persona: String(this.formS3.tipo_persona || "").trim(),
                    banco_id: this.bancoIdPayload(),
                    tipo_cuenta: String(this.formS3.tipo_cuenta || "").trim(),
                    numero_cuenta: String(this.formS3.numero_cuenta || "").trim(),
                    correo_silver: String(this.formS3.correo_silver || "").trim() || null
                };
                if (this.itemActivo.origen_flujo === "contratacion") {
                    await axios.patch(
                        `${API}/contrataciones/solicitudes/${this.itemActivo.id}/seccion-3`,
                        payload,
                        this.getAuthConfig()
                    );
                } else {
                    await this.requestWithApiFallback("patch", `/api/preregistros/${this.itemActivo.id}/seccion-3`, payload);
                }
                await this.cargarRegistros();
                this.cerrarDetalle();
            } catch (e) {
                alert(e?.response?.data?.error || "Error guardando seccion 3");
            } finally {
                this.guardandoS3 = false;
            }
        },

        async completarRevisionContratacion() {
            if (!this.puedeCompletarContratacion) return;
            if (!confirm("Quieres completar la revision TH de esta contratacion?")) return;
            this.aprobando = true;
            try {
                await axios.patch(
                    `${API}/contrataciones/solicitudes/${this.itemActivo.id}/seccion-3`,
                    {
                        direccion: String(this.formS3.direccion || "").trim(),
                        tipo_persona: String(this.formS3.tipo_persona || "").trim(),
                        banco_id: this.bancoIdPayload(),
                        tipo_cuenta: String(this.formS3.tipo_cuenta || "").trim(),
                        numero_cuenta: String(this.formS3.numero_cuenta || "").trim(),
                        correo_silver: String(this.formS3.correo_silver || "").trim() || null
                    },
                    this.getAuthConfig()
                );
                await axios.patch(
                    `${API}/contrataciones/solicitudes/${this.itemActivo.id}/revision-th`,
                    { observaciones_th: null },
                    this.getAuthConfig()
                );
                await this.cargarRegistros();
                this.cerrarDetalle();
            } catch (e) {
                alert(e?.response?.data?.error || "Error completando revision TH");
            } finally {
                this.aprobando = false;
            }
        },

        async aprobarPreregistro() {
            if (this.itemActivo?.origen_flujo !== "preregistro") return;
            if (!this.itemActivo?.id || !this.puedeAprobar) return;
            this.aprobando = true;
            try {
                await this.requestWithApiFallback("post", `/api/preregistros/${this.itemActivo.id}/aprobar`, {});
                await this.cargarRegistros();
                this.cerrarDetalle();
            } catch (e) {
                alert(e?.response?.data?.error || "Error aprobando preregistro");
            } finally {
                this.aprobando = false;
            }
        },

        abrirModalAnular() {
            this.modalAnular = true;
            this.motivoAnulacion = "";
        },

        async confirmarAnulacion() {
            if (this.itemActivo?.origen_flujo !== "preregistro") return;
            if (!this.itemActivo?.id) return;
            if (String(this.motivoAnulacion || "").trim().length < 20) {
                alert("El motivo debe tener al menos 20 caracteres.");
                return;
            }
            this.anulando = true;
            try {
                await this.requestWithApiFallback("post", `/api/preregistros/${this.itemActivo.id}/anular`, {
                    motivo_anulacion: String(this.motivoAnulacion || "").trim()
                });
                await this.cargarRegistros();
                this.cerrarDetalle();
            } catch (e) {
                alert(e?.response?.data?.error || "Error anulando preregistro");
            } finally {
                this.anulando = false;
            }
        },

        setAnexoFeedback({ error = "", success = "" } = {}) {
            this.anexoError = error;
            this.anexoSuccess = success;
            if (error || success) {
                setTimeout(() => {
                    if (this.anexoError === error) this.anexoError = "";
                    if (this.anexoSuccess === success) this.anexoSuccess = "";
                }, 5000);
            }
        },

        parseFileNameFromDisposition(disposition = "") {
            const raw = String(disposition || "");
            const match = raw.match(/filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?/i);
            if (!match?.[1]) return "";
            try {
                return decodeURIComponent(match[1].replace(/\"/g, ""));
            } catch (_) {
                return match[1].replace(/\"/g, "");
            }
        },

        async resolveBlobErrorMessage(error, fallback) {
            const directMessage = error?.response?.data?.error;
            if (directMessage) return directMessage;

            const blob = error?.response?.data;
            if (!(blob instanceof Blob)) {
                return fallback;
            }

            try {
                const text = await blob.text();
                if (!text) return fallback;
                try {
                    const parsed = JSON.parse(text);
                    return parsed?.error || parsed?.detalle || text || fallback;
                } catch (_) {
                    return text || fallback;
                }
            } catch (_) {
                return fallback;
            }
        },

        async buscarUsuariosAnexo() {
            const q = String(this.anexoBusqueda || "").trim();
            if (this._anexoSearchTimer) {
                clearTimeout(this._anexoSearchTimer);
                this._anexoSearchTimer = null;
            }

            if (!q || q.length < 2) {
                this.anexoResultados = [];
                this.anexoBuscando = false;
                return;
            }

            this.anexoBuscando = true;
            this._anexoSearchTimer = setTimeout(async () => {
                try {
                    const res = await axios.get(`${API}/th/anexo-individual/search`, {
                        ...(this.getAuthConfig() || {}),
                        params: { q }
                    });
                    this.anexoResultados = Array.isArray(res?.data) ? res.data : [];
                } catch (_) {
                    this.anexoResultados = [];
                } finally {
                    this.anexoBuscando = false;
                }
            }, 220);
        },

        async seleccionarUsuarioAnexo(usuario) {
            this.usuarioAnexo = usuario || null;
            this.anexoBusqueda = "";
            this.anexoResultados = [];
            this.anexoMostrarHistorial = false;
            await this.cargarItemsAnexo();
        },

        limpiarUsuarioAnexo() {
            this.usuarioAnexo = null;
            this.anexoBusqueda = "";
            this.anexoResultados = [];
            this.anexoItemsActivos = [];
            this.anexoItemsFinalizados = [];
            this.anexoTokenActivo = null;
            this.anexoUltimoTokenFirmado = null;
            this.anexoTieneCambiosDesdeFirma = false;
            this.anexoCorreoSugerido = "";
            this.cerrarModalItemAnexo();
            this.cerrarModalFirmaAnexo();
            this.cerrarModalCancelarAnexo();
            this.cerrarModalFinalizarAnexo();
        },

        async cargarItemsAnexo() {
            if (!this.usuarioAnexo?.id) return;
            this.anexoCargandoItems = true;
            try {
                const res = await axios.get(
                    `${API}/th/anexo-individual/usuarios/${this.usuarioAnexo.id}/items`,
                    {
                        ...(this.getAuthConfig() || {}),
                        params: {
                            incluir_finalizados: this.anexoMostrarHistorial ? "true" : "false"
                        }
                    }
                );
                const data = res?.data || {};
                this.usuarioAnexo = data.usuario || this.usuarioAnexo;
                this.anexoItemsActivos = Array.isArray(data.items_activos) ? data.items_activos : [];
                this.anexoItemsFinalizados = Array.isArray(data.items_finalizados) ? data.items_finalizados : [];
                this.anexoTokenActivo = data.token_activo || null;
                this.anexoUltimoTokenFirmado = data.ultimo_token_firmado || null;
                this.anexoTieneCambiosDesdeFirma = Boolean(data.tiene_cambios_desde_ultima_firma);
                this.anexoCorreoSugerido = data.correo_firmante_sugerido || "";
            } catch (e) {
                this.setAnexoFeedback({
                    error: e?.response?.data?.error || "No se pudieron cargar los items del anexo."
                });
            } finally {
                this.anexoCargandoItems = false;
            }
        },

        async toggleHistorialAnexo() {
            this.anexoMostrarHistorial = !this.anexoMostrarHistorial;
            if (this.usuarioAnexo?.id) {
                await this.cargarItemsAnexo();
            }
        },

        labelTipoAnexo(tipo) {
            return ANEXO_TIPO_LABELS[tipo] || tipo || "-";
        },

        origenBadgeClass(origen) {
            return origen === "automatico" ? "bg-sky-100 text-sky-700" : "bg-emerald-100 text-emerald-700";
        },

        origenBadgeText(origen) {
            return origen === "automatico" ? "Auto" : "Manual";
        },

        estadoFirmaBadgeClass(estado) {
            if (estado === "firmado") return "bg-emerald-100 text-emerald-700";
            if (estado === "enviado") return "bg-amber-100 text-amber-700";
            return "bg-yellow-100 text-yellow-700";
        },

        estadoFirmaBadgeText(estado) {
            if (estado === "firmado") return "Firmado";
            if (estado === "enviado") return "Enviado";
            return "Pendiente";
        },

        textoValorAnexo(item) {
            const valor = this.formatCurrencyValue(item?.valor_tarifa, item?.moneda || "COP");
            if (!valor) return "-";
            const tipo = item?.tipo_asignacion;
            if (tipo === "horas" || tipo === "capacitacion") return `${valor} / hora`;
            return `${valor} / mes`;
        },

        get puedeEnviarAnexo() {
            return Boolean(this.usuarioAnexo?.id && this.anexoItemsActivos.length > 0 && !this.anexoTokenActivo);
        },

        get anexoTodoVigente() {
            return Boolean(
                this.anexoItemsActivos.length > 0 &&
                this.anexoItemsActivos.every((item) => item.estado_firma === "firmado") &&
                !this.anexoTieneCambiosDesdeFirma &&
                !this.anexoTokenActivo
            );
        },

        tipoAnexoRequiereCliente(tipo) {
            return ["full_time", "medio_tiempo", "proyecto"].includes(String(tipo || ""));
        },

        tipoAnexoEsAnual(tipo) {
            return ["horas", "capacitacion"].includes(String(tipo || ""));
        },

        syncFechaFinAnexo(force = false) {
            const form = this.anexoModalItem.form;
            if (!this.tipoAnexoEsAnual(form.tipo_asignacion) || !form.fecha_inicio) return;
            const year = String(form.fecha_inicio).slice(0, 4);
            if (!year || year.length !== 4) return;
            if (force || !form.fecha_fin) {
                form.fecha_fin = `${year}-12-31`;
            }
        },

        abrirModalNuevoItemAnexo() {
            if (!this.usuarioAnexo?.id) {
                alert("Selecciona una persona antes de agregar un item.");
                return;
            }
            this.anexoModalItem = {
                open: true,
                mode: "create",
                loading: false,
                saving: false,
                error: "",
                itemId: "",
                form: {
                    ...emptyAnexoItemForm(),
                    usuario_id: this.usuarioAnexo.id
                }
            };
        },

        async abrirModalEditarItemAnexo(item) {
            if (!item?.id) return;
            this.anexoModalItem = {
                open: true,
                mode: "edit",
                loading: true,
                saving: false,
                error: "",
                itemId: item.id,
                form: {
                    ...emptyAnexoItemForm(),
                    usuario_id: this.usuarioAnexo?.id || ""
                }
            };
            try {
                const res = await axios.get(`${API}/th/anexo-individual/items/${item.id}`, this.getAuthConfig());
                const data = res?.data || {};
                this.anexoModalItem.form = {
                    usuario_id: this.usuarioAnexo?.id || data.usuario_id || "",
                    tipo_asignacion: data.tipo_asignacion || "full_time",
                    cliente_id: data.cliente_id || "",
                    modulo_id: data.modulo_id || "",
                    moneda: data.moneda || "COP",
                    valor_tarifa: data.valor_tarifa ?? "",
                    fecha_inicio: data.fecha_inicio || "",
                    fecha_fin: data.fecha_fin || "",
                    correo_personal: data.correo_personal || this.anexoCorreoSugerido || ""
                };
            } catch (e) {
                this.anexoModalItem.error = e?.response?.data?.error || "No se pudo cargar el item.";
            } finally {
                this.anexoModalItem.loading = false;
            }
        },

        cerrarModalItemAnexo() {
            this.anexoModalItem = {
                open: false,
                mode: "create",
                loading: false,
                saving: false,
                error: "",
                itemId: "",
                form: emptyAnexoItemForm()
            };
        },

        onTipoAnexoChange() {
            const form = this.anexoModalItem.form;
            if (!this.tipoAnexoRequiereCliente(form.tipo_asignacion)) {
                form.cliente_id = "";
            }
            if (this.tipoAnexoEsAnual(form.tipo_asignacion)) {
                this.syncFechaFinAnexo(true);
            }
        },

        onFechaInicioAnexoChange() {
            if (this.tipoAnexoEsAnual(this.anexoModalItem.form.tipo_asignacion)) {
                this.syncFechaFinAnexo(true);
            }
        },

        validarFormAnexoItem() {
            const form = this.anexoModalItem.form;
            if (!form.tipo_asignacion) return "Selecciona el tipo de asignacion.";
            if (this.tipoAnexoRequiereCliente(form.tipo_asignacion) && !form.cliente_id) return "Selecciona el cliente.";
            if (!form.modulo_id) return "Selecciona el modulo.";
            if (!form.moneda) return "Selecciona la moneda.";
            if (form.valor_tarifa === "" || form.valor_tarifa === null || Number(form.valor_tarifa) < 0) {
                return "Ingresa un valor valido para la tarifa.";
            }
            if (!form.fecha_inicio) return "Selecciona la fecha de inicio.";
            if (!form.fecha_fin) return "Selecciona la fecha de fin.";
            if (form.fecha_fin < form.fecha_inicio) return "La fecha de fin no puede ser menor a la fecha de inicio.";
            return "";
        },

        async guardarItemAnexo() {
            if (!this.usuarioAnexo?.id) return;
            const error = this.validarFormAnexoItem();
            if (error) {
                this.anexoModalItem.error = error;
                return;
            }

            this.anexoModalItem.saving = true;
            this.anexoModalItem.error = "";
            const form = this.anexoModalItem.form;
            const payload = {
                usuario_id: this.usuarioAnexo.id,
                tipo_asignacion: form.tipo_asignacion,
                cliente_id: this.tipoAnexoRequiereCliente(form.tipo_asignacion) ? form.cliente_id || null : null,
                modulo_id: form.modulo_id || null,
                moneda: form.moneda,
                valor_tarifa: Number(form.valor_tarifa),
                fecha_inicio: form.fecha_inicio,
                fecha_fin: form.fecha_fin,
                correo_personal: String(form.correo_personal || "").trim() || null
            };

            try {
                if (this.anexoModalItem.mode === "edit" && this.anexoModalItem.itemId) {
                    await axios.patch(`${API}/th/anexo-individual/items/${this.anexoModalItem.itemId}`, payload, this.getAuthConfig());
                    this.setAnexoFeedback({ success: "Item actualizado correctamente." });
                } else {
                    await axios.post(`${API}/th/anexo-individual/items`, payload, this.getAuthConfig());
                    this.setAnexoFeedback({ success: "Item creado correctamente." });
                }
                this.cerrarModalItemAnexo();
                await this.cargarItemsAnexo();
            } catch (e) {
                this.anexoModalItem.error = e?.response?.data?.error || "No se pudo guardar el item.";
            } finally {
                this.anexoModalItem.saving = false;
            }
        },

        abrirModalFirmaAnexo() {
            if (!this.puedeEnviarAnexo) return;
            this.anexoModalFirma = {
                open: true,
                saving: false,
                downloading: false,
                error: "",
                correo_firmante: this.anexoCorreoSugerido || this.usuarioAnexo?.email || ""
            };
        },

        cerrarModalFirmaAnexo() {
            this.anexoModalFirma = {
                open: false,
                saving: false,
                downloading: false,
                error: "",
                correo_firmante: ""
            };
        },

        async descargarPreviewAnexo() {
            if (!this.usuarioAnexo?.id || !this.anexoItemsActivos.length) return;
            const correo = String(this.anexoModalFirma.correo_firmante || "").trim();
            if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
                this.anexoModalFirma.error = "Ingresa un correo valido para verificar el documento.";
                return;
            }

            this.anexoModalFirma.downloading = true;
            this.anexoModalFirma.error = "";
            try {
                const resp = await axios.post(
                    `${API}/th/anexo-individual/preview-pdf`,
                    {
                        usuario_id: this.usuarioAnexo.id,
                        correo_firmante: correo,
                        item_ids: this.anexoItemsActivos.map((item) => item.id)
                    },
                    {
                        ...(this.getAuthConfig() || {}),
                        responseType: "blob"
                    }
                );

                const contentType = String(resp?.headers?.["content-type"] || "application/pdf");
                const blob = new Blob([resp.data], { type: contentType });
                const fileName =
                    this.parseFileNameFromDisposition(resp?.headers?.["content-disposition"] || "") ||
                    `AnexoTecnico_${String(this.usuarioAnexo?.nombre || "Persona").replace(/\s+/g, "_")}.pdf`;
                const blobUrl = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = blobUrl;
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(blobUrl);
            } catch (e) {
                this.anexoModalFirma.error = await this.resolveBlobErrorMessage(
                    e,
                    "No se pudo descargar la vista previa del anexo."
                );
            } finally {
                this.anexoModalFirma.downloading = false;
            }
        },

        async confirmarEnvioFirmaAnexo() {
            if (!this.puedeEnviarAnexo) return;
            const correo = String(this.anexoModalFirma.correo_firmante || "").trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
                this.anexoModalFirma.error = "Ingresa un correo valido para el firmante.";
                return;
            }

            this.anexoModalFirma.saving = true;
            this.anexoModalFirma.error = "";
            try {
                await axios.post(
                    `${API}/th/anexo-individual/iniciar-firma`,
                    {
                        usuario_id: this.usuarioAnexo.id,
                        correo_firmante: correo,
                        item_ids: this.anexoItemsActivos.map((item) => item.id)
                    },
                    this.getAuthConfig()
                );
                this.cerrarModalFirmaAnexo();
                await this.cargarItemsAnexo();
                this.setAnexoFeedback({ success: "Proceso de firma iniciado correctamente." });
            } catch (e) {
                this.anexoModalFirma.error = e?.response?.data?.error || "No se pudo iniciar la firma.";
            } finally {
                this.anexoModalFirma.saving = false;
            }
        },

        abrirModalCancelarAnexo() {
            this.anexoModalCancelar = { open: true, saving: false, error: "" };
        },

        cerrarModalCancelarAnexo() {
            this.anexoModalCancelar = { open: false, saving: false, error: "" };
        },

        async confirmarCancelarFirmaAnexo() {
            if (!this.anexoTokenActivo?.id) return;
            this.anexoModalCancelar.saving = true;
            this.anexoModalCancelar.error = "";
            try {
                await axios.delete(`${API}/th/anexo-individual/cancelar-firma/${this.anexoTokenActivo.id}`, this.getAuthConfig());
                this.cerrarModalCancelarAnexo();
                await this.cargarItemsAnexo();
                this.setAnexoFeedback({ success: "Envio cancelado correctamente." });
            } catch (e) {
                this.anexoModalCancelar.error = e?.response?.data?.error || "No se pudo cancelar el envio.";
            } finally {
                this.anexoModalCancelar.saving = false;
            }
        },

        abrirModalFinalizarAnexo(item) {
            this.anexoModalFinalizar = {
                open: true,
                saving: false,
                error: "",
                item
            };
        },

        cerrarModalFinalizarAnexo() {
            this.anexoModalFinalizar = { open: false, saving: false, error: "", item: null };
        },

        async confirmarFinalizarAnexo() {
            if (!this.anexoModalFinalizar.item?.id) return;
            this.anexoModalFinalizar.saving = true;
            this.anexoModalFinalizar.error = "";
            try {
                await axios.patch(
                    `${API}/th/anexo-individual/items/${this.anexoModalFinalizar.item.id}/finalizar`,
                    {},
                    this.getAuthConfig()
                );
                this.cerrarModalFinalizarAnexo();
                await this.cargarItemsAnexo();
                this.setAnexoFeedback({ success: "Item finalizado correctamente." });
            } catch (e) {
                this.anexoModalFinalizar.error = e?.response?.data?.error || "No se pudo finalizar el item.";
            } finally {
                this.anexoModalFinalizar.saving = false;
            }
        },

        formatFecha(fecha) {
            if (!fecha) return "-";
            const d = new Date(fecha);
            if (Number.isNaN(d.getTime())) return String(fecha);
            return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
        },

        formatFechaHora(fecha) {
            if (!fecha) return "-";
            const d = new Date(fecha);
            if (Number.isNaN(d.getTime())) return String(fecha);
            return d.toLocaleString("es-CO", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit"
            });
        }
    };
};
