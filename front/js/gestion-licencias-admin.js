window.gestionLicenciasApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        usuarios: [],
        cargando: false,
        procesando: null,

        filtroTexto: "",
        filtroEstado: "todos",
        filtroTipo: "todos",

        modal: {
            open: false,
            publicId: null,
            nombre: "",
            activar: false,
            tieneAzure: false,
            manejarLicencias: true,
            licenciasCargando: false,
            licencias: [],
            licenciasError: "",
            totalRemovibles: 0
        },

        resultado: null,

        async init() {
            await this.cargarUsuarios();
        },

        async cargarUsuarios() {
            this.cargando = true;
            try {
                const token = window.auth?.getToken?.() || localStorage.getItem("token");
                const res = await axios.get(`${API}/admin/usuarios-licencias`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                this.usuarios = res.data || [];
            } catch (e) {
                console.error("Error cargando usuarios:", e);
                this.usuarios = [];
            } finally {
                this.cargando = false;
            }
        },

        get usuariosFiltrados() {
            const q = (this.filtroTexto || "").toLowerCase().trim();
            return this.usuarios.filter((u) => {
                if (q) {
                    const nombre = (u.nombre_usuario || "").toLowerCase();
                    const email  = (u.email || "").toLowerCase();
                    const rol    = (u.rol || "").toLowerCase();
                    if (!nombre.includes(q) && !email.includes(q) && !rol.includes(q)) return false;
                }
                if (this.filtroEstado === "activos"   && !u.activo)  return false;
                if (this.filtroEstado === "inactivos"  &&  u.activo)  return false;
                if (this.filtroTipo   === "con-azure"  && !u.azure_oid) return false;
                if (this.filtroTipo   === "sin-azure"  &&  u.azure_oid) return false;
                return true;
            });
        },

        async abrirConfirmacion(usuario) {
            this.resultado = null;
            this.modal = {
                open: true,
                publicId: usuario.id,
                nombre: usuario.nombre_usuario,
                activar: !usuario.activo,
                tieneAzure: !!usuario.azure_oid,
                manejarLicencias: true,
                licenciasCargando: false,
                licencias: [],
                licenciasError: "",
                totalRemovibles: 0
            };

            if (!usuario.activo || !usuario.azure_oid) return;

            this.modal.licenciasCargando = true;
            try {
                const token = window.auth?.getToken?.() || localStorage.getItem("token");
                const res = await axios.get(
                    `${API}/admin/usuarios/${usuario.id}/licencias-actuales`,
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                if (this.modal.publicId !== usuario.id) return;

                this.modal.licencias = res.data?.licencias || [];
                this.modal.totalRemovibles = Number(res.data?.total_removibles || 0);
                this.modal.manejarLicencias = this.modal.totalRemovibles > 0;
            } catch (e) {
                if (this.modal.publicId !== usuario.id) return;
                this.modal.licenciasError = e?.response?.data?.error
                    || "No fue posible consultar las licencias en Microsoft Graph";
                this.modal.manejarLicencias = false;
            } finally {
                if (this.modal.publicId === usuario.id) {
                    this.modal.licenciasCargando = false;
                }
            }
        },

        async confirmar() {
            if (!this.modal.publicId) return;
            if (!this.modal.activar && this.modal.manejarLicencias
                && (this.modal.licenciasCargando || this.modal.licenciasError)) return;

            const { publicId, activar, tieneAzure, manejarLicencias } = this.modal;
            this.modal.open = false;
            this.resultado = null;
            this.procesando = publicId;

            try {
                const token = window.auth?.getToken?.() || localStorage.getItem("token");

                const body = { activo: activar };
                if (tieneAzure && manejarLicencias) {
                    if (!activar) body.liberar_licencias = true;
                    else          body.restaurar_licencias = true;
                }

                const res = await axios.put(
                    `${API}/admin/usuarios/${publicId}/activo`,
                    body,
                    { headers: { Authorization: `Bearer ${token}` } }
                );

                const usuario = this.usuarios.find((u) => u.id === publicId);
                if (usuario) usuario.activo = activar;

                this.resultado = {
                    ok: true,
                    activar,
                    entra: res.data?.entra_sync || null,
                    licencia: res.data?.licencia_sync || null
                };
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al actualizar el usuario";
                this.resultado = { ok: false, error: msg };
                await this.cargarUsuarios();
            } finally {
                this.procesando = null;
            }
        },

        formatDate(dateStr) {
            if (!dateStr) return "Nunca";
            try {
                return new Date(dateStr).toLocaleDateString("es-CO", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric"
                });
            } catch {
                return dateStr;
            }
        }
    };
};
