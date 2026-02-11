// js/solicitudes-coord.js
window.solicitudesCoordApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        misSolicitudes: [],
        clientes: [],
        modulos: [],
        modalNueva: false,
        touched: false,
        form: {
            cliente_id: "",
            modulo_id: "",
            perfil: "",
            nivel: "Junior",
            tiempo: "",
            ubicacion: "Remoto",
            modalidad: "Full time",
            fecha_inicio_esperada: "",
            tipo_proyecto: "",
            experiencia: "",
            presupuesto: "",
            descripcion: "",
            informacion_adicional: "",
            prioridad: "Media"
        },

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async init() {
            await Promise.all([this.cargarCatalogos(), this.cargarSolicitudes()]);
        },

        async cargarCatalogos() {
            try {
                const [resClientes, resModulos] = await Promise.all([
                    axios.get(`${API}/clientes`, this.getAuthConfig()),
                    axios.get(`${API}/modulos`, this.getAuthConfig())
                ]);
                this.clientes = resClientes.data || [];
                this.modulos = resModulos.data || [];
            } catch (e) {
                this.clientes = [];
                this.modulos = [];
            }
        },

        async cargarSolicitudes() {
            try {
                const res = await axios.get(`${API}/rrhh/solicitudes`, this.getAuthConfig());
                this.misSolicitudes = res.data || [];
            } catch (e) {
                this.misSolicitudes = [];
            }
        },

        resetForm() {
            this.form = {
                cliente_id: "",
                modulo_id: "",
                perfil: "",
                nivel: "Junior",
                tiempo: "",
                ubicacion: "Remoto",
                modalidad: "Full time",
                fecha_inicio_esperada: "",
                tipo_proyecto: "",
                experiencia: "",
                presupuesto: "",
                descripcion: "",
                informacion_adicional: "",
                prioridad: "Media"
            };
            this.touched = false;
        },

        async enviarSolicitud() {
            this.touched = true;
            if (!this.formValido) {
                alert("Faltan campos obligatorios por completar.");
                return;
            }
            const payload = {
                cliente_id: this.form.cliente_id,
                modulo_id: this.form.modulo_id,
                perfil: this.form.perfil,
                nivel: this.form.nivel,
                tiempo: this.form.tiempo,
                ubicacion: this.form.ubicacion,
                modalidad: this.form.modalidad,
                fecha_inicio_esperada: this.form.fecha_inicio_esperada || null,
                tipo_proyecto: this.form.tipo_proyecto,
                experiencia: this.form.experiencia,
                presupuesto: this.form.presupuesto,
                descripcion: this.form.descripcion,
                informacion_adicional: this.form.informacion_adicional,
                prioridad: this.form.prioridad || "Media"
            };
            try {
                await axios.post(`${API}/rrhh/solicitudes`, payload, this.getAuthConfig());
                this.modalNueva = false;
                this.resetForm();
                await this.cargarSolicitudes();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al enviar solicitud";
                alert(msg);
            }
        },

        get camposFaltantes() {
            const faltan = [];
            if (!this.form.cliente_id) faltan.push("Cliente");
            if (!this.form.modulo_id) faltan.push("Módulo");
            if (!this.form.perfil) faltan.push("Perfil");
            if (!this.form.nivel) faltan.push("Nivel");
            if (!this.form.tiempo) faltan.push("Tiempo");
            if (!this.form.ubicacion) faltan.push("Ubicación");
            if (!this.form.modalidad) faltan.push("Modalidad");
            if (!this.form.presupuesto) faltan.push("Presupuesto");
            if (!this.form.descripcion) faltan.push("Descripción");
            if (!this.form.prioridad) faltan.push("Prioridad");
            return faltan;
        },

        get formValido() {
            return this.camposFaltantes.length === 0;
        },

        formatDate(d) {
            return d ? String(d).split("T")[0] : "";
        }
    };
};
