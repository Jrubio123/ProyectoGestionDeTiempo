// js/gestion-consultores.js
window.gestionConsultoresApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        puedeEditar: false,
        puedeAgregar: false,
        puedeCambiarEstado: false,
        cargando: false,
        cargandoFicha: false,
        modalAddConsultorOpen: false,
        guardandoAdd: false,
        buscando: false,
        buscandoExistente: false,
        addError: "",
        consultorExistente: null,
        tenantUsuarios: [],
        usuarioSeleccionado: "",
        addForm: {
            azure_oid: "",
            nombre: "",
            apellidos: "",
            email: "",
            tipo_documento_id: "",
            numero_documento: "",
            telefono: "",
            ciudad: "",
            direccion: "",
            nro_cuenta_bancaria: "",
            banco_id: "",
            tipo_cuenta_id: "",
            tipo_consultor: "",
            id_consultor_principal: "",
            moneda_cobro: "COP",
            factura_en_colombia: "",
            tipo_persona: ""
        },

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
            this.puedeEditar = roleKey === "admin" || roleKey === "talento_humano" || roleKey === "coordinador";
            this.puedeAgregar = ["admin", "talento_humano", "coordinador", "comercial"].includes(roleKey);
            this.puedeCambiarEstado = roleKey === "admin";

            await Promise.all([
                this.cargarPersonas(),
                this.puedeEditar ? this.cargarCatalogos() : this.puedeAgregar ? this.cargarCatalogosAgregar() : Promise.resolve()
            ]);
        },

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async cargarPersonas() {
            this.cargando = true;
            try {
                const res = await axios.get(`${API}/admin/consultores`, this.getAuthConfig());
                this.personas = res.data || [];
            } catch (e) {
                this.personas = [];
            } finally {
                this.cargando = false;
            }
        },

        resetAddForm() {
            this.addForm = {
                azure_oid: "",
                nombre: "",
                apellidos: "",
                email: "",
                tipo_documento_id: "",
                numero_documento: "",
                telefono: "",
                ciudad: "",
                direccion: "",
                nro_cuenta_bancaria: "",
                banco_id: "",
                tipo_cuenta_id: "",
                tipo_consultor: "",
                id_consultor_principal: "",
                moneda_cobro: "COP",
                factura_en_colombia: "",
                tipo_persona: ""
            };
            this.usuarioSeleccionado = "";
            this.consultorExistente = null;
            this.addError = "";
        },

        abrirModalAgregar() {
            this.resetAddForm();
            this.modalAddConsultorOpen = true;
            this.cargarUsuariosTenant();
        },

        cerrarModalAgregar() {
            if (this.guardandoAdd) return;
            this.modalAddConsultorOpen = false;
            this.addError = "";
        },

        async cargarUsuariosTenant(q = "") {
            const query = String(q || "").trim();
            this.buscando = true;
            try {
                const cfg = this.getAuthConfig() || {};
                const res = await axios.get(`${API}/admin/tenant/usuarios`, {
                    ...cfg,
                    params: query.length >= 2 ? { q: query } : {}
                });
                this.tenantUsuarios = res.data || [];
            } catch (e) {
                this.tenantUsuarios = [];
            } finally {
                this.buscando = false;
            }
        },

        async buscarUsuariosTenant() {
            await this.cargarUsuariosTenant(this.usuarioSeleccionado || this.addForm.email);
        },

        async aplicarUsuarioTenant(usuario) {
            if (!usuario) return;
            const nombreCompleto = String(usuario.nombre_usuario || "").trim();
            const partes = nombreCompleto.split(/\s+/).filter(Boolean);
            const nombreFallback = partes.shift() || "";
            const apellidosFallback = partes.join(" ");

            this.addForm.email = usuario.email || this.addForm.email;
            this.addForm.azure_oid = usuario.azure_oid || "";
            this.addForm.nombre = String(usuario.nombre || "").trim() || nombreFallback || this.addForm.nombre;
            this.addForm.apellidos = String(usuario.apellidos || "").trim() || apellidosFallback || this.addForm.apellidos;
            this.usuarioSeleccionado = `${usuario.nombre_usuario || ""} - ${usuario.email || ""}`;
            this.addError = "";
            await this.buscarConsultorExistente();
        },

        async cargarUsuarioSeleccionado() {
            const q = this.usuarioSeleccionado.trim().toLowerCase();
            if (!q) return;

            const usuario = this.tenantUsuarios.find((u) => {
                const label = `${u.nombre_usuario || ""} - ${u.email || ""}`.toLowerCase();
                const email = String(u.email || "").toLowerCase();
                return label === q || email === q;
            });

            if (!usuario?.email) {
                this.addError = "Selecciona un usuario valido de la lista";
                return;
            }

            await this.aplicarUsuarioTenant(usuario);
        },

        async cargarDesdeEmailTenant() {
            const q = this.addForm.email.trim().toLowerCase();
            if (!q) return;

            let usuario = this.tenantUsuarios.find(
                (u) => String(u.email || "").toLowerCase() === q
            );
            if (!usuario && q.length >= 2) {
                await this.cargarUsuariosTenant(q);
                usuario = this.tenantUsuarios.find(
                    (u) => String(u.email || "").toLowerCase() === q
                );
            }
            if (usuario) {
                await this.aplicarUsuarioTenant(usuario);
            } else {
                await this.buscarConsultorExistente();
            }
        },

        async buscarConsultorExistente() {
            const params = {};
            if (this.addForm.email) params.email = this.addForm.email;
            if (this.addForm.numero_documento) params.numero_documento = this.addForm.numero_documento;
            if (this.addForm.azure_oid) params.azure_oid = this.addForm.azure_oid;
            if (!Object.keys(params).length) return;

            this.buscandoExistente = true;
            this.consultorExistente = null;
            try {
                const res = await axios.get(`${API}/admin/consultores/existente`, {
                    ...this.getAuthConfig(),
                    params
                });
                this.aplicarConsultorExistente(res.data);
            } catch (err) {
                if (err?.response?.status !== 404) {
                    this.addError = err?.response?.data?.error || "Error al buscar informacion existente";
                }
                if (err?.response?.status === 404) this.consultorExistente = null;
            } finally {
                this.buscandoExistente = false;
            }
        },

        aplicarConsultorExistente(data) {
            if (!data?.id) return;
            const nombreCompleto = String(data.nombre_usuario || "").trim();
            const partes = nombreCompleto.split(/\s+/).filter(Boolean);
            const nombreFallback = partes.shift() || "";
            const apellidosFallback = partes.join(" ");

            this.consultorExistente = data;
            this.addForm.azure_oid = data.azure_oid || this.addForm.azure_oid;
            this.addForm.nombre = data.nombre || nombreFallback || this.addForm.nombre;
            this.addForm.apellidos = data.apellidos || apellidosFallback || this.addForm.apellidos;
            this.addForm.email = data.email || this.addForm.email;
            this.addForm.tipo_documento_id = data.tipo_documento_id || this.addForm.tipo_documento_id;
            this.addForm.numero_documento = data.numero_documento || this.addForm.numero_documento;
            this.addForm.telefono = data.telefono || "";
            this.addForm.ciudad = data.ciudad || "";
            this.addForm.direccion = data.direccion || "";
            this.addForm.nro_cuenta_bancaria = data.nro_cuenta_bancaria || "";
            this.addForm.banco_id = data.banco_id || "";
            this.addForm.tipo_cuenta_id = data.tipo_cuenta_id || "";
            this.addForm.tipo_consultor = data.tipo_consultor || "";
            this.addForm.id_consultor_principal = data.id_consultor_principal || "";
            this.addForm.moneda_cobro = data.moneda_cobro || "COP";
            this.addForm.factura_en_colombia =
                data.factura_en_colombia === true ? "true" :
                data.factura_en_colombia === false ? "false" : "";
            this.addForm.tipo_persona = this.valorTipoPersonaForm(data.tipo_persona);
            this.addError = "";
        },

        async crearConsultor() {
            this.guardandoAdd = true;
            this.addError = "";
            try {
                if (this.addForm.tipo_consultor === "Asociado" && !this.addForm.id_consultor_principal) {
                    this.addError = "Un consultor asociado debe tener consultor principal";
                    return;
                }

                if (this.consultorExistente?.id) {
                    await axios.put(`${API}/admin/consultores/${this.consultorExistente.id}`, { ...this.addForm }, this.getAuthConfig());
                } else {
                    await axios.post(`${API}/admin/consultores`, { ...this.addForm }, this.getAuthConfig());
                }

                this.modalAddConsultorOpen = false;
                alert(this.consultorExistente?.id ? "Consultor actualizado correctamente" : "Consultor creado correctamente");
                await this.cargarPersonas();
            } catch (err) {
                this.addError = err?.response?.data?.error || "Error al guardar consultor";
            } finally {
                this.guardandoAdd = false;
            }
        },

        async cargarCatalogosAgregar() {
            try {
                const [resBancos, resTiposCuenta, resDocs, resPrincipales] = await Promise.all([
                    axios.get(`${API}/bancos`, this.getAuthConfig()),
                    axios.get(`${API}/tipos-cuenta-bancaria`, this.getAuthConfig()),
                    axios.get(`${API}/documentos-identidad`, this.getAuthConfig()),
                    axios.get(`${API}/consultores/principales`, this.getAuthConfig())
                ]);

                this.cat.bancos = resBancos.data || [];
                this.cat.tiposCuenta = resTiposCuenta.data || [];
                this.cat.tiposDocumento = resDocs.data || [];
                this.cat.principales = resPrincipales.data || [];
            } catch (e) {
                this.cat.bancos = [];
                this.cat.tiposCuenta = [];
                this.cat.tiposDocumento = [];
                this.cat.principales = [];
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
                const res = await axios.get(`${API}/admin/consultores/${persona.id}`, this.getAuthConfig());
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

        async cargarTiposDocumento() {
            try {
                const resDocs = await axios.get(`${API}/documentos-identidad`, this.getAuthConfig());
                this.cat.tiposDocumento = resDocs.data || [];
            } catch (e) {
                this.cat.tiposDocumento = [];
            }
        },

        abrirEdicion(seccion) {
            this.cerrarTodosLosDrafts();
            this.editando[seccion] = true;

            if (seccion === "identidad") {
                const identidad = {
                    nombre_usuario: this.ficha?.nombre_usuario || "",
                    email: this.ficha?.email || "",
                    rol_id: this.ficha?.rol_id || "",
                    azure_oid: this.ficha?.azure_oid || ""
                };
                if (this.puedeCambiarEstado) identidad.activo = Boolean(this.ficha?.activo);
                this.draft.identidad = identidad;
                return;
            }

            if (seccion === "personal") {
                this.draft.personal = {
                    tipo_documento_id: this.ficha?.tipo_documento_id || "",
                    cedula: this.ficha?.cedula || "",
                    telefono: this.ficha?.telefono || "",
                    direccion: this.ficha?.direccion || "",
                    ciudad: this.ficha?.ciudad || "",
                    tipo_persona: this.valorTipoPersonaForm(this.ficha?.tipo_persona)
                };
                return;
            }

            if (seccion === "cobro") {
                this.draft.cobro = {
                    moneda_cobro: this.ficha?.moneda_cobro || "COP",
                    banco_id: this.ficha?.banco_id || "",
                    tipo_cuenta_id: this.ficha?.tipo_cuenta_id || "",
                    nro_cuenta_bancaria: this.ficha?.nro_cuenta_bancaria || "",
                    factura_en_colombia:
                        this.ficha?.factura_en_colombia === true ? "true" :
                        this.ficha?.factura_en_colombia === false ? "false" : ""
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
            if (seccion === "identidad" && !this.puedeCambiarEstado) delete payload.activo;

            Object.keys(payload).forEach((k) => {
                if (payload[k] === "") payload[k] = null;
            });

            try {
                await axios.put(
                    `${API}/admin/personas/${this.ficha.id}/${seccion}`,
                    payload,
                    this.getAuthConfig()
                );

                const res = await axios.get(`${API}/admin/consultores/${this.ficha.id}`, this.getAuthConfig());
                this.ficha = res.data;

                const idx = this.personas.findIndex((p) => p.id === this.ficha.id);
                if (idx !== -1) {
                    this.personas[idx] = {
                        ...this.personas[idx],
                        nombre_usuario: this.ficha.nombre_usuario,
                        email: this.ficha.email,
                        activo: this.ficha.activo,
                        rol: this.ficha.rol,
                        ciudad: this.ficha.ciudad
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

        valorTipoPersonaForm(value) {
            const raw = String(value || "").toLowerCase().trim();
            const normalized = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            if (!raw) return "";
            if (raw === "natural") return "Natural";
            if (normalized === "juridica") return "Juridica";
            return value;
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
