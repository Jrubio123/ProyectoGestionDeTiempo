// js/preregistros-coord.js
window.preregistrosCoordApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const DEFAULT_MONEDAS = ["COP", "USD", "EUR"];
    const EXTENSION_TIPOS_CON_FECHA = ["full_time", "medio_tiempo", "proyecto"];

    const emptyForm = () => ({
        persona_usuario_id: "",
        tipo_documento_id: "",
        cliente_id: "",
        cliente_nombre_prospecto: "",
        supervisor_id: "",
        supervisor_nombre: "",
        supervisor_email: "",
        supervisor_azure_oid: "",
        modulo_id: "",
        nombre: "",
        apellidos: "",
        numero_documento: "",
        perfil: "",
        correo_personal: "",
        correo_empresarial: "",
        telefono: "",
        // Para Nuevo: pais_ubicacion (campo libre); para otros: ubicacion legacy
        pais_ubicacion: "",
        ubicacion: "",
        // Campos técnicos nuevos (Nuevo)
        vpn_corona: false,
        necesita_s_user: false,
        grupo_usuario: "",          // enum: ADMIN/COORDINADOR/CONSULTOR/CONTABILIDAD/COMERCIAL/Otro
        grupo_usuario_otro: "",     // libre cuando grupo_usuario === "Otro"
        grupo_distribucion: "",
        crear_usuario_sistema: true,
        // Legacy (Extension/Retiro)
        grupo_app_tiempos: "",
        moneda: "COP",
        factura_en_colombia: "",
        tarifa_hora: "",
        tarifa_mes: "",
        tarifa_medio_tiempo: "",
        tarifa_capacitacion: "",
        tipo_asignacion: "",
        anexo_item_id: "",
        modalidad_contrato: "",
        fecha_inicio: "",
        fecha_fin: "",
        fecha_extension_desde: "",
        fecha_extension_hasta: "",
        fecha_retiro: "",
        necesidad_ti: "",
        observaciones: ""
    });

    return {
        solicitudes: [],
        clientes: [],
        modulos: [],
        documentos: [],
        monedas: [],

        filtroEstado: "",
        busqueda: "",

        modalOpen: false,
        detalleOpen: false,
        tipoModal: "Nuevo",
        detalle: null,

        modoEdicion: false,
        solicitudEditId: null,
        datosExtraBase: {},
        observacionesThActivas: "",

        form: emptyForm(),
        busquedaPersona: "",
        personasEncontradas: [],
        personaSeleccionada: null,
        anexosActivos: [],
        anexoSeleccionadoId: "",
        mostrarSugerenciasPersona: false,
        buscandoPersonas: false,
        guardandoSolicitud: false,
        enviandoTh: false,
        debounceBusquedaPersona: null,
        busquedaSupervisor: "",
        supervisorSugerencias: [],
        supervisorBuscando: false,
        mostrarSugerenciasSupervisor: false,
        debounceBusquedaSupervisor: null,
        supervisorLookupSeq: 0,

        erroresFormulario: [],

        rolesDisponibles: [
            "Administrador",
            "Coordinador",
            "Consultor",
            "Consultor Principal",
            "Mesa de Servicio",
            "Reclutador",
            "Talento Humano"
        ],

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async init() {
            await Promise.all([this.cargarCatalogos(), this.cargarSolicitudes()]);
        },

        fallbackMonedas() {
            return DEFAULT_MONEDAS.map((id) => ({ id, titulo: id }));
        },

        ensureMonedasDisponibles(monedaActual = "") {
            const current = String(monedaActual || "").trim().toUpperCase();
            const source = Array.isArray(this.monedas) && this.monedas.length ? [...this.monedas] : this.fallbackMonedas();
            if (current && !source.some((item) => String(item?.id || "").trim().toUpperCase() === current)) {
                source.unshift({ id: current, titulo: current });
            }
            return source;
        },

        async cargarCatalogos() {
            try {
                const [clientes, modulos, documentos, monedas] = await Promise.all([
                    axios.get(`${API}/clientes`, this.getAuthConfig()),
                    axios.get(`${API}/modulos`, this.getAuthConfig()),
                    axios.get(`${API}/documentos-identidad`, this.getAuthConfig()),
                    axios.get(`${API}/monedas`, this.getAuthConfig())
                ]);
                this.clientes = Array.isArray(clientes.data) ? clientes.data : [];
                this.modulos = Array.isArray(modulos.data) ? modulos.data : [];
                this.documentos = Array.isArray(documentos.data) ? documentos.data : [];
                this.monedas = Array.isArray(monedas.data) && monedas.data.length ? monedas.data : this.fallbackMonedas();
            } catch (e) {
                this.clientes = [];
                this.modulos = [];
                this.documentos = [];
                this.monedas = this.fallbackMonedas();
            }
        },

        async cargarSolicitudes() {
            try {
                const res = await axios.get(`${API}/contrataciones/solicitudes`, this.getAuthConfig());
                this.solicitudes = Array.isArray(res.data) ? res.data : [];
            } catch (e) {
                this.solicitudes = [];
            }
        },

        usuarioSolicitanteActual() {
            const user = window.auth?.getUser?.() || {};
            const id = String(user?.id || "").trim();
            if (!id) return null;
            return {
                id,
                nombre: String(user?.nombre_usuario || user?.email || "Usuario actual").trim(),
                email: String(user?.email || "").trim() || null,
                azure_oid: String(user?.azure_oid || "").trim() || null
            };
        },

        aplicarSupervisorPorDefecto() {
            const solicitante = this.usuarioSolicitanteActual();
            if (!solicitante?.id) return;
            this.form.supervisor_id = solicitante.id;
            this.form.supervisor_nombre = solicitante.nombre || "";
            this.form.supervisor_email = solicitante.email || "";
            this.form.supervisor_azure_oid = solicitante.azure_oid || "";
            this.busquedaSupervisor = solicitante.nombre || solicitante.email || "";
        },

        onInputSupervisor() {
            const q = String(this.busquedaSupervisor || "").trim();
            this.form.supervisor_id = "";
            this.form.supervisor_nombre = "";
            this.form.supervisor_email = "";
            this.form.supervisor_azure_oid = "";
            if (this.debounceBusquedaSupervisor) clearTimeout(this.debounceBusquedaSupervisor);
            if (q.length < 2) {
                this.supervisorLookupSeq += 1;
                this.supervisorSugerencias = [];
                this.mostrarSugerenciasSupervisor = false;
                this.supervisorBuscando = false;
                return;
            }
            this.debounceBusquedaSupervisor = setTimeout(() => this.buscarSupervisoresTenant(q), 250);
        },

        onFocusSupervisor() {
            const q = String(this.busquedaSupervisor || "").trim();
            if (this.supervisorSugerencias.length) {
                this.mostrarSugerenciasSupervisor = true;
            } else if (q.length >= 2) {
                this.buscarSupervisoresTenant(q);
            }
        },

        ocultarSugerenciasSupervisor() {
            this.mostrarSugerenciasSupervisor = false;
        },

        async buscarSupervisoresTenant(q) {
            const query = String(q || "").trim();
            if (query.length < 2) return;
            const seq = ++this.supervisorLookupSeq;
            this.supervisorBuscando = true;
            try {
                const res = await axios.get(`${API}/admin/tenant/usuarios`, {
                    ...(this.getAuthConfig() || {}),
                    params: { q: query }
                });
                if (seq !== this.supervisorLookupSeq) return;
                this.supervisorSugerencias = Array.isArray(res.data) ? res.data : [];
                this.mostrarSugerenciasSupervisor = this.supervisorSugerencias.length > 0;
            } catch (_) {
                if (seq !== this.supervisorLookupSeq) return;
                this.supervisorSugerencias = [];
                this.mostrarSugerenciasSupervisor = false;
            } finally {
                if (seq === this.supervisorLookupSeq) this.supervisorBuscando = false;
            }
        },

        seleccionarSupervisorTenant(supervisor) {
            if (!supervisor) return;
            this.supervisorLookupSeq += 1;
            this.form.supervisor_id = supervisor.usuario_id || "";
            this.form.supervisor_nombre = String(supervisor.nombre_usuario || "").trim();
            this.form.supervisor_email = String(supervisor.email || "").trim();
            this.form.supervisor_azure_oid = String(supervisor.azure_oid || "").trim();
            this.busquedaSupervisor = this.form.supervisor_nombre || this.form.supervisor_email;
            this.supervisorSugerencias = [];
            this.mostrarSugerenciasSupervisor = false;
            this.supervisorBuscando = false;
        },

        pickFirst(...values) {
            for (const value of values) {
                if (value !== undefined && value !== null && value !== "") return value;
            }
            return null;
        },

        normalizarTexto(value) {
            return String(value || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .trim();
        },

        normalizarNumero(value) {
            if (value === undefined || value === null || value === "") return null;
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        },

        sonNumerosIguales(a, b) {
            return this.normalizarNumero(a) === this.normalizarNumero(b);
        },

        buscarModuloPorId(id) {
            return (this.modulos || []).find((modulo) => String(modulo?.id || "") === String(id || "")) || null;
        },

        resolverDatosPerfil({ moduloId = "", perfil = "" } = {}) {
            const modulo = this.buscarModuloPorId(moduloId);
            if (modulo) {
                return {
                    modulo_id: String(modulo.id),
                    perfil: String(modulo.titulo || "").trim()
                };
            }

            const freeText = String(perfil || "").trim();
            if (!freeText) {
                return { modulo_id: "", perfil: "" };
            }

            const moduloByTitle = (this.modulos || []).find(
                (item) => this.normalizarTexto(item?.titulo) === this.normalizarTexto(freeText)
            );
            if (moduloByTitle) {
                return {
                    modulo_id: String(moduloByTitle.id),
                    perfil: String(moduloByTitle.titulo || "").trim()
                };
            }

            return {
                modulo_id: "otros",
                perfil: freeText
            };
        },

        parseNombreCompleto(value) {
            const parts = String(value || "")
                .trim()
                .split(/\s+/)
                .filter(Boolean);

            if (!parts.length) return { nombre: "", apellidos: "" };
            if (parts.length === 1) return { nombre: parts[0], apellidos: "" };
            if (parts.length === 2) return { nombre: parts[0], apellidos: parts[1] };

            return {
                nombre: parts.slice(0, 2).join(" "),
                apellidos: parts.slice(2).join(" ")
            };
        },

        toDateInput(value) {
            if (!value) return "";
            return String(value).substring(0, 10);
        },

        formatFecha(value) {
            if (!value) return "-";
            const ymd = String(value).substring(0, 10);
            const parts = ymd.split("-");
            if (parts.length !== 3) return String(value);
            const [year, month, day] = parts.map(Number);
            if (!year || !month || !day) return String(value);
            const d = new Date(year, month - 1, day);
            if (Number.isNaN(d.getTime())) return String(value);
            return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
        },

        formatMonto(value, moneda = "COP") {
            const amount = this.normalizarNumero(value);
            const currency = String(moneda || "COP").trim().toUpperCase() || "COP";
            if (amount === null) return "-";
            try {
                return new Intl.NumberFormat("es-CO", {
                    style: "currency",
                    currency,
                    maximumFractionDigits: 2
                }).format(amount);
            } catch (_) {
                return `${currency} ${amount}`;
            }
        },

        construirBaseExtensionDesdeDatos(source) {
            if (!source || typeof source !== "object" || Array.isArray(source)) return null;
            const perfilData = this.resolverDatosPerfil({
                moduloId: source.modulo_id || "",
                perfil: source.perfil || source.modulo_nombre || ""
            });
            const base = {
                tipo_asignacion: source.tipo_asignacion || null,
                tipo_asignacion_label: source.tipo_asignacion_label || null,
                cliente_id: source.cliente_id || null,
                cliente_nombre: source.cliente_nombre || null,
                supervisor_id: source.supervisor_id || null,
                supervisor_nombre: source.supervisor_nombre || null,
                supervisor_azure_oid: source.supervisor_azure_oid || null,
                perfil: perfilData.perfil || null,
                modulo_id: perfilData.modulo_id && perfilData.modulo_id !== "otros" ? perfilData.modulo_id : null,
                modulo_nombre: source.modulo_nombre || perfilData.perfil || null,
                moneda: source.moneda || null,
                fecha_inicio: source.fecha_inicio || null,
                fecha_fin: source.fecha_fin || null,
                tarifa_hora: source.tarifa_hora ?? null,
                tarifa_mes: source.tarifa_mes ?? null,
                tarifa_medio_tiempo: source.tarifa_medio_tiempo ?? null,
                tarifa_capacitacion: source.tarifa_capacitacion ?? null
            };
            const hasData = Object.values(base).some((value) => value !== null && value !== "");
            return hasData ? base : null;
        },

        combinarBasesExtension(primary, secondary) {
            const first = primary || null;
            const fallback = secondary || null;
            if (!first && !fallback) return null;
            return {
                tipo_asignacion: this.pickFirst(first?.tipo_asignacion, fallback?.tipo_asignacion),
                tipo_asignacion_label: this.pickFirst(first?.tipo_asignacion_label, fallback?.tipo_asignacion_label),
                cliente_id: this.pickFirst(first?.cliente_id, fallback?.cliente_id),
                cliente_nombre: this.pickFirst(first?.cliente_nombre, fallback?.cliente_nombre),
                supervisor_id: this.pickFirst(first?.supervisor_id, fallback?.supervisor_id),
                supervisor_nombre: this.pickFirst(first?.supervisor_nombre, fallback?.supervisor_nombre),
                supervisor_azure_oid: this.pickFirst(first?.supervisor_azure_oid, fallback?.supervisor_azure_oid),
                perfil: this.pickFirst(first?.perfil, fallback?.perfil),
                modulo_id: this.pickFirst(first?.modulo_id, fallback?.modulo_id),
                modulo_nombre: this.pickFirst(first?.modulo_nombre, fallback?.modulo_nombre),
                moneda: this.pickFirst(first?.moneda, fallback?.moneda),
                fecha_inicio: this.pickFirst(first?.fecha_inicio, fallback?.fecha_inicio),
                fecha_fin: this.pickFirst(first?.fecha_fin, fallback?.fecha_fin),
                tarifa_hora: this.pickFirst(first?.tarifa_hora, fallback?.tarifa_hora),
                tarifa_mes: this.pickFirst(first?.tarifa_mes, fallback?.tarifa_mes),
                tarifa_medio_tiempo: this.pickFirst(first?.tarifa_medio_tiempo, fallback?.tarifa_medio_tiempo),
                tarifa_capacitacion: this.pickFirst(first?.tarifa_capacitacion, fallback?.tarifa_capacitacion)
            };
        },

        construirBaseExtensionDesdePersona(persona) {
            if (!persona) return null;
            const anexo = persona?.anexo_activo || null;
            const current = this.construirBaseExtensionDesdeDatos({
                tipo_asignacion: persona?.tipo_asignacion || anexo?.tipo_asignacion || null,
                tipo_asignacion_label: persona?.tipo_asignacion_label || anexo?.tipo_asignacion_label || null,
                cliente_id: persona?.cliente_id || anexo?.cliente_id || null,
                cliente_nombre: persona?.cliente_nombre || anexo?.cliente_nombre || null,
                supervisor_id: persona?.supervisor_id || null,
                supervisor_nombre: persona?.supervisor_nombre || null,
                supervisor_azure_oid: persona?.supervisor_azure_oid || null,
                perfil: persona?.perfil || persona?.modulo_nombre || anexo?.modulo_nombre || null,
                modulo_id: persona?.modulo_id || anexo?.modulo_id || null,
                modulo_nombre: persona?.modulo_nombre || anexo?.modulo_nombre || null,
                moneda: persona?.moneda || anexo?.moneda || null,
                fecha_inicio: persona?.fecha_inicio_actual || anexo?.fecha_inicio || null,
                fecha_fin: persona?.fecha_fin_actual || anexo?.fecha_fin || null,
                tarifa_hora: persona?.tarifa_hora ?? null,
                tarifa_mes: persona?.tarifa_mes ?? null,
                tarifa_medio_tiempo: persona?.tarifa_medio_tiempo ?? null,
                tarifa_capacitacion: persona?.tarifa_capacitacion ?? null
            });
            const anexoBase = this.construirBaseExtensionDesdeDatos({
                tipo_asignacion: anexo?.tipo_asignacion || null,
                tipo_asignacion_label: anexo?.tipo_asignacion_label || null,
                cliente_id: anexo?.cliente_id || null,
                cliente_nombre: anexo?.cliente_nombre || null,
                perfil: anexo?.modulo_nombre || null,
                modulo_id: anexo?.modulo_id || null,
                modulo_nombre: anexo?.modulo_nombre || null,
                moneda: anexo?.moneda || null,
                fecha_inicio: anexo?.fecha_inicio || null,
                fecha_fin: anexo?.fecha_fin || null
            });
            return this.combinarBasesExtension(current, anexoBase);
        },

        construirPersonaDesdeSolicitud(item) {
            if (!item) return null;
            const base = this.construirBaseExtensionDesdeDatos(item?.datos_extra?.extension_base);
            const perfilData = this.resolverDatosPerfil({
                moduloId: item?.datos_extra?.modulo_id || base?.modulo_id || "",
                perfil: item?.perfil || base?.perfil || base?.modulo_nombre || ""
            });
            const nombreUsuario =
                String(item?.persona?.nombre || "").trim() ||
                `${item?.nombre || ""} ${item?.apellidos || ""}`.trim();
            const tipoAsignacion = item?.datos_extra?.tipo_asignacion || base?.tipo_asignacion || null;
            const anexoBase = base
                ? {
                    id: null,
                    tipo_asignacion: base.tipo_asignacion || null,
                    tipo_asignacion_label: base.tipo_asignacion_label || null,
                    cliente_id: base.cliente_id || null,
                    cliente_nombre: base.cliente_nombre || null,
                    modulo_id: base.modulo_id || null,
                    modulo_nombre: base.modulo_nombre || base.perfil || null,
                    moneda: base.moneda || null,
                    valor_tarifa:
                        this.pickFirst(
                            base.tarifa_mes,
                            base.tarifa_medio_tiempo,
                            base.tarifa_hora,
                            base.tarifa_capacitacion
                        ) ?? null,
                    fecha_inicio: base.fecha_inicio || null,
                    fecha_fin: base.fecha_fin || null,
                    fecha_fin_calculada: false,
                    estado_firma: "pendiente"
                }
                : null;

            return {
                id: item?.persona?.id || "",
                nombre_usuario: nombreUsuario || null,
                correo_empresarial: item?.correo_empresarial || item?.persona?.email || null,
                correo_personal: item?.correo_personal || null,
                numero_documento: item?.numero_documento || null,
                telefono: item?.telefono || null,
                moneda: item?.moneda || base?.moneda || "COP",
                tipo_documento_id: item?.tipo_documento?.id || "",
                tipo_documento: item?.tipo_documento?.titulo || null,
                tipo_documento_codigo: item?.tipo_documento?.codigo || null,
                cliente_id: item?.cliente?.id || base?.cliente_id || null,
                cliente_nombre: item?.cliente?.nombre || base?.cliente_nombre || null,
                supervisor_id: item?.supervisor?.id || base?.supervisor_id || null,
                supervisor_nombre: item?.supervisor?.nombre || base?.supervisor_nombre || null,
                supervisor_email: item?.supervisor?.email || item?.datos_extra?.supervisor_email || null,
                supervisor_azure_oid: item?.supervisor?.azure_oid || item?.datos_extra?.supervisor_azure_oid || null,
                perfil: perfilData.perfil || item?.perfil || base?.perfil || null,
                modulo_id: perfilData.modulo_id || "",
                modulo_nombre: base?.modulo_nombre || perfilData.perfil || item?.perfil || null,
                modalidad_contrato: item?.modalidad_contrato || null,
                tipo_asignacion: tipoAsignacion,
                tipo_asignacion_label: base?.tipo_asignacion_label || null,
                extension_requiere_fechas: EXTENSION_TIPOS_CON_FECHA.includes(String(tipoAsignacion || "").trim()),
                fecha_inicio_actual: base?.fecha_inicio || item?.fecha_inicio || null,
                fecha_fin_actual: base?.fecha_fin || item?.fecha_fin || null,
                tarifa_hora: base?.tarifa_hora ?? item?.tarifa_hora ?? null,
                tarifa_mes: base?.tarifa_mes ?? item?.tarifa_mes ?? null,
                tarifa_medio_tiempo: base?.tarifa_medio_tiempo ?? item?.tarifa_medio_tiempo ?? null,
                tarifa_capacitacion: base?.tarifa_capacitacion ?? item?.tarifa_capacitacion ?? null,
                anexo_activo: anexoBase
            };
        },

        poblarFormularioDesdePersona(persona) {
            if (!persona) return;
            const perfilData = this.resolverDatosPerfil({
                moduloId: persona.modulo_id || "",
                perfil: persona.perfil || persona.modulo_nombre || ""
            });
            const nombreCompleto = String(persona.nombre_usuario || persona.nombre || "").trim();
            const nombrePartes = this.parseNombreCompleto(nombreCompleto);

            this.form.persona_usuario_id = persona.id || "";
            this.form.tipo_documento_id = persona.tipo_documento_id || "";
            this.form.numero_documento = persona.numero_documento || "";
            this.form.correo_empresarial = persona.correo_empresarial || "";
            if (persona.correo_personal) this.form.correo_personal = persona.correo_personal;
            if (persona.telefono) this.form.telefono = persona.telefono;
            if (persona.moneda) this.form.moneda = persona.moneda;
            if (persona.factura_en_colombia === true) this.form.factura_en_colombia = "true";
            if (persona.factura_en_colombia === false) this.form.factura_en_colombia = "false";
            if (persona.cliente_id) {
                this.form.cliente_id = String(persona.cliente_id);
                this.form.cliente_nombre_prospecto = "";
            } else if (persona.cliente_nombre) {
                this.form.cliente_id = "__prospecto__";
                this.form.cliente_nombre_prospecto = persona.cliente_nombre;
            }
            if (persona.supervisor_id || persona.supervisor_nombre) {
                this.form.supervisor_id = persona.supervisor_id ? String(persona.supervisor_id) : "";
                this.form.supervisor_nombre = persona.supervisor_nombre || "";
                this.form.supervisor_email = persona.supervisor_email || "";
                this.form.supervisor_azure_oid = persona.supervisor_azure_oid || "";
                this.busquedaSupervisor = this.form.supervisor_nombre || this.form.supervisor_email;
            }
            if (perfilData.modulo_id) this.form.modulo_id = perfilData.modulo_id;
            if (perfilData.perfil) this.form.perfil = perfilData.perfil;
            if (persona.modalidad_contrato) this.form.modalidad_contrato = persona.modalidad_contrato;
            if (persona.tarifa_hora != null) this.form.tarifa_hora = persona.tarifa_hora;
            if (persona.tarifa_mes != null) this.form.tarifa_mes = persona.tarifa_mes;
            if (persona.tarifa_medio_tiempo != null) this.form.tarifa_medio_tiempo = persona.tarifa_medio_tiempo;
            if (persona.tarifa_capacitacion != null) this.form.tarifa_capacitacion = persona.tarifa_capacitacion;

            if (nombrePartes.nombre) this.form.nombre = nombrePartes.nombre;
            if (nombrePartes.apellidos) this.form.apellidos = nombrePartes.apellidos;
        },

        mapSolicitudToForm(item) {
            const perfilData = this.resolverDatosPerfil({
                moduloId: item?.datos_extra?.modulo_id || "",
                perfil: item?.perfil || item?.datos_extra?.modulo || ""
            });
            const clienteId = item?.cliente?.id || "";
            const clienteNombre = item?.cliente?.nombre || item?.datos_extra?.cliente_nombre || "";
            const esClienteProspecto = !clienteId && Boolean(String(clienteNombre || "").trim());
            return {
                persona_usuario_id: item?.persona?.id || "",
                tipo_documento_id: item?.tipo_documento?.id || "",
                cliente_id: esClienteProspecto ? "__prospecto__" : clienteId,
                cliente_nombre_prospecto: esClienteProspecto ? clienteNombre : "",
                supervisor_id: item?.supervisor?.id || "",
                supervisor_nombre: item?.supervisor?.nombre || item?.datos_extra?.supervisor_nombre || "",
                supervisor_email: item?.supervisor?.email || item?.datos_extra?.supervisor_email || "",
                supervisor_azure_oid: item?.supervisor?.azure_oid || item?.datos_extra?.supervisor_azure_oid || "",
                modulo_id: perfilData.modulo_id || "",
                nombre: item?.nombre || "",
                apellidos: item?.apellidos || "",
                numero_documento: item?.numero_documento || "",
                perfil: perfilData.perfil || item?.perfil || "",
                correo_personal: item?.correo_personal || "",
                correo_empresarial: item?.correo_empresarial || "",
                telefono: item?.telefono || "",
                pais_ubicacion: item?.ubicacion || "",
                ubicacion: item?.ubicacion || "",
                vpn_corona: Boolean(item?.vpn_corona),
                necesita_s_user: Boolean(item?.necesita_s_user),
                grupo_usuario: item?.grupo_app_tiempos || "",
                grupo_usuario_otro: item?.grupo_usuario_otro || "",
                grupo_distribucion: item?.grupo_distribucion || "",
                crear_usuario_sistema: item?.crear_usuario_sistema !== false,
                grupo_app_tiempos: item?.grupo_app_tiempos || "",
                moneda: item?.moneda || "COP",
                factura_en_colombia:
                    item?.factura_en_colombia === true || item?.datos_extra?.factura_en_colombia === true ? "true" :
                    item?.factura_en_colombia === false || item?.datos_extra?.factura_en_colombia === false ? "false" : "",
                tarifa_hora: item?.tarifa_hora ?? "",
                tarifa_mes: item?.tarifa_mes ?? "",
                tarifa_medio_tiempo: item?.tarifa_medio_tiempo ?? "",
                tarifa_capacitacion: item?.tarifa_capacitacion ?? "",
                modalidad_contrato: item?.modalidad_contrato || "",
                fecha_inicio: this.toDateInput(item?.fecha_inicio),
                fecha_fin: this.toDateInput(item?.fecha_fin),
                fecha_extension_desde: this.toDateInput(item?.fecha_extension_desde),
                fecha_extension_hasta: this.toDateInput(item?.fecha_extension_hasta),
                fecha_retiro: this.toDateInput(item?.fecha_retiro),
                necesidad_ti: item?.necesidad_ti || "",
                observaciones: item?.observaciones || ""
            };
        },

        abrirModal(tipo, item = null) {
            this.tipoModal = tipo;
            this.modalOpen = true;
            this.erroresFormulario = [];
            this.personasEncontradas = [];
            this.mostrarSugerenciasPersona = false;
            this.personaSeleccionada = null;

            if (item) {
                this.modoEdicion = true;
                this.solicitudEditId = item.id;
                this.form = this.mapSolicitudToForm(item);
                this.datosExtraBase =
                    item?.datos_extra && typeof item.datos_extra === "object" && !Array.isArray(item.datos_extra)
                        ? { ...item.datos_extra }
                        : {};
                this.observacionesThActivas = item?.observaciones_th || "";
                this.personaSeleccionada = this.construirPersonaDesdeSolicitud(item);
                this.busquedaPersona = this.personaSeleccionada?.nombre_usuario || item?.persona?.nombre || "";
                this.busquedaSupervisor = this.form.supervisor_nombre || this.form.supervisor_email || "";
                return;
            }

            this.modoEdicion = false;
            this.solicitudEditId = null;
            this.datosExtraBase = {};
            this.observacionesThActivas = "";
            this.form = emptyForm();
            this.busquedaPersona = "";
            this.busquedaSupervisor = "";
            if (tipo !== "Extension") {
                this.aplicarSupervisorPorDefecto();
            }
        },

        abrirModalDesdeSolicitud(item) {
            if (!item?.id) return;
            this.detalleOpen = false;
            this.detalle = null;
            this.abrirModal(item.tipo_solicitud || "Nuevo", item);
        },

        cerrarModal() {
            this.modalOpen = false;
            this.modoEdicion = false;
            this.solicitudEditId = null;
            this.datosExtraBase = {};
            this.observacionesThActivas = "";
            this.form = emptyForm();
            this.personasEncontradas = [];
            this.busquedaPersona = "";
            this.busquedaSupervisor = "";
            this.supervisorSugerencias = [];
            this.mostrarSugerenciasSupervisor = false;
            this.supervisorBuscando = false;
            this.personaSeleccionada = null;
            this.anexosActivos = [];
            this.anexoSeleccionadoId = "";
            this.mostrarSugerenciasPersona = false;
            this.buscandoPersonas = false;
            this.erroresFormulario = [];
            if (this.debounceBusquedaPersona) {
                clearTimeout(this.debounceBusquedaPersona);
                this.debounceBusquedaPersona = null;
            }
            if (this.debounceBusquedaSupervisor) {
                clearTimeout(this.debounceBusquedaSupervisor);
                this.debounceBusquedaSupervisor = null;
            }
        },

        abrirDetalle(item) {
            this.detalle = item ? JSON.parse(JSON.stringify(item)) : null;
            this.detalleOpen = true;
        },

        cerrarDetalle() {
            this.detalleOpen = false;
            this.detalle = null;
        },

        onInputBusquedaPersona() {
            const q = String(this.busquedaPersona || "").trim();
            this.form.persona_usuario_id = "";
            this.personaSeleccionada = null;

            if (this.debounceBusquedaPersona) {
                clearTimeout(this.debounceBusquedaPersona);
                this.debounceBusquedaPersona = null;
            }
            if (q.length < 2) {
                this.personasEncontradas = [];
                this.mostrarSugerenciasPersona = false;
                return;
            }

            this.debounceBusquedaPersona = setTimeout(() => {
                this.buscarPersonas(q);
            }, 220);
        },

        onFocusBusquedaPersona() {
            if (this.personasEncontradas.length) {
                this.mostrarSugerenciasPersona = true;
            }
        },

        ocultarSugerenciasPersona() {
            this.mostrarSugerenciasPersona = false;
        },

        async buscarPersonas(q) {
            const query = String(q || "").trim();
            if (query.length < 2) {
                this.personasEncontradas = [];
                this.mostrarSugerenciasPersona = false;
                return;
            }
            this.buscandoPersonas = true;
            try {
                const res = await axios.get(`${API}/contrataciones/personas`, {
                    ...(this.getAuthConfig() || {}),
                    params: { search: query, limit: 10 }
                });
                this.personasEncontradas = Array.isArray(res.data) ? res.data : [];
                this.mostrarSugerenciasPersona = this.personasEncontradas.length > 0;
            } catch (e) {
                this.personasEncontradas = [];
                this.mostrarSugerenciasPersona = false;
            } finally {
                this.buscandoPersonas = false;
            }
        },

        seleccionarPersona(persona) {
            if (!persona) return;
            this.personaSeleccionada = { ...persona };
            this.anexosActivos = Array.isArray(persona.anexos_activos) ? persona.anexos_activos : (persona.anexo_activo ? [persona.anexo_activo] : []);
            this.anexoSeleccionadoId = this.anexosActivos.length === 1 ? this.anexosActivos[0].id : "";
            if (this.anexoSeleccionadoId) this.form.anexo_item_id = this.anexoSeleccionadoId;
            this.poblarFormularioDesdePersona(persona);
            this.busquedaPersona = String(persona.nombre_usuario || persona.nombre || "").trim() || this.busquedaPersona;
            this.personasEncontradas = [];
            this.mostrarSugerenciasPersona = false;
        },

        seleccionarAnexo(anexo) {
            if (!anexo) return;
            this.anexoSeleccionadoId = anexo.id;
            this.form.anexo_item_id = anexo.id;
            if (this.tipoModal === "Extension") {
                if (anexo.cliente_id) this.form.cliente_id = anexo.cliente_id;
                if (anexo.moneda) this.form.moneda = anexo.moneda;
                if (anexo.modulo_id) this.form.modulo_id = anexo.modulo_id;
                if (anexo.modulo_nombre) this.form.perfil = anexo.modulo_nombre;
                if (anexo.fecha_inicio) this.form.fecha_extension_desde = this.toDateInput(anexo.fecha_inicio);
                if (anexo.fecha_fin) this.form.fecha_extension_hasta = this.toDateInput(anexo.fecha_fin);
            }
        },

        limpiarPersonaSeleccionada() {
            this.form.persona_usuario_id = "";
            this.form.anexo_item_id = "";
            this.personaSeleccionada = null;
            this.anexosActivos = [];
            this.anexoSeleccionadoId = "";
            this.busquedaPersona = "";
            this.personasEncontradas = [];
            this.mostrarSugerenciasPersona = false;
        },

        perfilFormularioActual() {
            if (this.form.modulo_id && this.form.modulo_id !== "otros") {
                return this.buscarModuloPorId(this.form.modulo_id)?.titulo || this.form.perfil || "";
            }
            return String(this.form.perfil || "").trim();
        },

        tieneCambioExtensionSolicitado() {
            if (this.tipoModal !== "Extension") return true;

            const base = this.extensionBaseActual;
            const perfilActual = this.perfilFormularioActual();
            const clienteId = String(this.form.cliente_id || "").trim() || null;
            const supervisorId = String(this.form.supervisor_id || "").trim() || null;
            const supervisorRef = supervisorId || String(this.form.supervisor_azure_oid || "").trim() || null;
            const moneda = String(this.form.moneda || "").trim().toUpperCase() || null;
            const fechaDesde = String(this.form.fecha_extension_desde || "").trim() || null;
            const fechaHasta = String(this.form.fecha_extension_hasta || "").trim() || null;

            if (!base) {
                return Boolean(
                    fechaDesde ||
                    fechaHasta ||
                    clienteId ||
                    supervisorRef ||
                    perfilActual ||
                    moneda ||
                    this.normalizarNumero(this.form.tarifa_hora) !== null ||
                    this.normalizarNumero(this.form.tarifa_mes) !== null ||
                    this.normalizarNumero(this.form.tarifa_medio_tiempo) !== null ||
                    this.normalizarNumero(this.form.tarifa_capacitacion) !== null
                );
            }

            if ((fechaDesde || fechaHasta) && (fechaDesde !== (base.fecha_inicio || null) || fechaHasta !== (base.fecha_fin || null))) {
                return true;
            }
            if (clienteId && clienteId !== String(base.cliente_id || "")) return true;
            const supervisorBaseRef = String(base.supervisor_id || base.supervisor_azure_oid || "") || null;
            if (supervisorRef && supervisorRef !== supervisorBaseRef) return true;
            if (perfilActual && this.normalizarTexto(perfilActual) !== this.normalizarTexto(base.perfil || base.modulo_nombre || "")) {
                return true;
            }
            if (moneda && moneda !== String(base.moneda || "").trim().toUpperCase()) return true;
            if (!this.sonNumerosIguales(this.form.tarifa_hora, base.tarifa_hora)) return true;
            if (!this.sonNumerosIguales(this.form.tarifa_mes, base.tarifa_mes)) return true;
            if (!this.sonNumerosIguales(this.form.tarifa_medio_tiempo, base.tarifa_medio_tiempo)) return true;
            if (!this.sonNumerosIguales(this.form.tarifa_capacitacion, base.tarifa_capacitacion)) return true;

            return false;
        },

        validarFormulario() {
            const errors = [];
            if (!String(this.form.nombre || "").trim()) errors.push("Nombres");
            if (!String(this.form.apellidos || "").trim()) errors.push("Apellidos");

            if (this.tipoModal === "Nuevo") {
                const esProspecto = this.form.cliente_id === "__prospecto__";
                if (!String(this.form.tipo_documento_id || "").trim()) errors.push("Tipo de documento");
                if (!String(this.form.numero_documento || "").trim()) errors.push("Numero de documento");
                if (!String(this.form.correo_personal || "").trim()) errors.push("Correo personal");
                if (!String(this.form.cliente_id || "").trim()) errors.push("Cliente");
                if (esProspecto && !String(this.form.cliente_nombre_prospecto || "").trim()) errors.push("Nombre del cliente prospecto");
                if (!String(this.form.moneda || "").trim()) errors.push("Moneda");
                if (!["true", "false"].includes(String(this.form.factura_en_colombia || "").trim())) errors.push("Factura en Colombia");
                if (!String(this.form.fecha_inicio || "").trim()) errors.push("Fecha inicio");
                if (!String(this.form.modulo_id || "").trim() && !String(this.form.perfil || "").trim()) {
                    errors.push("Perfil / Modulo");
                }
                if (this.form.crear_usuario_sistema !== false && !String(this.form.grupo_usuario || "").trim()) {
                    errors.push("Grupo de usuario");
                }
                const alguna = [
                    this.form.tarifa_hora,
                    this.form.tarifa_mes,
                    this.form.tarifa_medio_tiempo,
                    this.form.tarifa_capacitacion
                ].some((t) => t !== "" && t !== null && t !== undefined && Number.isFinite(Number(t)) && Number(t) > 0);
                if (!alguna) errors.push("Se requiere al menos una tarifa");
                if (this.form.modulo_id === "otros" && !String(this.form.perfil || "").trim()) {
                    errors.push("Especifique el perfil");
                }
                if (this.form.grupo_usuario === "Otro" && !String(this.form.grupo_usuario_otro || "").trim()) {
                    errors.push("Especifique el grupo de usuario");
                }
                if (!["Todos Silver", "Vinculados"].includes(String(this.form.grupo_distribucion || "").trim())) {
                    errors.push("Grupo de distribución (Todos Silver o Vinculados)");
                }
            }

            if (this.tipoModal === "Retiro") {
                if (!String(this.form.correo_personal || "").trim()) errors.push("Email del consultor");
                if (!String(this.form.grupo_app_tiempos || "").trim()) errors.push("Grupo de usuario");
                if (!String(this.form.supervisor_id || this.form.supervisor_azure_oid || "").trim()) {
                    errors.push("Responsable / Coordinador");
                }
                if (!String(this.form.fecha_retiro || "").trim()) errors.push("Fecha de retiro");
                if (!String(this.form.necesidad_ti || "").trim()) errors.push("Acciones requeridas a TI");
                if (this.anexosActivos.length > 0 && !this.anexoSeleccionadoId) {
                    errors.push("Selecciona el contrato que se va a retirar");
                }
            }

            if (this.tipoModal === "Extension") {
                if (this.anexosActivos.length > 1 && !this.anexoSeleccionadoId) {
                    errors.push("Selecciona el contrato que se va a modificar");
                }
                if (!String(this.form.numero_documento || "").trim() && !String(this.form.persona_usuario_id || "").trim()) {
                    errors.push("Busca una persona existente o digita el numero de documento");
                }
                if (!String(this.form.correo_personal || "").trim() && !String(this.form.correo_empresarial || "").trim()) {
                    errors.push("Correo personal o correo empresarial");
                }
                if (!String(this.form.moneda || "").trim()) errors.push("Moneda");
                if (!String(this.form.modulo_id || "").trim() && !String(this.form.perfil || "").trim()) {
                    errors.push("Perfil / Modulo");
                }
                if (this.form.modulo_id === "otros" && !String(this.form.perfil || "").trim()) {
                    errors.push("Especifique el perfil");
                }
                if (!this.tieneCambioExtensionSolicitado()) {
                    errors.push("Indica al menos un cambio en tarifas, fechas, cliente, responsable o perfil");
                }
            }

            return errors;
        },

        onModuloChange() {
            const id = this.form.modulo_id;
            if (!id) return;
            if (id === "otros") {
                this.form.perfil = "";
                return;
            }
            const modulo = this.buscarModuloPorId(id);
            if (modulo) this.form.perfil = modulo.titulo;
        },

        get perfilEsOtro() {
            return (this.tipoModal === "Nuevo" || this.tipoModal === "Extension") && this.form.modulo_id === "otros";
        },

        get grupoUsuarioEsOtro() {
            return this.tipoModal === "Nuevo" && this.form.grupo_usuario === "Otro";
        },

        get grupoDistribucionEsVinculado() {
            return this.tipoModal === "Nuevo" && this.form.grupo_distribucion === "Vinculados";
        },

        onGrupoDistribucionChange() {
            if (!this.grupoDistribucionEsVinculado) return;
            this.form.vpn_corona = false;
            this.form.necesita_s_user = false;
        },

        get monedasDisponibles() {
            return this.ensureMonedasDisponibles(this.form.moneda);
        },

        get anexoSeleccionado() {
            if (!this.anexoSeleccionadoId || !this.anexosActivos.length) return null;
            return this.anexosActivos.find((a) => a.id === this.anexoSeleccionadoId) || null;
        },

        get extensionBaseActual() {
            const selectedAnexo = this.anexoSeleccionado;
            const personaBase = selectedAnexo
                ? this.construirBaseExtensionDesdePersona({ ...this.personaSeleccionada, anexo_activo: selectedAnexo })
                : this.construirBaseExtensionDesdePersona(this.personaSeleccionada);
            return this.combinarBasesExtension(
                personaBase,
                this.construirBaseExtensionDesdeDatos(this.datosExtraBase?.extension_base)
            );
        },

        get extensionCambiosPrevios() {
            return Array.isArray(this.datosExtraBase?.extension_cambios)
                ? this.datosExtraBase.extension_cambios.filter(Boolean)
                : [];
        },

        get extensionCorreosObjetivo() {
            return [this.form.correo_personal, this.form.correo_empresarial]
                .map((item) => String(item || "").trim())
                .filter(Boolean);
        },

        get extensionRequiereFechas() {
            const tipo = String(
                this.personaSeleccionada?.tipo_asignacion ||
                this.extensionBaseActual?.tipo_asignacion ||
                ""
            ).trim();
            return EXTENSION_TIPOS_CON_FECHA.includes(tipo);
        },

        get extensionHelperFechas() {
            const tipo = this.personaSeleccionada?.tipo_asignacion_label || this.extensionBaseActual?.tipo_asignacion_label || "este contrato";
            if (this.extensionRequiereFechas) {
                return `Para ${tipo}, estas fechas ayudan a sincronizar el anexo tecnico.`;
            }
            return "Si solo cambias tarifas, cliente o responsable, puedes dejar estas fechas vacias.";
        },

        construirPayload() {
            const moduloId = this.form.modulo_id && this.form.modulo_id !== "otros" ? this.form.modulo_id : "";
            const perfil = this.perfilFormularioActual();
            const moneda = String(this.form.moneda || "").trim().toUpperCase();
            const datosExtra = { ...(this.datosExtraBase || {}) };
            if (moduloId) datosExtra.modulo_id = moduloId;
            else delete datosExtra.modulo_id;
            if (perfil) datosExtra.modulo_nombre = perfil;
            else delete datosExtra.modulo_nombre;
            datosExtra.supervisor_nombre = String(this.form.supervisor_nombre || "").trim() || null;
            datosExtra.supervisor_email = String(this.form.supervisor_email || "").trim() || null;
            datosExtra.supervisor_azure_oid = String(this.form.supervisor_azure_oid || "").trim() || null;

            const base = {
                ...this.form,
                modulo_id: moduloId,
                perfil,
                moneda,
                tipo_solicitud: this.tipoModal,
                crear_usuario_sistema: this.form.crear_usuario_sistema !== false,
                enviar_correos: true,
                datos_extra: datosExtra
            };
            base.supervisor_id = String(this.form.supervisor_id || "").trim() || null;
            const facturaEnColombiaRaw = String(this.form.factura_en_colombia || "").trim();
            if (["true", "false"].includes(facturaEnColombiaRaw)) {
                base.factura_en_colombia = facturaEnColombiaRaw === "true";
                datosExtra.factura_en_colombia = base.factura_en_colombia;
            } else {
                delete base.factura_en_colombia;
                delete datosExtra.factura_en_colombia;
            }

            if (this.tipoModal === "Extension" || this.tipoModal === "Retiro") {
                if (this.form.anexo_item_id) datosExtra.anexo_item_id = this.form.anexo_item_id;
                base.datos_extra = datosExtra;
            }

            if (this.tipoModal === "Nuevo") {
                // Prospecto: enviar cliente_nombre en datos_extra, null cliente_id
                const esProspecto = this.form.cliente_id === "__prospecto__";
                if (esProspecto) {
                    base.cliente_id = null;
                    datosExtra.cliente_nombre = String(this.form.cliente_nombre_prospecto || "").trim() || null;
                } else {
                    datosExtra.cliente_nombre = null;
                }
                // Tipo de asignación explícito para el anexo técnico
                if (this.form.tipo_asignacion) datosExtra.tipo_asignacion = this.form.tipo_asignacion;
                base.datos_extra = datosExtra;
                // Campos técnicos del nuevo modal
                const esVinculado = this.form.grupo_distribucion === "Vinculados";
                base.vpn_corona       = esVinculado ? false : Boolean(this.form.vpn_corona);
                base.necesita_s_user  = esVinculado ? false : Boolean(this.form.necesita_s_user);
                base.ubicacion        = String(this.form.pais_ubicacion || "").trim() || null;
                base.grupo_app_tiempos = this.form.grupo_usuario || null;
                base.grupo_usuario_otro = this.form.grupo_usuario === "Otro"
                    ? (String(this.form.grupo_usuario_otro || "").trim() || null)
                    : null;
                base.grupo_distribucion = String(this.form.grupo_distribucion || "").trim() || null;
            }

            return base;
        },

        async guardarSolicitud() {
            if (this.guardandoSolicitud) return;
            this.erroresFormulario = this.validarFormulario();
            if (this.erroresFormulario.length) return;

            const payload = this.construirPayload();

            this.guardandoSolicitud = true;
            try {
                if (this.modoEdicion && this.solicitudEditId) {
                    await axios.post(
                        `${API}/contrataciones/solicitudes/${this.solicitudEditId}/completar`,
                        payload,
                        this.getAuthConfig()
                    );
                } else {
                    await axios.post(`${API}/contrataciones/solicitudes`, payload, this.getAuthConfig());
                }
                this.cerrarModal();
                await this.cargarSolicitudes();
            } catch (e) {
                const msg = e?.response?.data?.error || (this.modoEdicion ? "Error completando solicitud" : "Error creando solicitud");
                alert(msg);
            } finally {
                this.guardandoSolicitud = false;
            }
        },

        async enviarATH(item) {
            if (!item?.id) return;
            if (this.enviandoTh) return;
            if (!confirm("Se enviara esta solicitud a Talento Humano. Deseas continuar?")) return;
            this.enviandoTh = true;
            try {
                await axios.post(`${API}/contrataciones/solicitudes/${item.id}/enviar-th`, {}, this.getAuthConfig());
                await this.cargarSolicitudes();
                if (this.detalle?.id === item.id) {
                    const actualizado = this.solicitudes.find((s) => s.id === item.id) || null;
                    this.detalle = actualizado;
                }
            } catch (e) {
                const msg = e?.response?.data?.error || "Error enviando a Talento Humano";
                alert(msg);
            } finally {
                this.enviandoTh = false;
            }
        },

        esPendienteConfirmacionCliente(estado) {
            return this.normalizarTexto(estado) === "pendiente confirmacion cliente";
        },

        puedeEnviarTH(item) {
            return (
                !!item &&
                item.tipo_solicitud === "Nuevo" &&
                item.requiere_confirmacion_cliente === true &&
                this.esPendienteConfirmacionCliente(item.estado) &&
                item.correo_enviado_th !== true
            );
        },

        responsableContinuacion(item) {
            const requesterRole = this.normalizarTexto(
                item?.coordinador?.rol ||
                item?.solicitud?.responsable_continuacion_rol ||
                item?.solicitud?.solicitante_rol ||
                ""
            );
            if (requesterRole === "comercial") return "comercial";
            return "coordinador";
        },

        puedeContinuar(item) {
            const estado = this.normalizarTexto(item?.estado);
            const roleKey = window.auth?.getRoleKey?.() || "other";
            const responsibleRole = this.responsableContinuacion(item);
            const estadosContinuable = ["pendiente", "pendiente coordinador", "pendiente comercial"];
            const currentUserId = String(window.auth?.getUser?.()?.id || "").trim();
            const ownerId = String(item?.coordinador?.id || "").trim();
            const sameOwner = currentUserId && ownerId && currentUserId === ownerId;
            const canActByRole =
                roleKey === "admin" ||
                roleKey === responsibleRole ||
                (responsibleRole === "coordinador" && roleKey === "coordinador" && sameOwner);
            return (
                !!item &&
                item.tipo_solicitud === "Nuevo" &&
                canActByRole &&
                estadosContinuable.includes(estado)
            );
        },

        estadoClass(estado) {
            if (estado === "Completado") return "bg-emerald-100 text-emerald-700";
            if (this.esPendienteConfirmacionCliente(estado)) return "bg-amber-100 text-amber-700";
            if (estado === "En Proceso") return "bg-blue-100 text-blue-700";
            if (estado === "Pendiente Coordinador") return "bg-slate-100 text-slate-700";
            if (estado === "Pendiente Comercial") return "bg-orange-100 text-orange-700";
            if (estado === "Pendiente") return "bg-slate-100 text-slate-700";
            return "bg-slate-100 text-slate-600";
        },

        incluyeBusqueda(item) {
            const q = String(this.busqueda || "").trim().toLowerCase();
            if (!q) return true;
            const bag = [
                `${item?.nombre || ""} ${item?.apellidos || ""}`,
                item?.numero_documento || "",
                item?.correo_personal || "",
                item?.correo_empresarial || "",
                item?.cliente?.nombre || "",
                item?.tipo_solicitud || "",
                item?.estado || ""
            ]
                .join(" ")
                .toLowerCase();
            return bag.includes(q);
        },

        get estadosDisponibles() {
            const set = new Set((this.solicitudes || []).map((s) => s?.estado).filter(Boolean));
            return Array.from(set);
        },

        get solicitudesFiltradas() {
            return (this.solicitudes || []).filter((item) => {
                if (this.filtroEstado && item?.estado !== this.filtroEstado) return false;
                return this.incluyeBusqueda(item);
            });
        }
    };
};
