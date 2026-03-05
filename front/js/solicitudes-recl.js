// js/solicitudes-recl.js
window.solicitudesReclApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    const emptyS1 = () => ({
        nombre: "",
        apellidos: "",
        tipo_documento: "Cedula de Ciudadania",
        numero_documento: "",
        telefono: "",
        correo_personal: "",
        pais_ubicacion: "",
        ciudad: ""
    });

    return {
        solicitudes: [],
        preregistrosBySolicitud: {},
        filtro: "Todos",
        modalDetalle: false,
        modalNotas: false,
        modalSeccion1: false,
        guardandoSeccion1: false,
        modoSeccion1: "crear",
        itemActivo: {},
        solicitudObjetivo: null,
        preregistroObjetivo: null,
        formS1: emptyS1(),

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async init() {
            await this.cargarSolicitudes();
            await this.cargarPreregistros();
            this.hidratarSolicitudesConPreregistro();
        },

        async cargarSolicitudes() {
            try {
                const res = await axios.get(`${API}/rrhh/solicitudes`, this.getAuthConfig());
                this.solicitudes = res.data || [];
            } catch (e) {
                this.solicitudes = [];
            }
        },

        async cargarPreregistros() {
            try {
                const res = await axios.get(`${API}/api/preregistros?limit=300&page=1`, this.getAuthConfig());
                const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
                const map = {};
                rows.forEach((p) => {
                    const solicitudId = p?.solicitud?.id;
                    if (!solicitudId) return;
                    map[solicitudId] = p;
                });
                this.preregistrosBySolicitud = map;
            } catch (e) {
                this.preregistrosBySolicitud = {};
            }
        },

        hidratarSolicitudesConPreregistro() {
            this.solicitudes = (this.solicitudes || []).map((s) => {
                const p = this.preregistrosBySolicitud[s.id] || null;
                return {
                    ...s,
                    preregistro_id: p?.id || null,
                    preregistro_estado: p?.estado || null
                };
            });
        },

        get solicitudesFiltradas() {
            if (this.filtro === "Todos") return this.solicitudes;
            return this.solicitudes.filter((s) => s.estado === this.filtro || s.preregistro_estado === this.filtro);
        },

        esSolicitudBloqueada(s) {
            return s?.estado === "Contratado";
        },

        puedeEditarDatosPersonales(s) {
            return s?.estado === "Contratado" && !!s?.preregistro_id && s?.preregistro_estado === "Pendiente Coordinador";
        },

        async cambiarEstadoDirecto(id, nuevoEstado) {
            await axios.put(`${API}/rrhh/solicitudes/${id}`, { estado: nuevoEstado }, this.getAuthConfig());
            this.solicitudes = this.solicitudes.map((s) => (s.id === id ? { ...s, estado: nuevoEstado } : s));
        },

        async manejarCambioEstado(s, nuevoEstado, targetEl) {
            const estadoAnterior = s.estado;
            if (this.esSolicitudBloqueada(s)) {
                if (targetEl) targetEl.value = estadoAnterior;
                return;
            }

            if (nuevoEstado === "Contratado" && estadoAnterior !== "Contratado") {
                if (targetEl) targetEl.value = estadoAnterior;
                this.abrirModalSeccion1Crear(s);
                return;
            }

            try {
                await this.cambiarEstadoDirecto(s.id, nuevoEstado);
            } catch (e) {
                const msg = e?.response?.data?.error || "Error actualizando estado";
                alert(msg);
                if (targetEl) targetEl.value = estadoAnterior;
            }
        },

        abrirModalSeccion1Crear(s) {
            this.modoSeccion1 = "crear";
            this.solicitudObjetivo = { ...s };
            this.preregistroObjetivo = null;
            this.formS1 = emptyS1();
            this.modalSeccion1 = true;
        },

        abrirModalSeccion1Editar(s) {
            const p = this.preregistrosBySolicitud[s.id] || null;
            if (!p?.id) return;
            this.modoSeccion1 = "editar";
            this.solicitudObjetivo = { ...s };
            this.preregistroObjetivo = p;
            this.formS1 = {
                nombre: p.nombre || "",
                apellidos: p.apellidos || "",
                tipo_documento: p.tipo_documento || "Cedula de Ciudadania",
                numero_documento: p.numero_documento || "",
                telefono: p.telefono || "",
                correo_personal: p.correo_personal || "",
                pais_ubicacion: p.pais_ubicacion || "",
                ciudad: p.ciudad || ""
            };
            this.modalSeccion1 = true;
        },

        cerrarModalSeccion1() {
            this.modalSeccion1 = false;
            this.solicitudObjetivo = null;
            this.preregistroObjetivo = null;
            this.formS1 = emptyS1();
            this.guardandoSeccion1 = false;
        },

        validarSeccion1() {
            const req = ["nombre", "apellidos", "tipo_documento", "numero_documento", "correo_personal"];
            for (const k of req) {
                if (!String(this.formS1?.[k] || "").trim()) return false;
            }
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(this.formS1.correo_personal || "").trim());
        },

        async guardarSeccion1() {
            if (!this.solicitudObjetivo?.id) return;
            if (!this.validarSeccion1()) {
                alert("Completa los campos obligatorios y valida el correo personal.");
                return;
            }

            this.guardandoSeccion1 = true;
            const payload = {
                ...this.formS1,
                nombre: String(this.formS1.nombre || "").trim(),
                apellidos: String(this.formS1.apellidos || "").trim(),
                tipo_documento: String(this.formS1.tipo_documento || "").trim(),
                numero_documento: String(this.formS1.numero_documento || "").trim(),
                telefono: String(this.formS1.telefono || "").trim() || null,
                correo_personal: String(this.formS1.correo_personal || "").trim().toLowerCase(),
                pais_ubicacion: String(this.formS1.pais_ubicacion || "").trim() || null,
                ciudad: String(this.formS1.ciudad || "").trim() || null
            };

            try {
                if (this.modoSeccion1 === "crear") {
                    await axios.post(
                        `${API}/api/solicitudes-rrhh/${this.solicitudObjetivo.id}/contratar`,
                        payload,
                        this.getAuthConfig()
                    );
                    this.solicitudes = this.solicitudes.map((s) => (
                        s.id === this.solicitudObjetivo.id ? { ...s, estado: "Contratado" } : s
                    ));
                } else {
                    await axios.patch(
                        `${API}/api/preregistros/${this.preregistroObjetivo.id}/seccion-1`,
                        payload,
                        this.getAuthConfig()
                    );
                }

                await this.cargarPreregistros();
                this.hidratarSolicitudesConPreregistro();
                this.cerrarModalSeccion1();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error guardando datos personales";
                alert(msg);
            } finally {
                this.guardandoSeccion1 = false;
            }
        },

        abrirDetalle(s) {
            this.itemActivo = { ...s };
            this.modalNotas = false;
            this.modalDetalle = true;
        },

        abrirNotas(s) {
            this.itemActivo = { ...s };
            this.modalDetalle = false;
            this.modalNotas = true;
        },

        async guardarNotas() {
            if (!this.itemActivo?.id) return;
            try {
                await axios.put(
                    `${API}/rrhh/solicitudes/${this.itemActivo.id}`,
                    { observaciones_rrhh: this.itemActivo.observaciones_rrhh || "" },
                    this.getAuthConfig()
                );
                this.solicitudes = this.solicitudes.map((s) =>
                    s.id === this.itemActivo.id
                        ? { ...s, observaciones_rrhh: this.itemActivo.observaciones_rrhh || "" }
                        : s
                );
                this.modalDetalle = false;
                this.modalNotas = false;
            } catch (e) {
                const msg = e?.response?.data?.error || "Error guardando notas";
                alert(msg);
            }
        },

        formatFecha(fecha) {
            if (!fecha) return "-";
            const valor = String(fecha).trim();
            if (!valor) return "-";
            const soloFecha = valor.match(/^(\d{4})-(\d{2})-(\d{2})/);
            let dateObj;
            if (soloFecha) {
                const [, year, month, day] = soloFecha;
                dateObj = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
            } else {
                dateObj = new Date(valor);
            }
            if (Number.isNaN(dateObj.getTime())) return valor;
            return dateObj.toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });
        }
    };
};
