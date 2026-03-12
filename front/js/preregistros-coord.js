// js/preregistros-coord.js
window.preregistrosCoordApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

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

        form: emptyForm(),
        busquedaPersona: "",
        personasEncontradas: [],
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
            } catch (e) {
                this.clientes = [];
                this.modulos = [];
                this.documentos = [];
                this.supervisores = [];
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

        abrirModal(tipo) {
            this.tipoModal = tipo;
            this.modalOpen = true;
            this.form = emptyForm();
            this.personasEncontradas = [];
            this.busquedaPersona = "";
            this.erroresFormulario = [];
        },

        cerrarModal() {
            this.modalOpen = false;
            this.form = emptyForm();
            this.personasEncontradas = [];
            this.busquedaPersona = "";
            this.erroresFormulario = [];
        },

        abrirDetalle(item) {
            this.detalle = item ? JSON.parse(JSON.stringify(item)) : null;
            this.detalleOpen = true;
        },

        cerrarDetalle() {
            this.detalleOpen = false;
            this.detalle = null;
        },

        async buscarPersonas() {
            const q = String(this.busquedaPersona || "").trim();
            if (q.length < 2) {
                this.personasEncontradas = [];
                return;
            }
            try {
                const res = await axios.get(`${API}/contrataciones/personas`, {
                    ...(this.getAuthConfig() || {}),
                    params: { search: q, limit: 10 }
                });
                this.personasEncontradas = Array.isArray(res.data) ? res.data : [];
            } catch (e) {
                this.personasEncontradas = [];
            }
        },

        seleccionarPersona(persona) {
            if (!persona) return;
            this.form.persona_usuario_id = persona.id || "";
            this.form.tipo_documento_id = persona.tipo_documento_id || "";
            this.form.numero_documento = persona.numero_documento || "";
            this.form.correo_empresarial = persona.correo_empresarial || "";
            this.form.telefono = persona.telefono || "";

            const nombreCompleto = String(persona.nombre_usuario || "").trim();
            const partes = nombreCompleto ? nombreCompleto.split(/\s+/) : [];
            if (!this.form.nombre && partes.length) {
                this.form.nombre = partes.slice(0, 2).join(" ");
            }
            if (!this.form.apellidos && partes.length > 2) {
                this.form.apellidos = partes.slice(2).join(" ");
            }
            this.personasEncontradas = [];
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

        async guardarSolicitud() {
            this.erroresFormulario = this.validarFormulario();
            if (this.erroresFormulario.length) return;

            const payload = {
                ...this.form,
                tipo_solicitud: this.tipoModal,
                datos_extra: {
                    modulo_id: this.form.modulo_id || null
                }
            };

            try {
                await axios.post(`${API}/contrataciones/solicitudes`, payload, this.getAuthConfig());
                this.cerrarModal();
                await this.cargarSolicitudes();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error creando solicitud";
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

        puedeEnviarTH(item) {
            return (
                !!item &&
                item.tipo_solicitud === "Nuevo" &&
                item.requiere_confirmacion_cliente === true &&
                item.estado === "Pendiente Confirmación Cliente" &&
                item.correo_enviado_th !== true
            );
        },

        estadoClass(estado) {
            if (estado === "Completado") return "bg-emerald-100 text-emerald-700";
            if (estado === "Pendiente Confirmación Cliente") return "bg-amber-100 text-amber-700";
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
