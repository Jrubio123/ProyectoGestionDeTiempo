window.catalogosAdminApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        tabActiva: "modulos",
        cargando: false,

        modulos: [],
        roles: [],
        bancos: [],
        usuarios: [],

        filtroUsuario: "",

        formModulo: {
            id: null,
            titulo: "",
            nombre_completo: "",
            descripcion: "",
            activo: true
        },
        formRol: {
            id: null,
            titulo: "",
            descripcion: "",
            activo: true
        },
        formBanco: {
            id: null,
            titulo: "",
            codigo_bancolombia: "",
            codigo_conversor: "",
            activo: true
        },

        async init() {
            await this.recargarTodo();
        },

        async recargarTodo() {
            this.cargando = true;
            try {
                await Promise.all([
                    this.cargarModulos(),
                    this.cargarRoles(),
                    this.cargarBancos(),
                    this.cargarUsuariosRoles()
                ]);
            } finally {
                this.cargando = false;
            }
        },

        async cargarModulos() {
            try {
                const res = await axios.get(`${API}/admin/modulos`);
                this.modulos = res.data || [];
            } catch (e) {
                this.modulos = [];
            }
        },

        async cargarRoles() {
            try {
                const res = await axios.get(`${API}/admin/roles`);
                this.roles = res.data || [];
            } catch (e) {
                this.roles = [];
            }
        },

        async cargarBancos() {
            try {
                const res = await axios.get(`${API}/admin/bancos`);
                this.bancos = res.data || [];
            } catch (e) {
                this.bancos = [];
            }
        },

        async cargarUsuariosRoles() {
            try {
                const res = await axios.get(`${API}/admin/usuarios-roles`);
                this.usuarios = (res.data || []).map((u) => ({
                    ...u,
                    rol_id_edit: u.rol_id || ""
                }));
            } catch (e) {
                this.usuarios = [];
            }
        },

        setTab(tab) {
            this.tabActiva = tab;
        },

        resetFormModulo() {
            this.formModulo = {
                id: null,
                titulo: "",
                nombre_completo: "",
                descripcion: "",
                activo: true
            };
        },

        editarModulo(item) {
            this.formModulo = {
                id: item.id,
                titulo: item.titulo || "",
                nombre_completo: item.nombre_completo || "",
                descripcion: item.descripcion || "",
                activo: item.activo !== false
            };
        },

        async guardarModulo() {
            try {
                if (!String(this.formModulo.titulo || "").trim()) {
                    alert("El título del módulo es obligatorio.");
                    return;
                }
                if (this.formModulo.id) {
                    await axios.put(`${API}/admin/modulos/${this.formModulo.id}`, this.formModulo);
                } else {
                    await axios.post(`${API}/admin/modulos`, this.formModulo);
                }
                this.resetFormModulo();
                await this.cargarModulos();
            } catch (e) {
                alert(e?.response?.data?.error || "Error guardando módulo");
            }
        },

        async eliminarModulo(item) {
            if (!item?.id) return;
            if (!confirm(`¿Eliminar módulo "${item.titulo}"?`)) return;
            try {
                await axios.delete(`${API}/admin/modulos/${item.id}`);
                await this.cargarModulos();
            } catch (e) {
                alert(e?.response?.data?.error || "Error eliminando módulo");
            }
        },

        resetFormRol() {
            this.formRol = {
                id: null,
                titulo: "",
                descripcion: "",
                activo: true
            };
        },

        editarRol(item) {
            this.formRol = {
                id: item.id,
                titulo: item.titulo || "",
                descripcion: item.descripcion || "",
                activo: item.activo !== false
            };
        },

        async guardarRol() {
            try {
                if (!String(this.formRol.titulo || "").trim()) {
                    alert("El título del rol es obligatorio.");
                    return;
                }
                if (this.formRol.id) {
                    await axios.put(`${API}/admin/roles/${this.formRol.id}`, this.formRol);
                } else {
                    await axios.post(`${API}/admin/roles`, this.formRol);
                }
                this.resetFormRol();
                await Promise.all([this.cargarRoles(), this.cargarUsuariosRoles()]);
            } catch (e) {
                alert(e?.response?.data?.error || "Error guardando rol");
            }
        },

        async eliminarRol(item) {
            if (!item?.id) return;
            if (!confirm(`¿Eliminar rol "${item.titulo}"?`)) return;
            try {
                await axios.delete(`${API}/admin/roles/${item.id}`);
                await Promise.all([this.cargarRoles(), this.cargarUsuariosRoles()]);
            } catch (e) {
                alert(e?.response?.data?.error || "Error eliminando rol");
            }
        },

        resetFormBanco() {
            this.formBanco = {
                id: null,
                titulo: "",
                codigo_bancolombia: "",
                codigo_conversor: "",
                activo: true
            };
        },

        editarBanco(item) {
            this.formBanco = {
                id: item.id,
                titulo: item.titulo || "",
                codigo_bancolombia: item.codigo_bancolombia || "",
                codigo_conversor: item.codigo_conversor || "",
                activo: item.activo !== false
            };
        },

        async guardarBanco() {
            try {
                if (!String(this.formBanco.titulo || "").trim()) {
                    alert("El nombre del banco es obligatorio.");
                    return;
                }
                if (this.formBanco.id) {
                    await axios.put(`${API}/admin/bancos/${this.formBanco.id}`, this.formBanco);
                } else {
                    await axios.post(`${API}/admin/bancos`, this.formBanco);
                }
                this.resetFormBanco();
                await this.cargarBancos();
            } catch (e) {
                alert(e?.response?.data?.error || "Error guardando banco");
            }
        },

        async eliminarBanco(item) {
            if (!item?.id) return;
            if (!confirm(`¿Eliminar banco "${item.titulo}"?`)) return;
            try {
                await axios.delete(`${API}/admin/bancos/${item.id}`);
                await this.cargarBancos();
            } catch (e) {
                alert(e?.response?.data?.error || "Error eliminando banco");
            }
        },

        get usuariosFiltrados() {
            const q = String(this.filtroUsuario || "").toLowerCase().trim();
            if (!q) return this.usuarios;
            return this.usuarios.filter((u) => {
                const nombre = String(u.nombre_usuario || "").toLowerCase();
                const email = String(u.email || "").toLowerCase();
                const rol = String(u.rol || "").toLowerCase();
                return nombre.includes(q) || email.includes(q) || rol.includes(q);
            });
        },

        async guardarRolUsuario(user) {
            if (!user?.id || !user?.rol_id_edit) {
                alert("Selecciona un rol.");
                return;
            }
            try {
                await axios.put(`${API}/admin/usuarios/${user.id}/rol`, {
                    rol_id: user.rol_id_edit
                });
                await this.cargarUsuariosRoles();
            } catch (e) {
                alert(e?.response?.data?.error || "Error actualizando rol de usuario");
            }
        }
    };
};
