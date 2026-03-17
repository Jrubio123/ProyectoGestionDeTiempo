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
            tieneAzure: false
        },

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

        abrirConfirmacion(usuario) {
            this.modal = {
                open: true,
                publicId: usuario.id,
                nombre: usuario.nombre_usuario,
                activar: !usuario.activo,
                tieneAzure: !!usuario.azure_oid
            };
        },

        async confirmar() {
            if (!this.modal.publicId) return;

            const { publicId, activar } = this.modal;
            this.modal.open = false;
            this.procesando = publicId;

            try {
                const token = window.auth?.getToken?.() || localStorage.getItem("token");
                const res = await axios.patch(
                    `${API}/admin/usuarios-licencias/${publicId}/estado`,
                    { activo: activar },
                    { headers: { Authorization: `Bearer ${token}` } }
                );

                const usuario = this.usuarios.find((u) => u.id === publicId);
                if (usuario) usuario.activo = activar;

                if (res.status === 207) {
                    alert(`⚠️ ${res.data?.warning || "Se actualizó la BD pero hubo un problema con Entra ID."}`);
                }
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al actualizar el usuario";
                alert(`Error: ${msg}`);
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
