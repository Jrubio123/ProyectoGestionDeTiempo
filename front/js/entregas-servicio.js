window.entregasServicioApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    const emptyContact = () => ({ nombre: "", cargo: "", telefono: "", email: "" });
    const emptyDetail = () => ({
        nombre_proyecto: "",
        objeto_proyecto: "",
        valor_total: "",
        moneda: "COP",
        forma_pago: "",
        equipo_estimacion: "",
        tarifas_consultoria: "",
        detalle_tarifas: "",
        tiempo_descripcion: "",
        tarifa: "",
        valor_cliente: "",
        tiene_contrato: ""
    });
    const emptyForm = () => ({
        tipo_servicio: "PROYECTO",
        cliente_id: "",
        coordinador_id: "",
        nombre_servicio: "",
        perfil_cliente: "",
        analisis_adaptabilidad: "",
        acuerdos_comerciales: "",
        contacto_id: "",
        contacto_nuevo: emptyContact(),
        consultores_ids: [],
        modulos_ids: [],
        modulos_otros_texto: "",
        propuesta_url: "",
        documentos: [],
        detalle: emptyDetail()
    });

    return {
        tab: "nueva",
        cargando: false,
        guardando: false,
        error: "",
        mensaje: "",
        catalogos: { clientes: [], coordinadores: [], consultores: [], modulos: [] },
        contactos: [],
        entregas: [],
        detalleSeleccionado: null,
        filtro: { q: "", tipo: "", estado: "" },
        busquedaModulo: "",
        busquedaConsultor: "",
        form: emptyForm(),
        clienteNuevo: {
            open: false,
            data: { titulo: "", nit: "", direccion: "", contacto: emptyContact() }
        },
        clienteNuevoPreparado: null,

        get roleKey() {
            return window.auth?.getRoleKey?.() || "other";
        },
        get puedeCrear() {
            return ["admin", "comercial"].includes(this.roleKey);
        },
        get puedeCambiarEstado() {
            return ["admin", "coordinador"].includes(this.roleKey);
        },
        get requierePropuesta() {
            return ["PROYECTO", "MESA_SERVICIO"].includes(this.form.tipo_servicio);
        },
        get modulosOtros() {
            return [...new Set(String(this.form.modulos_otros_texto || "")
                .split(/[,\n;]/)
                .map((item) => item.trim())
                .filter(Boolean))];
        },
        get modulosFiltrados() {
            const query = this.busquedaModulo.trim().toLowerCase();
            if (!query) return this.catalogos.modulos;
            return this.catalogos.modulos.filter((item) => String(item.nombre || "").toLowerCase().includes(query));
        },
        get consultoresFiltrados() {
            const query = this.busquedaConsultor.trim().toLowerCase();
            if (!query) return this.catalogos.consultores;
            return this.catalogos.consultores.filter((item) =>
                `${item.nombre || ""} ${item.email || ""}`.toLowerCase().includes(query)
            );
        },
        get entregasFiltradas() {
            const query = this.filtro.q.trim().toLowerCase();
            return this.entregas.filter((item) => {
                const matchesQuery = !query || `${item.cliente} ${item.nombre_servicio} ${item.coordinador}`.toLowerCase().includes(query);
                const matchesType = !this.filtro.tipo || item.tipo_servicio === this.filtro.tipo;
                const matchesStatus = !this.filtro.estado || item.estado === this.filtro.estado;
                return matchesQuery && matchesType && matchesStatus;
            });
        },
        get clienteActualNombre() {
            if (this.clienteNuevoPreparado) return this.clienteNuevoPreparado.titulo;
            return this.catalogos.clientes.find((item) => item.id === this.form.cliente_id)?.nombre || "";
        },
        get clienteNuevoValido() {
            const item = this.clienteNuevo.data;
            return Boolean(
                item.titulo.trim() &&
                item.nit.trim() &&
                item.direccion.trim() &&
                item.contacto.nombre.trim() &&
                item.contacto.cargo.trim() &&
                item.contacto.telefono.trim()
            );
        },
        get contactoValido() {
            if (this.clienteNuevoPreparado) return true;
            if (this.form.contacto_id) return true;
            const contact = this.form.contacto_nuevo;
            const cargoValido = this.form.tipo_servicio === "OUTSOURCING" || contact.cargo.trim();
            return Boolean(contact.nombre.trim() && contact.telefono.trim() && cargoValido);
        },
        get formularioValido() {
            const base = Boolean(
                (this.form.cliente_id || this.clienteNuevoPreparado) &&
                this.form.coordinador_id &&
                this.form.perfil_cliente &&
                this.form.analisis_adaptabilidad.trim() &&
                this.contactoValido &&
                (this.form.modulos_ids.length || this.modulosOtros.length)
            );
            if (!base) return false;
            if (this.requierePropuesta && !this.form.propuesta_url.trim() && !this.form.documentos.length) return false;
            const detail = this.form.detalle;
            if (this.form.tipo_servicio === "PROYECTO") {
                return Boolean(
                    detail.nombre_proyecto.trim() && detail.objeto_proyecto.trim() &&
                    detail.valor_total !== "" && detail.forma_pago.trim() &&
                    detail.equipo_estimacion.trim() && detail.tarifas_consultoria.trim()
                );
            }
            if (this.form.tipo_servicio === "MESA_SERVICIO") {
                return Boolean(detail.detalle_tarifas.trim() && detail.forma_pago.trim());
            }
            return Boolean(
                this.form.consultores_ids.length && detail.tiempo_descripcion.trim() &&
                detail.tarifa !== "" && detail.valor_cliente !== "" && detail.tiene_contrato !== ""
            );
        },

        async init() {
            if (!this.puedeCrear) this.tab = "historial";
            await Promise.all([this.cargarCatalogos(), this.cargarEntregas()]);
        },
        limpiarAlertas() {
            this.error = "";
            this.mensaje = "";
        },
        async cargarCatalogos() {
            try {
                const response = await axios.get(`${API}/entregas-servicio/catalogos`);
                this.catalogos = response.data;
            } catch (error) {
                this.error = error?.response?.data?.error || "No se pudieron cargar los catálogos.";
            }
        },
        async cargarEntregas() {
            this.cargando = true;
            try {
                const response = await axios.get(`${API}/entregas-servicio`);
                this.entregas = response.data;
            } catch (error) {
                this.error = error?.response?.data?.error || "No se pudieron cargar las entregas.";
            } finally {
                this.cargando = false;
            }
        },
        async cambiarCliente() {
            this.clienteNuevoPreparado = null;
            this.form.contacto_id = "";
            this.form.contacto_nuevo = emptyContact();
            this.contactos = [];
            if (!this.form.cliente_id) return;
            try {
                const response = await axios.get(`${API}/entregas-servicio/clientes/${this.form.cliente_id}/contactos`);
                this.contactos = response.data;
                const principal = this.contactos.find((item) => item.es_contacto_principal);
                this.form.contacto_id = principal?.id || this.contactos[0]?.id || "";
            } catch (error) {
                this.error = error?.response?.data?.error || "No se pudieron cargar los contactos.";
            }
        },
        abrirClienteNuevo() {
            this.clienteNuevo = {
                open: true,
                data: { titulo: "", nit: "", direccion: "", contacto: emptyContact() }
            };
        },
        prepararClienteNuevo() {
            if (!this.clienteNuevoValido) return;
            this.clienteNuevoPreparado = JSON.parse(JSON.stringify(this.clienteNuevo.data));
            this.form.cliente_id = "";
            this.form.contacto_id = "";
            this.contactos = [];
            this.clienteNuevo.open = false;
        },
        cancelarClienteNuevoPreparado() {
            this.clienteNuevoPreparado = null;
        },
        usarContactoNuevo() {
            this.form.contacto_id = "";
            this.form.contacto_nuevo = emptyContact();
        },
        async seleccionarPdf(event) {
            const input = event?.target;
            const file = input?.files?.[0];
            this.form.documentos = [];
            if (!file) return;
            if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
                this.error = "La propuesta debe ser un archivo PDF.";
                input.value = "";
                return;
            }
            if (file.size > 8 * 1024 * 1024) {
                this.error = "La propuesta supera el máximo de 8 MB.";
                input.value = "";
                return;
            }
            try {
                const base64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || ""));
                    reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
                    reader.readAsDataURL(file);
                });
                this.form.documentos = [{ nombre: file.name, base64 }];
                this.error = "";
            } catch (_) {
                this.error = "No se pudo leer el PDF seleccionado.";
            }
        },
        quitarPdf() {
            this.form.documentos = [];
            if (this.$refs?.propuestaPdf) this.$refs.propuestaPdf.value = "";
        },
        async guardarEntrega() {
            if (!this.formularioValido || this.guardando) {
                this.error = "Completa todos los campos obligatorios.";
                return;
            }
            this.guardando = true;
            this.limpiarAlertas();
            try {
                const payload = {
                    ...this.form,
                    cliente_nuevo: this.clienteNuevoPreparado,
                    contacto_nuevo: this.form.contacto_id || this.clienteNuevoPreparado ? null : this.form.contacto_nuevo,
                    modulos_otros: this.modulosOtros
                };
                delete payload.modulos_otros_texto;
                const response = await axios.post(`${API}/entregas-servicio`, payload);
                const notification = response.data?.notificacion;
                this.mensaje = notification?.estado === "ERROR"
                    ? "Entrega registrada y archivo cargado. El correo quedó pendiente de reintento."
                    : "Entrega registrada, propuesta almacenada y coordinador notificado.";
                this.form = emptyForm();
                this.clienteNuevoPreparado = null;
                this.contactos = [];
                this.busquedaModulo = "";
                this.busquedaConsultor = "";
                if (this.$refs?.propuestaPdf) this.$refs.propuestaPdf.value = "";
                await Promise.all([this.cargarCatalogos(), this.cargarEntregas()]);
                this.tab = "historial";
            } catch (error) {
                this.error = error?.response?.data?.error || "No se pudo registrar la entrega.";
            } finally {
                this.guardando = false;
            }
        },
        abrirDetalle(item) {
            this.detalleSeleccionado = item;
        },
        async reintentarNotificacion(item) {
            this.limpiarAlertas();
            try {
                await axios.post(`${API}/entregas-servicio/${item.id}/notificar`);
                this.mensaje = "Notificación enviada correctamente.";
                await this.cargarEntregas();
            } catch (error) {
                this.error = error?.response?.data?.error || "No se pudo reenviar la notificación.";
            }
        },
        nextStatuses(item) {
            return {
                REGISTRADA: ["ACEPTADA", "CANCELADA"],
                ACEPTADA: ["EN_PROCESO", "CANCELADA"],
                EN_PROCESO: ["CERRADA", "CANCELADA"]
            }[item?.estado] || [];
        },
        async cambiarEstado(item, estado) {
            if (!estado || !confirm(`¿Cambiar la entrega a ${this.statusLabel(estado)}?`)) return;
            this.limpiarAlertas();
            try {
                await axios.patch(`${API}/entregas-servicio/${item.id}/estado`, { estado });
                this.mensaje = "Estado actualizado correctamente.";
                await this.cargarEntregas();
            } catch (error) {
                this.error = error?.response?.data?.error || "No se pudo actualizar el estado.";
            }
        },
        typeLabel(value) {
            return { PROYECTO: "Proyecto", MESA_SERVICIO: "Mesa / Fábrica / Demanda", OUTSOURCING: "Outsourcing" }[value] || value;
        },
        statusLabel(value) {
            return {
                REGISTRADA: "Registrada", ACEPTADA: "Aceptada", EN_PROCESO: "En proceso",
                CERRADA: "Cerrada", CANCELADA: "Cancelada"
            }[value] || value;
        },
        formatDate(value) {
            if (!value) return "—";
            return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
        },
        formatMoney(value, currency = "COP") {
            if (value === null || value === undefined || value === "") return "—";
            return new Intl.NumberFormat("es-CO", { style: "currency", currency }).format(Number(value));
        }
    };
};

