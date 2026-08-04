// js/solicitudes-coord.js
window.solicitudesCoordApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        misSolicitudes: [],
        clientes: [],
        modulos: [],
        modalNueva: false,
        touched: false,
        enviando: false,
        form: {
            cliente_id: "",
            cliente_nombre_otro: "",
            modulo_id: "",
            perfil: "",
            nivel: "Junior",
            tiempo: "",
            ubicacion: "Remoto",
            modalidad: "Full time",
            fecha_inicio_esperada: "",
            tipo_proyecto: "",
            experiencia: "",
            presupuesto_min: "",
            presupuesto_max: "",
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
                cliente_nombre_otro: "",
                modulo_id: "",
                perfil: "",
                nivel: "Junior",
                tiempo: "",
                ubicacion: "Remoto",
                modalidad: "Full time",
                fecha_inicio_esperada: "",
                tipo_proyecto: "",
                experiencia: "",
                presupuesto_min: "",
                presupuesto_max: "",
                descripcion: "",
                informacion_adicional: "",
                prioridad: "Media"
            };
            this.touched = false;
        },

        getNombreModuloSeleccionado() {
            const modulo = this.modulos.find((m) => String(m.id) === String(this.form.modulo_id));
            return String(modulo?.titulo || "").trim();
        },

        async enviarSolicitud() {
            if (this.enviando) return;
            this.touched = true;
            if (!this.formValido) {
                alert("Faltan campos obligatorios por completar.");
                return;
            }

            const esOtros = this.form.modulo_id === "__otros__";
            const perfilIngresado = String(this.form.perfil || "").trim();
            const perfil = esOtros
                ? perfilIngresado
                : (perfilIngresado || this.getNombreModuloSeleccionado());
            const min = Number(this.form.presupuesto_min);
            const max = Number(this.form.presupuesto_max);
            let presupuesto = null;
            if (min > 0 && max > 0) {
                presupuesto = `${min.toLocaleString("es-CO")} - ${max.toLocaleString("es-CO")}`;
            } else if (min > 0) {
                presupuesto = `${min.toLocaleString("es-CO")}`;
            } else if (max > 0) {
                presupuesto = `${max.toLocaleString("es-CO")}`;
            }

            const esProspecto = this.form.cliente_id === "__prospecto__";
            const payload = {
                cliente_id: esProspecto ? null : (this.form.cliente_id || null),
                cliente_nombre_otro: esProspecto ? String(this.form.cliente_nombre_otro || "").trim() || null : null,
                modulo_id: this.form.modulo_id && !esOtros ? this.form.modulo_id : null,
                perfil,
                nivel: this.form.nivel,
                tiempo: this.form.tiempo,
                ubicacion: this.form.ubicacion,
                modalidad: this.form.modalidad,
                fecha_inicio_esperada: this.form.fecha_inicio_esperada || null,
                tipo_proyecto: this.form.tipo_proyecto,
                experiencia: this.form.experiencia,
                presupuesto,
                descripcion: this.form.descripcion,
                informacion_adicional: this.form.informacion_adicional,
                prioridad: this.form.prioridad || "Media"
            };
            this.enviando = true;
            try {
                await axios.post(`${API}/rrhh/solicitudes`, payload, this.getAuthConfig());
                this.modalNueva = false;
                this.resetForm();
                await this.cargarSolicitudes();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al enviar solicitud";
                alert(msg);
            } finally {
                this.enviando = false;
            }
        },

        get camposFaltantes() {
            const faltan = [];
            const esOtros = this.form.modulo_id === "__otros__";
            const esProspecto = this.form.cliente_id === "__prospecto__";
            const perfil = String(this.form.perfil || "").trim();
            if (!this.form.cliente_id) faltan.push("Cliente");
            if (esProspecto && !String(this.form.cliente_nombre_otro || "").trim()) faltan.push("Nombre del cliente prospecto");
            if (!this.form.modulo_id) faltan.push("Tecnología / Módulo");
            if (esOtros && !perfil) faltan.push("Perfil (requerido al elegir Otros)");
            if (!this.form.nivel) faltan.push("Nivel");
            if (!this.form.tiempo) faltan.push("Tiempo");
            if (!this.form.ubicacion) faltan.push("Ubicación");
            if (!this.form.modalidad) faltan.push("Modalidad");
            if (!this.form.presupuesto_min && !this.form.presupuesto_max) faltan.push("Presupuesto");
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
