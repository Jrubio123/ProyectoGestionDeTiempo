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
        detalle_tarifas: "",
        tiempo_descripcion: "",
        valor_cliente: "",
        tiene_contrato: ""
    });
    const emptyForm = () => ({
        tipo_servicio: "PROYECTO",
        cliente_id: "",
        coordinador_id: "",
        nombre_servicio: "",
        perfil_cliente: "",
        acuerdos_comerciales: "",
        contacto_id: "",
        contacto_nuevo: emptyContact(),
        consultores_ids: [],
        consultores_tarifas: {},
        consultores_externos: [],
        modulos_ids: [],
        modulos_otros_texto: "",
        enlaces: [{ titulo: "", url: "" }],
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
        reasignaciones: {},
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
            return this.roleKey === "comercial";
        },
        get historialTitulo() {
            if (this.roleKey === "admin") return "Todas las entregas de servicio";
            if (this.roleKey === "coordinador") return "Servicios entregados a mí";
            return "Mis entregas realizadas";
        },
        get historialDescripcion() {
            if (this.roleKey === "admin") return "Consulta quién realizó cada entrega, su responsable y reasígnala mientras esté pendiente.";
            if (this.roleKey === "coordinador") return "Consulta quién te entregó cada servicio y su información comercial.";
            return "Consulta los servicios que entregaste al equipo de operaciones.";
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
        get consultoresSeleccionados() {
            const selected = new Set(this.form.consultores_ids);
            return this.catalogos.consultores.filter((item) => selected.has(item.id));
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
        get responsableActual() {
            return this.catalogos.coordinadores.find((item) => item.es_actual) || null;
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
        get consultoresExternosValidos() {
            return this.form.consultores_externos.every((item) =>
                String(item.nombre || "").trim() &&
                String(item.telefono || "").trim() &&
                this.tarifaConsultorValida(item)
            );
        },
        get tarifasConsultoresValidas() {
            return this.form.consultores_ids.every((id) =>
                this.tarifaConsultorValida(this.form.consultores_tarifas[id])
            );
        },
        get enlacesValidos() {
            return this.form.enlaces.every((item) => {
                const titulo = String(item.titulo || "").trim();
                const url = String(item.url || "").trim();
                if (!titulo && !url) return true;
                try {
                    return ["http:", "https:"].includes(new URL(url).protocol);
                } catch (_) {
                    return false;
                }
            });
        },
        get enlacesRegistrados() {
            return this.form.enlaces.filter((item) => String(item.url || "").trim()).length;
        },
        get formularioValido() {
            const base = Boolean(
                (this.form.cliente_id || this.clienteNuevoPreparado) &&
                this.form.coordinador_id &&
                this.form.perfil_cliente &&
                this.contactoValido &&
                this.tarifasConsultoresValidas &&
                this.consultoresExternosValidos &&
                this.enlacesValidos &&
                (this.form.modulos_ids.length || this.modulosOtros.length)
            );
            if (!base) return false;
            if (this.requierePropuesta && !this.enlacesRegistrados) return false;
            const detail = this.form.detalle;
            if (this.form.tipo_servicio === "PROYECTO") {
                return Boolean(
                    detail.nombre_proyecto.trim() && detail.objeto_proyecto.trim() &&
                    detail.valor_total !== "" && detail.forma_pago.trim() &&
                    detail.equipo_estimacion.trim()
                );
            }
            if (this.form.tipo_servicio === "MESA_SERVICIO") {
                return Boolean(detail.detalle_tarifas.trim() && detail.forma_pago.trim());
            }
            return Boolean(
                (this.form.consultores_ids.length || this.form.consultores_externos.length) &&
                detail.tiempo_descripcion.trim() &&
                detail.valor_cliente !== "" && detail.tiene_contrato !== ""
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
        tarifaConsultorValida(item) {
            const rawValue = String(item?.tarifa_consultoria ?? "").trim();
            const currency = String(item?.moneda_tarifa_consultoria || "").toUpperCase();
            return rawValue !== "" && Number.isFinite(Number(rawValue)) && Number(rawValue) >= 0 &&
                ["COP", "USD", "EUR"].includes(currency);
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
                this.reasignaciones = Object.fromEntries(
                    this.entregas.map((item) => [item.id, item.coordinador_id])
                );
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
            const cliente = this.catalogos.clientes.find((item) => item.id === this.form.cliente_id);
            this.form.perfil_cliente = cliente?.perfil_cliente || "";
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
            this.form.perfil_cliente = "";
            this.form.contacto_id = "";
            this.contactos = [];
            this.clienteNuevo.open = false;
        },
        cancelarClienteNuevoPreparado() {
            this.clienteNuevoPreparado = null;
            this.form.perfil_cliente = "";
        },
        usarContactoNuevo() {
            this.form.contacto_id = "";
            this.form.contacto_nuevo = emptyContact();
        },
        agregarConsultorExterno() {
            this.form.consultores_externos.push({
                nombre: "",
                telefono: "",
                tarifa_consultoria: "",
                moneda_tarifa_consultoria: "COP"
            });
        },
        quitarConsultorExterno(index) {
            this.form.consultores_externos.splice(index, 1);
        },
        actualizarSeleccionConsultor(consultorId, seleccionado = this.form.consultores_ids.includes(consultorId)) {
            if (seleccionado) {
                if (!this.form.consultores_tarifas[consultorId]) {
                    this.form.consultores_tarifas[consultorId] = {
                        tarifa_consultoria: "",
                        moneda_tarifa_consultoria: "COP"
                    };
                }
                return;
            }
            delete this.form.consultores_tarifas[consultorId];
        },
        agregarEnlace() {
            this.form.enlaces.push({ titulo: "", url: "" });
        },
        quitarEnlace(index) {
            this.form.enlaces.splice(index, 1);
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
                    ? "Entrega registrada. El correo quedó pendiente de reintento."
                    : "Entrega registrada y responsable notificado.";
                this.form = emptyForm();
                this.clienteNuevoPreparado = null;
                this.contactos = [];
                this.busquedaModulo = "";
                this.busquedaConsultor = "";
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
        esAsignadaAlActual(item) {
            return Boolean(this.responsableActual?.id && item?.coordinador_id === this.responsableActual.id);
        },
        puedeAceptar(item) {
            if (item?.estado !== "REGISTRADA") return false;
            if (this.roleKey === "coordinador") return true;
            return this.roleKey === "admin" && this.esAsignadaAlActual(item);
        },
        puedeDevolver(item) {
            return this.roleKey === "admin" && item?.estado === "REGISTRADA" && this.esAsignadaAlActual(item);
        },
        puedeReasignar(item) {
            return this.roleKey === "admin" && item?.estado === "REGISTRADA";
        },
        async reasignar(item) {
            const coordinadorId = this.reasignaciones[item.id];
            if (!coordinadorId || coordinadorId === item.coordinador_id) return;
            const responsable = this.catalogos.coordinadores.find((entry) => entry.id === coordinadorId);
            if (!confirm(`¿Asignar esta entrega a ${responsable?.nombre || "la persona seleccionada"} y notificarle?`)) return;
            this.limpiarAlertas();
            try {
                const response = await axios.patch(`${API}/entregas-servicio/${item.id}/asignacion`, {
                    coordinador_id: coordinadorId
                });
                this.mensaje = response.data?.notificacion?.estado === "ERROR"
                    ? "Entrega reasignada. El correo quedó pendiente de reintento."
                    : "Entrega reasignada y responsable notificado.";
                await this.cargarEntregas();
            } catch (error) {
                this.error = error?.response?.data?.error || "No se pudo reasignar la entrega.";
            }
        },
        async cambiarEstado(item, estado) {
            const accion = estado === "CANCELADA" ? "devolver" : "aceptar";
            if (!estado || !confirm(`¿Deseas ${accion} esta entrega?`)) return;
            this.limpiarAlertas();
            try {
                await axios.patch(`${API}/entregas-servicio/${item.id}/estado`, { estado });
                this.mensaje = estado === "CANCELADA"
                    ? "Entrega devuelta correctamente."
                    : "Entrega aceptada correctamente.";
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
                REGISTRADA: "Pendiente de aceptación", ACEPTADA: "Aceptada", EN_PROCESO: "En proceso",
                CERRADA: "Cerrada", CANCELADA: "Devuelta"
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
