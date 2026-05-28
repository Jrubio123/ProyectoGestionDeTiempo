window.tempCrearUsuariosApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const tempHeaders = { "x-temp-key": "TEMP_CREATE_USER_2026" };

    return {
        cargando: false,
        buscando: false,
        guardando: false,
        usuarioExiste: false,
        error: "",
        ok: "",
        catalogos: {
            roles: [],
            bancos: [],
            tipoCuenta: [],
            documentos: [],
            tenantUsuarios: []
        },
        usuarioSeleccionado: "",
        form: {
            azure_oid: "",
            nombre_usuario: "",
            email: "",
            rol_usuario_id: "",
            tipo_documento_id: "",
            banco_id: "",
            tipo_cuenta_id: "",
            nro_cuenta_bancaria: "",
            tipo_persona: "",
            tipo_consultor_enum: "",
            ciudad: "",
            telefono: "",
            cedula: "",
            direccion: ""
        },

        async init() {
            await this.cargarCatalogos();
        },

        async cargarCatalogos() {
            this.cargando = true;
            this.error = "";
            try {
                const [roles, bancos, tipoCuenta, documentos] = await Promise.all([
                    axios.get(`${API}/temp/catalogos/roles`, { headers: tempHeaders }),
                    axios.get(`${API}/temp/catalogos/bancos`, { headers: tempHeaders }),
                    axios.get(`${API}/temp/catalogos/tipo-cuenta`, { headers: tempHeaders }),
                    axios.get(`${API}/temp/catalogos/documentos`, { headers: tempHeaders })
                ]);

                this.catalogos.roles = roles.data || [];
                this.catalogos.bancos = bancos.data || [];
                this.catalogos.tipoCuenta = tipoCuenta.data || [];
                this.catalogos.documentos = documentos.data || [];
                await this.cargarUsuariosTenant();
            } catch (e) {
                this.error = e.response?.data?.error || "Error cargando catalogos";
            } finally {
                this.cargando = false;
            }
        },

        limpiar() {
            this.form = {
                azure_oid: "",
                nombre_usuario: "",
                email: "",
                rol_usuario_id: "",
                tipo_documento_id: "",
                banco_id: "",
                tipo_cuenta_id: "",
                nro_cuenta_bancaria: "",
                tipo_persona: "",
                tipo_consultor_enum: "",
                ciudad: "",
                telefono: "",
                cedula: "",
                direccion: ""
            };
            this.usuarioExiste = false;
            this.usuarioSeleccionado = "";
            this.error = "";
            this.ok = "";
        },

        payload() {
            return Object.fromEntries(
                Object.entries(this.form).filter(([, value]) => String(value ?? "").trim() !== "")
            );
        },

        mapSelectId(value) {
            return value === null || value === undefined ? "" : String(value);
        },

        mapTipoPersona(value) {
            const raw = String(value || "");
            return raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === "juridica"
                ? "Juridica"
                : raw;
        },

        async buscarUsuarioPorEmail() {
            const email = this.form.email.trim();
            if (!email) return;
            const tenantData = {
                email: this.form.email,
                azure_oid: this.form.azure_oid,
                nombre_usuario: this.form.nombre_usuario,
                telefono: this.form.telefono
            };

            this.buscando = true;
            this.error = "";
            this.ok = "";
            try {
                const res = await axios.get(`${API}/temp/usuario`, {
                    params: {
                        email,
                        azure_oid: tenantData.azure_oid || undefined
                    },
                    headers: tempHeaders
                });

                if (!res.data?.exists) {
                    this.limpiar();
                    this.form.email = tenantData.email;
                    this.form.azure_oid = tenantData.azure_oid;
                    this.form.nombre_usuario = tenantData.nombre_usuario;
                    this.form.telefono = tenantData.telefono;
                    this.ok = "Correo disponible para crear usuario";
                    return;
                }

                const u = res.data.usuario || {};
                this.usuarioExiste = true;
                this.form = {
                    azure_oid: u.azure_oid || tenantData.azure_oid || "",
                    nombre_usuario: u.nombre_usuario || tenantData.nombre_usuario || "",
                    email: tenantData.email || u.email || email,
                    rol_usuario_id: this.mapSelectId(u.rol_usuario_id),
                    tipo_documento_id: this.mapSelectId(u.tipo_documento_id),
                    banco_id: this.mapSelectId(u.banco_id),
                    tipo_cuenta_id: this.mapSelectId(u.tipo_cuenta_id),
                    nro_cuenta_bancaria: u.nro_cuenta_bancaria || "",
                    tipo_persona: this.mapTipoPersona(u.tipo_persona),
                    tipo_consultor_enum: u.tipo_consultor_enum || "",
                    ciudad: u.ciudad || "",
                    telefono: u.telefono || tenantData.telefono || "",
                    cedula: u.cedula || "",
                    direccion: u.direccion || ""
                };
                this.ok = "Usuario encontrado. Puedes editar la informacion.";
            } catch (e) {
                this.error = e.response?.data?.error || "Error buscando usuario";
            } finally {
                this.buscando = false;
            }
        },

        async cargarUsuariosTenant(q = "") {
            const query = String(q || "").trim();
            const res = await axios.get(`${API}/temp/tenant/usuarios`, {
                params: query.length >= 2 ? { q: query } : {},
                headers: tempHeaders
            });
            this.catalogos.tenantUsuarios = res.data || [];
        },

        async buscarUsuariosTenant() {
            await this.cargarUsuariosTenant(this.usuarioSeleccionado || this.form.email);
        },

        async cargarUsuarioSeleccionado() {
            const q = this.usuarioSeleccionado.trim().toLowerCase();
            if (!q) return;

            const usuario = this.catalogos.tenantUsuarios.find((u) => {
                const label = `${u.nombre_usuario || ""} - ${u.email || ""}`.toLowerCase();
                const email = String(u.email || "").toLowerCase();
                return label === q || email === q;
            });

            if (!usuario?.email) {
                this.error = "Selecciona un usuario valido de la lista";
                return;
            }

            this.form.email = usuario.email;
            this.form.azure_oid = usuario.azure_oid || "";
            this.form.nombre_usuario = usuario.nombre_usuario || "";
            this.form.telefono = usuario.telefono || "";
            await this.buscarUsuarioPorEmail();
        },

        async cargarDesdeEmailTenant() {
            const q = this.form.email.trim().toLowerCase();
            let usuario = this.catalogos.tenantUsuarios.find(
                (u) => String(u.email || "").toLowerCase() === q
            );
            if (!usuario && q.length >= 2) {
                await this.cargarUsuariosTenant(q);
                usuario = this.catalogos.tenantUsuarios.find(
                    (u) => String(u.email || "").toLowerCase() === q
                );
            }
            if (usuario) {
                this.form.azure_oid = usuario.azure_oid || this.form.azure_oid;
                this.form.nombre_usuario = usuario.nombre_usuario || this.form.nombre_usuario;
                this.form.telefono = usuario.telefono || this.form.telefono;
            }
            await this.buscarUsuarioPorEmail();
        },

        async crearUsuario() {
            this.error = "";
            this.ok = "";

            if (!this.form.nombre_usuario.trim()) {
                this.error = "nombre_usuario es obligatorio";
                return;
            }
            if (!this.form.email.trim()) {
                this.error = "email es obligatorio";
                return;
            }

            this.guardando = true;
            try {
                const res = await axios.post(`${API}/temp/crear-usuario`, this.payload(), { headers: tempHeaders });
                const message = res.data?.updated ? "Usuario actualizado correctamente" : "Usuario creado correctamente";
                this.limpiar();
                this.ok = message;
                await this.cargarUsuariosTenant();
            } catch (e) {
                this.error = e.response?.data?.error || "Error al crear usuario";
            } finally {
                this.guardando = false;
            }
        }
    };
};
