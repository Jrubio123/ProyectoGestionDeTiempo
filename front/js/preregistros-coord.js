// js/preregistros-coord.js
window.preregistrosCoordApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const DRAFT_SOURCE_RRHH = "rrhh";

    const emptyForm = () => ({
        persona_usuario_id: "",
        tipo_documento_id: "",
        cliente_id: "",
        supervisor_id: "",
        modulo_id: "",
        nombre: "",
        apellidos: "",
        numero_documento: "",
        perfil: "",
        correo_personal: "",
        correo_empresarial: "",
        telefono: "",
        ubicacion: "",
        grupo_app_tiempos: "",
        grupo_distribucion: "",
        moneda: "COP",
        tarifa_hora: "",
        tarifa_mes: "",
        tarifa_medio_tiempo: "",
        tarifa_capacitacion: "",
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
        supervisores: [],

        filtroEstado: "",
        busqueda: "",

        modalOpen: false,
        detalleOpen: false,
        tipoModal: "Nuevo",
        detalle: null,

        modoEdicion: false,
        solicitudEditId: null,
        datosExtraBase: {},

        form: emptyForm(),
        busquedaPersona: "",
        personasEncontradas: [],
        personaSeleccionada: null,
        mostrarSugerenciasPersona: false,
        buscandoPersonas: false,
        debounceBusquedaPersona: null,

        erroresFormulario: [],

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async init() {
            await Promise.all([this.cargarCatalogos(), this.cargarSolicitudes()]);
        },

        async cargarCatalogos() {
            try {
                const [clientes, modulos, documentos, supervisores] = await Promise.all([
                    axios.get(`${API}/clientes`, this.getAuthConfig()),
                    axios.get(`${API}/modulos`, this.getAuthConfig()),
                    axios.get(`${API}/documentos-identidad`, this.getAuthConfig()),
                    axios.get(`${API}/supervisores`, this.getAuthConfig())
                ]);
                this.clientes = Array.isArray(clientes.data) ? clientes.data : [];
                this.modulos = Array.isArray(modulos.data) ? modulos.data : [];
                this.documentos = Array.isArray(documentos.data) ? documentos.data : [];
                this.supervisores = Array.isArray(supervisores.data) ? supervisores.data : [];
                this.incluirSolicitanteEnSupervisores();
            } catch (e) {
                this.clientes = [];
                this.modulos = [];
                this.documentos = [];
                this.supervisores = [];
                this.incluirSolicitanteEnSupervisores();
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
                email: String(user?.email || "").trim() || null
            };
        },

        incluirSolicitanteEnSupervisores() {
            const solicitante = this.usuarioSolicitanteActual();
            if (!solicitante?.id) return;
            const yaExiste = (this.supervisores || []).some((sup) => String(sup?.id || "") === solicitante.id);
            if (yaExiste) return;
            this.supervisores = [solicitante, ...(this.supervisores || [])];
        },

        aplicarSupervisorPorDefecto() {
            this.incluirSolicitanteEnSupervisores();
            const currentUserId = this.usuarioSolicitanteActual()?.id || "";
            if (!currentUserId) return;
            this.form.supervisor_id = currentUserId;
        },

        mapSolicitudToForm(item) {
            return {
                persona_usuario_id: item?.persona?.id || "",
                tipo_documento_id: item?.tipo_documento?.id || "",
                cliente_id: item?.cliente?.id || "",
                supervisor_id: item?.supervisor?.id || "",
                modulo_id: item?.datos_extra?.modulo_id || "",
                nombre: item?.nombre || "",
                apellidos: item?.apellidos || "",
                numero_documento: item?.numero_documento || "",
                perfil: item?.perfil || "",
                correo_personal: item?.correo_personal || "",
                correo_empresarial: item?.correo_empresarial || "",
                telefono: item?.telefono || "",
                ubicacion: item?.ubicacion || "",
                grupo_app_tiempos: item?.grupo_app_tiempos || "",
                grupo_distribucion: item?.grupo_distribucion || "",
                moneda: item?.moneda || "COP",
                tarifa_hora: item?.tarifa_hora ?? "",
                tarifa_mes: item?.tarifa_mes ?? "",
                tarifa_medio_tiempo: item?.tarifa_medio_tiempo ?? "",
                tarifa_capacitacion: item?.tarifa_capacitacion ?? "",
                modalidad_contrato: item?.modalidad_contrato || "",
                fecha_inicio: item?.fecha_inicio || "",
                fecha_fin: item?.fecha_fin || "",
                fecha_extension_desde: item?.fecha_extension_desde || "",
                fecha_extension_hasta: item?.fecha_extension_hasta || "",
                fecha_retiro: item?.fecha_retiro || "",
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
                if (item?.persona?.id) {
                    this.personaSeleccionada = { ...item.persona };
                    this.busquedaPersona = item?.persona?.nombre || "";
                } else {
                    this.busquedaPersona = "";
                }
                return;
            }

            this.modoEdicion = false;
            this.solicitudEditId = null;
            this.datosExtraBase = {};
            this.form = emptyForm();
            this.busquedaPersona = "";
            this.aplicarSupervisorPorDefecto();
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
            this.form = emptyForm();
            this.personasEncontradas = [];
            this.busquedaPersona = "";
            this.personaSeleccionada = null;
            this.mostrarSugerenciasPersona = false;
            this.buscandoPersonas = false;
            this.erroresFormulario = [];
            if (this.debounceBusquedaPersona) {
                clearTimeout(this.debounceBusquedaPersona);
                this.debounceBusquedaPersona = null;
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
            this.form.persona_usuario_id = persona.id || "";
            this.form.tipo_documento_id = persona.tipo_documento_id || "";
            this.form.numero_documento = persona.numero_documento || "";
            this.form.correo_empresarial = persona.correo_empresarial || "";
            this.form.telefono = persona.telefono || "";
            this.personaSeleccionada = { ...persona };

            const nombreCompleto = String(persona.nombre_usuario || "").trim();
            const partes = nombreCompleto ? nombreCompleto.split(/\s+/) : [];
            if (!String(this.form.nombre || "").trim() && partes.length) {
                this.form.nombre = partes.slice(0, 2).join(" ");
            }
            if (!String(this.form.apellidos || "").trim() && partes.length > 2) {
                this.form.apellidos = partes.slice(2).join(" ");
            }

            this.busquedaPersona = nombreCompleto || this.busquedaPersona;
            this.personasEncontradas = [];
            this.mostrarSugerenciasPersona = false;
        },

        limpiarPersonaSeleccionada() {
            this.form.persona_usuario_id = "";
            this.personaSeleccionada = null;
            this.busquedaPersona = "";
            this.personasEncontradas = [];
            this.mostrarSugerenciasPersona = false;
        },

        validarFormulario() {
            const errors = [];
            if (!String(this.form.nombre || "").trim()) errors.push("Nombres");
            if (!String(this.form.apellidos || "").trim()) errors.push("Apellidos");
            if (!String(this.form.necesidad_ti || "").trim()) errors.push("Que necesitas de TI");
            if (this.tipoModal === "Nuevo" && !String(this.form.cliente_id || "").trim()) errors.push("Cliente");
            if (this.tipoModal === "Retiro" && !String(this.form.fecha_retiro || "").trim()) errors.push("Fecha retiro");
            return errors;
        },

        construirPayload() {
            const datosExtra = {
                ...(this.datosExtraBase || {})
            };
            if (this.form.modulo_id) {
                datosExtra.modulo_id = this.form.modulo_id;
            }

            return {
                ...this.form,
                tipo_solicitud: this.tipoModal,
                enviar_correos: true,
                datos_extra: datosExtra
            };
        },

        async guardarSolicitud() {
            this.erroresFormulario = this.validarFormulario();
            if (this.erroresFormulario.length) return;

            const payload = this.construirPayload();

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
            }
        },

        async enviarATH(item) {
            if (!item?.id) return;
            if (!confirm("Se enviara esta solicitud a Talento Humano. Deseas continuar?")) return;
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
            }
        },

        normalizarTexto(value) {
            return String(value || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .trim();
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

        puedeContinuar(item) {
            return (
                !!item &&
                item.tipo_solicitud === "Nuevo" &&
                item.estado === "Pendiente" &&
                String(item?.datos_extra?.origen || "").toLowerCase() === DRAFT_SOURCE_RRHH
            );
        },

        estadoClass(estado) {
            if (estado === "Completado") return "bg-emerald-100 text-emerald-700";
            if (this.esPendienteConfirmacionCliente(estado)) return "bg-amber-100 text-amber-700";
            if (estado === "En Proceso") return "bg-blue-100 text-blue-700";
            if (estado === "Pendiente") return "bg-slate-100 text-slate-700";
            return "bg-slate-100 text-slate-600";
        },

        formatFecha(value) {
            if (!value) return "-";
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return String(value);
            return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
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
