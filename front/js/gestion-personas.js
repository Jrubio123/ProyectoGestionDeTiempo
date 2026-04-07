// js/gestion-personas.js
window.gestionPersonasApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        esAdmin: false,
        cargando: false,
        cargandoFicha: false,

        personas: [],
        filtroTexto: "",
        filtroRol: "todos",
        filtroEstado: "todos",

        ficha: null,

        cat: {
            roles: [],
            bancos: [],
            tiposCuenta: [],
            tiposDocumento: [],
            principales: []
        },

        editando: {
            identidad: false,
            personal: false,
            cobro: false,
            operativa: false
        },
        draft: {
            identidad: {},
            personal: {},
            cobro: {},
            operativa: {}
        },
        guardando: {
            identidad: false,
            personal: false,
            cobro: false,
            operativa: false
        },
        errores: {
            identidad: null,
            personal: null,
            cobro: null,
            operativa: null
        },

        async init() {
            const cfg = this.getAuthConfig();
            if (!cfg) {
                window.location.href = "/login.html";
                return;
            }

            const roleKey = window.auth?.getRoleKey?.() || "other";
            this.esAdmin = roleKey === "admin";

            await Promise.all([
                this.cargarPersonas(),
                this.esAdmin ? this.cargarCatalogos() : Promise.resolve()
            ]);
        },

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async cargarPersonas() {
            this.cargando = true;
            try {
                const res = await axios.get(`${API}/admin/personas`, this.getAuthConfig());
                this.personas = res.data || [];
            } catch (e) {
                this.personas = [];
            } finally {
                this.cargando = false;
            }
        },

        get personasFiltradas() {
            return this.personas.filter((p) => {
                const txt = String(this.filtroTexto || "").toLowerCase().trim();
                const matchTxt = !txt ||
                    String(p.nombre_usuario || "").toLowerCase().includes(txt) ||
                    String(p.email || "").toLowerCase().includes(txt) ||
                    String(p.rol || "").toLowerCase().includes(txt) ||
                    String(p.ciudad || "").toLowerCase().includes(txt);

                const matchRol = this.filtroRol === "todos" || String(p.rol || "") === this.filtroRol;
                const matchEstado =
                    this.filtroEstado === "todos" ||
                    (this.filtroEstado === "activos" && p.activo) ||
                    (this.filtroEstado === "inactivos" && !p.activo);

                return matchTxt && matchRol && matchEstado;
            });
        },

        get rolesUnicos() {
            const set = new Set(this.personas.map((p) => p.rol).filter(Boolean));
            return Array.from(set).sort();
        },

        async seleccionar(persona) {
            if (this.ficha?.id === persona.id) return;
            this.ficha = null;
            this.cerrarTodosLosDrafts();
            this.cargandoFicha = true;
            try {
                const res = await axios.get(`${API}/admin/personas/${persona.id}`, this.getAuthConfig());
                this.ficha = res.data;
            } catch (e) {
                this.ficha = null;
            } finally {
                this.cargandoFicha = false;
            }
        },

        cerrarTodosLosDrafts() {
            Object.keys(this.editando).forEach((k) => {
                this.editando[k] = false;
                this.errores[k] = null;
            });
        },

        async cargarCatalogos() {
            try {
                const [resRoles, resBancos, resTiposCuenta, resDocs, resPrincipales] = await Promise.all([
                    axios.get(`${API}/admin/roles`, this.getAuthConfig()),
                    axios.get(`${API}/admin/bancos`, this.getAuthConfig()),
                    axios.get(`${API}/admin/tipos-cuenta-bancaria`, this.getAuthConfig()),
                    axios.get(`${API}/documentos-identidad`, this.getAuthConfig()),
                    axios.get(`${API}/consultores/principales`, this.getAuthConfig())
                ]);

                this.cat.roles = resRoles.data || [];
                this.cat.bancos = resBancos.data || [];
                this.cat.tiposCuenta = resTiposCuenta.data || [];
                this.cat.tiposDocumento = resDocs.data || [];
                this.cat.principales = resPrincipales.data || [];
            } catch (e) {
                this.cat.roles = [];
                this.cat.bancos = [];
                this.cat.tiposCuenta = [];
                this.cat.tiposDocumento = [];
                this.cat.principales = [];
            }
        },

        abrirEdicion(seccion) {
            this.cerrarTodosLosDrafts();
            this.editando[seccion] = true;

            if (seccion === "identidad") {
                this.draft.identidad = {
                    nombre_usuario: this.ficha?.nombre_usuario || "",
                    email: this.ficha?.email || "",
                    rol_id: this.ficha?.rol_id || "",
                    activo: Boolean(this.ficha?.activo),
                    azure_oid: this.ficha?.azure_oid || ""
                };
                return;
            }

            if (seccion === "personal") {
                this.draft.personal = {
                    tipo_documento_id: this.ficha?.tipo_documento_id || "",
                    cedula: this.ficha?.cedula || "",
                    telefono: this.ficha?.telefono || "",
                    direccion: this.ficha?.direccion || "",
                    ciudad: this.ficha?.ciudad || "",
                    tipo_persona: this.ficha?.tipo_persona || ""
                };
                return;
            }

            if (seccion === "cobro") {
                this.draft.cobro = {
                    moneda_cobro: this.ficha?.moneda_cobro || "COP",
                    banco_id: this.ficha?.banco_id || "",
                    tipo_cuenta_id: this.ficha?.tipo_cuenta_id || "",
                    nro_cuenta_bancaria: this.ficha?.nro_cuenta_bancaria || ""
                };
                return;
            }

            if (seccion === "operativa") {
                this.draft.operativa = {
                    tipo_consultor: this.ficha?.tipo_consultor || "",
                    consultor_principal_id: this.ficha?.consultor_principal_id || ""
                };
            }
        },

        cancelarEdicion(seccion) {
            this.editando[seccion] = false;
            this.errores[seccion] = null;
        },

        async guardar(seccion) {
            this.guardando[seccion] = true;
            this.errores[seccion] = null;
            const payload = { ...this.draft[seccion] };

            Object.keys(payload).forEach((k) => {
                if (payload[k] === "") payload[k] = null;
            });

            try {
                await axios.put(
                    `${API}/admin/personas/${this.ficha.id}/${seccion}`,
                    payload,
                    this.getAuthConfig()
                );

                const res = await axios.get(`${API}/admin/personas/${this.ficha.id}`, this.getAuthConfig());
                this.ficha = res.data;

                const idx = this.personas.findIndex((p) => p.id === this.ficha.id);
                if (idx !== -1) {
                    this.personas[idx] = {
                        ...this.personas[idx],
                        nombre_usuario: this.ficha.nombre_usuario,
                        email: this.ficha.email,
                        activo: this.ficha.activo,
                        rol: this.ficha.rol,
                        tipo_consultor: this.ficha.tipo_consultor,
                        ciudad: this.ficha.ciudad,
                        tiene_datos_bancarios: !!this.ficha.nro_cuenta_bancaria,
                        tiene_documento: !!this.ficha.cedula
                    };
                }

                this.editando[seccion] = false;
            } catch (err) {
                this.errores[seccion] = err?.response?.data?.error || "Error al guardar";
            } finally {
                this.guardando[seccion] = false;
            }
        },

        inicialAvatar(nombre) {
            return String(nombre || "?").charAt(0).toUpperCase();
        },

        colorAvatar(rol) {
            const mapa = {
                Administrador: "bg-indigo-600",
                Coordinador: "bg-purple-500",
                Consultor: "bg-emerald-500",
                Reclutador: "bg-amber-500",
                Comercial: "bg-sky-500",
                "Talento Humano": "bg-rose-500"
            };
            return mapa[rol] || "bg-slate-400";
        },

        formatFechaHora(ts) {
            if (!ts) return "-";
            try {
                return new Date(ts).toLocaleString("es-CO", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit"
                });
            } catch {
                return "-";
            }
        }
    };
};
