// js/onboarding-th.js
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

    const emptyS3 = () => ({
        direccion: "",
        tipo_persona: "Natural",
        banco_id: "",
        tipo_cuenta: "Ahorros",
        numero_cuenta: "",
        correo_silver: ""
    });

    return {
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
            await Promise.all([this.cargarBancos(), this.cargarRegistros()]);
        },

        async cargarBancos() {
            try {
                const res = await axios.get(`${API}/bancos`, this.getAuthConfig());
                this.bancos = res.data || [];
            } catch (e) {
                this.bancos = [];
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
            } catch (e) {
                return [];
            }
        },

        async fetchSolicitudesContratacion() {
            try {
                const res = await axios.get(`${API}/contrataciones/solicitudes?limit=400`, this.getAuthConfig());
                return Array.isArray(res?.data) ? res.data : [];
            } catch (e) {
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
                responsable_supervisor: item?.supervisor?.nombre || null,
                fecha_fin: item?.fecha_fin || null,
                moneda: item?.moneda || null,
                pais_pago: null,
                tarifa_hora: item?.tarifa_hora ?? null,
                tarifa_mes: item?.tarifa_mes ?? null,
                tarifa_medio_tiempo: item?.tarifa_medio_tiempo ?? null,
                tarifa_capacitacion: item?.tarifa_capacitacion ?? null,
                vpn_corona: null,
                necesita_s_user: null,
                grupo_usuario: item?.grupo_app_tiempos || null,
                grupo_distribucion: item?.grupo_distribucion || null,
                observaciones: item?.observaciones || null,
                direccion: null,
                tipo_persona: "Natural",
                banco: null,
                tipo_cuenta: null,
                numero_cuenta: null,
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
                return "Contratación desde RRHH";
            }
            return item?.origen_flujo === "contratacion" ? "Contratación directa" : "Preregistro RRHH";
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
            const key = this.estadoToKey(estado);
            return `estado-${key}`;
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

        coincideBusqueda(p) {
            if (!this.busqueda) return true;
            const q = this.normalizar(this.busqueda);
            const campos = [
                `${p?.nombre || ""} ${p?.apellidos || ""}`,
                p?.solicitud?.perfil || "",
                p?.solicitud?.cliente?.nombre || "",
                p?.numero_documento || "",
                p?.correo_personal || ""
            ].map((x) => this.normalizar(x));
            return campos.some((c) => c.includes(q));
        },

        get preregistrosFiltrados() {
            let items = this.preregistros;
            if (this.filtro !== "all") {
                items = items.filter((p) => this.estadoToKey(p?.estado) === this.filtro);
            }
            if (this.busqueda) {
                items = items.filter((p) => this.coincideBusqueda(p));
            }
            return items;
        },

        get tituloFiltro() {
            return FILTER_LABELS[this.filtro] || FILTER_LABELS.all;
        },

        esContratacionPendienteRevisionTh(item) {
            return item?.origen_flujo === "contratacion" && this.normalizar(item?.estado) === "pendiente revision th";
        },

        accionPrincipalLabel(p) {
            if (this.esContratacionPendienteRevisionTh(p)) return "Marcar revisión TH";
            if (p?.origen_flujo !== "preregistro") return "Ver detalle";
            if (p.estado === "Pendiente Revision TH") return "Completar revisión";
            if (p.estado === "Pendiente Correo Silver") return "Ingresar correo Silver";
            return "Ver detalle";
        },

        accionPrincipalClass(p) {
            if (this.esContratacionPendienteRevisionTh(p)) return "prereg-btn prereg-btn-teal";
            if (p?.origen_flujo !== "preregistro") return "prereg-btn prereg-btn-ghost";
            if (p.estado === "Pendiente Correo Silver") return "prereg-btn prereg-btn-purple";
            if (p.estado === "Pendiente Revision TH") return "prereg-btn prereg-btn-teal";
            return "prereg-btn prereg-btn-ghost";
        },

        buscarPreregistroVinculado(item) {
            if (!item || item?.origen_flujo !== "contratacion") return null;

            const preregistroId = this.normalizarId(item?.preregistro_id || item?.datos_extra?.preregistro_id);
            if (preregistroId) {
                const byPreregistroId = this.preregistros.find(
                    (p) => p?.origen_flujo === "preregistro" && this.normalizarId(p?.id) === preregistroId
                );
                if (byPreregistroId) return byPreregistroId;
            }

            const rrhhSolicitudId = this.normalizarId(item?.rrhh_solicitud_id || item?.datos_extra?.rrhh_solicitud_id);
            if (rrhhSolicitudId) {
                const bySolicitud = this.preregistros.find(
                    (p) => p?.origen_flujo === "preregistro" && this.normalizarId(p?.solicitud?.id) === rrhhSolicitudId
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

        async ejecutarAccionPrincipal(p) {
            if (!p?.id) return;

            const preregistroVinculado = this.buscarPreregistroVinculado(p);
            if (preregistroVinculado) {
                this.abrirDetalle(preregistroVinculado, preregistroVinculado?.estado === "Pendiente Correo Silver");
                return;
            }

            if (this.esContratacionPendienteRevisionTh(p)) {
                await this.marcarRevisionThContratacion(p);
                return;
            }
            this.abrirDetalleResuelto(p, p?.estado === "Pendiente Correo Silver");
        },

        async marcarRevisionThContratacion(item) {
            if (!this.esContratacionPendienteRevisionTh(item)) return;
            if (!confirm("¿Marcar esta solicitud de contratación como revisada por Talento Humano?")) return;
            try {
                await axios.patch(
                    `${API}/contrataciones/solicitudes/${item.id}/revision-th`,
                    { observaciones_th: null },
                    this.getAuthConfig()
                );
                await this.cargarRegistros();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error completando revisión TH";
                alert(msg);
            }
        },

        abrirDetalle(p, focoCorreo = false) {
            this.itemActivo = JSON.parse(JSON.stringify(p || {}));
            this.formS3 = {
                direccion: p?.direccion || "",
                tipo_persona: p?.tipo_persona || "Natural",
                banco_id: p?.banco?.id || "",
                tipo_cuenta: p?.tipo_cuenta || "Ahorros",
                numero_cuenta: p?.numero_cuenta || "",
                correo_silver: p?.correo_silver || ""
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
            if (this.itemActivo?.origen_flujo !== "preregistro") return false;
            const e = this.itemActivo?.estado;
            return e === "Pendiente Revision TH" || e === "Pendiente Correo Silver";
        },

        get s3BaseValida() {
            const f = this.formS3;
            return !!String(f.direccion || "").trim()
                && !!String(f.tipo_persona || "").trim()
                && !!String(f.banco_id || "").trim()
                && !!String(f.tipo_cuenta || "").trim()
                && !!String(f.numero_cuenta || "").trim();
        },

        get puedeAprobar() {
            if (!this.seccion3Editable || !this.s3BaseValida) return false;
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(this.formS3.correo_silver || "").trim());
        },

        async guardarS3() {
            if (!this.itemActivo?.id || !this.seccion3Editable) return;
            if (!this.s3BaseValida) {
                alert("Completa todos los campos requeridos de la sección 3.");
                return;
            }
            this.guardandoS3 = true;
            try {
                await this.requestWithApiFallback(
                    "patch",
                    `/api/preregistros/${this.itemActivo.id}/seccion-3`,
                    {
                        direccion: String(this.formS3.direccion || "").trim(),
                        tipo_persona: String(this.formS3.tipo_persona || "").trim(),
                        banco_id: this.formS3.banco_id,
                        tipo_cuenta: String(this.formS3.tipo_cuenta || "").trim(),
                        numero_cuenta: String(this.formS3.numero_cuenta || "").trim(),
                        correo_silver: String(this.formS3.correo_silver || "").trim() || null
                    }
                );
                await this.cargarRegistros();
                this.cerrarDetalle();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error guardando sección 3";
                alert(msg);
            } finally {
                this.guardandoS3 = false;
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
                const msg = e?.response?.data?.error || "Error aprobando preregistro";
                alert(msg);
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
                await this.requestWithApiFallback(
                    "post",
                    `/api/preregistros/${this.itemActivo.id}/anular`,
                    { motivo_anulacion: String(this.motivoAnulacion || "").trim() }
                );
                await this.cargarRegistros();
                this.cerrarDetalle();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error anulando preregistro";
                alert(msg);
            } finally {
                this.anulando = false;
            }
        },

        formatFecha(fecha) {
            if (!fecha) return "-";
            const d = new Date(fecha);
            if (Number.isNaN(d.getTime())) return String(fecha);
            return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
        }
    };
};
