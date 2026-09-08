window.contabilidadApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const hoy = new Date();
    const nuevaFactura = () => ({
        id: null,
        persona_id: "",
        numero_factura: "",
        fecha_emision: hoy.toISOString().slice(0, 10),
        fecha_vencimiento: "",
        fecha_pago_preferida: "",
        concepto: "",
        ciudad_servicio: "",
        subtotal: "",
        tiene_iva: true,
        iva: 0,
        anticipo: 0,
        tipo_gasto: "servicio",
        moneda: "COP",
        soporte_url: ""
    });
    const nuevaRegla = () => ({
        id: null,
        concepto: "servicio",
        tipo_documento_pago: "cualquiera",
        nombre: "",
        base_minima: 0,
        porcentaje_fuente_declarante: 0,
        porcentaje_fuente_no_declarante: 0,
        porcentaje_iva: 19,
        porcentaje_reteiva: 15,
        base_reteica: 785610,
        porcentaje_reteica: 0.18,
        vigencia_desde: hoy.toISOString().slice(0, 10),
        vigencia_hasta: "",
        activo: true
    });
    const nuevoProveedor = () => ({
        tipo_persona: "Jurídica",
        tipo_documento_id: "",
        numero_documento: "",
        nombre: "",
        email: "",
        ciudad_residencia: "",
        banco_id: "",
        tipo_cuenta_id: "",
        numero_cuenta: "",
        factura_en_colombia: true,
        facturador_electronico: true,
        declarante_renta: true,
        es_gran_contribuyente: false,
        es_autorretenedor: false,
        es_regimen_simple: false,
        es_entidad_sin_animo_lucro: false,
        es_economia_naranja: false
    });

    return {
        tab: "programaciones",
        tabsCargados: new Set(),
        meses: [
            "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
            "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
        ].map((nombre, index) => ({ nombre, valor: index + 1 })),
        conceptos: [
            ["consultor", "Consultor"],
            ["honorarios", "Honorarios"],
            ["compra", "Compra"],
            ["servicio", "Servicio"],
            ["arrendamiento_inmueble", "Arrendamiento de inmueble"],
            ["arrendamiento_mueble", "Arrendamiento de mueble"]
        ],
        opcionesTributarias: [
            ["factura_en_colombia", "Factura en Colombia", "Desactivado: Capitalink, pago directo sin impuestos"],
            ["facturador_electronico", "Facturador electrónico", "Define el documento y la base aplicable"],
            ["declarante_renta", "Declarante de renta", "Usa la tarifa para declarantes"],
            ["es_gran_contribuyente", "Gran contribuyente", "No aplica ReteIVA"],
            ["es_autorretenedor", "Autorretenedor", "No aplica ReteFuente"],
            ["es_regimen_simple", "Régimen simple", "No aplica ReteFuente; sí ReteIVA"],
            ["es_entidad_sin_animo_lucro", "Entidad sin ánimo de lucro", "No aplica ReteFuente"],
            ["es_economia_naranja", "Economía naranja", "No aplica ReteFuente"]
        ],
        generacion: {
            anio: hoy.getFullYear(),
            mes: hoy.getMonth() + 1,
            quincena: hoy.getDate() <= 15 ? 1 : 2,
            trm_oficial: ""
        },
        filtrosHistorial: {
            anio: hoy.getFullYear(),
            meses: [],
            quincena: "",
            estado: "",
            buscar: "",
            desde: "",
            hasta: ""
        },
        vistaPrevia: null,
        programaciones: [],
        proyeccion: null,
        resumen: null,
        detalles: [],
        auditoria: [],
        filtroDetalle: "",
        tipoDetalle: "",
        facturas: [],
        filtroFacturas: "",
        factura: nuevaFactura(),
        busquedaBeneficiario: "",
        busquedaBeneficiarioRealizada: false,
        beneficiarios: [],
        beneficiarioSeleccionado: null,
        mostrarProveedor: false,
        proveedor: nuevoProveedor(),
        catalogosProveedor: { documentos: [], bancos: [], tipos_cuenta: [] },
        simulacionFactura: null,
        reglas: [],
        regla: nuevaRegla(),
        busquedaPerfil: "",
        perfiles: [],
        perfilSeleccionado: null,
        ajuste: null,
        mostrarAuditoria: false,
        simulador: {
            tipo_pago: "consultor",
            tipo_documento_pago: "cuenta_cobro",
            subtotal: 2000000,
            tiene_iva: false,
            anticipo: 0,
            ciudad_servicio: "",
            persona: {
                factura_en_colombia: true,
                declarante_renta: true,
                es_gran_contribuyente: false,
                es_autorretenedor: false,
                es_regimen_simple: false,
                es_entidad_sin_animo_lucro: false,
                es_economia_naranja: false
            }
        },
        resultadoSimulador: null,
        cargando: false,
        guardando: false,
        guardandoProveedor: false,
        error: "",
        mensaje: "",

        async init() {
            this.tabsCargados.add("programaciones");
            await this.listarProgramaciones(false);
        },

        async cambiarTab(tab) {
            this.tab = tab;
            this.limpiarAlertas();
            if (this.tabsCargados.has(tab)) return;
            this.tabsCargados.add(tab);
            if (tab === "facturas") await Promise.all([this.listarFacturas(), this.cargarCatalogosProveedores()]);
            if (tab === "configuracion") await this.listarReglas();
            if (tab === "historial") await this.listarProgramaciones(true);
        },

        limpiarAlertas() {
            this.error = "";
            this.mensaje = "";
        },

        errorDe(error, fallback) {
            return error?.response?.data?.error || error?.message || fallback;
        },

        payloadPeriodo() {
            const payload = {
                anio: Number(this.generacion.anio),
                mes: Number(this.generacion.mes),
                quincena: Number(this.generacion.quincena)
            };
            if (this.generacion.trm_oficial) payload.trm_oficial = Number(this.generacion.trm_oficial);
            return payload;
        },

        async cargarDisponibles() {
            this.limpiarAlertas();
            this.cargando = true;
            try {
                const { data } = await window.axios.post(
                    `${API}/api/contabilidad/proyeccion/previsualizar`,
                    this.payloadPeriodo()
                );
                this.vistaPrevia = data;
                if (data.proyeccion_existente?.id) await this.abrirProgramacion(data.proyeccion_existente.id);
            } catch (error) {
                this.vistaPrevia = null;
                this.error = this.errorDe(error, "No fue posible cargar los pagos disponibles.");
            } finally {
                this.cargando = false;
            }
        },

        async crearProgramacion() {
            if (!this.vistaPrevia?.resumen?.puede_generar) return;
            this.limpiarAlertas();
            this.guardando = true;
            try {
                const { data } = await window.axios.post(
                    `${API}/api/contabilidad/proyeccion/generar`,
                    this.payloadPeriodo()
                );
                await this.abrirProgramacion(data.proyeccion.id);
                await this.listarProgramaciones(false);
                this.vistaPrevia = null;
                this.mensaje = "Programación creada en borrador.";
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible crear la programación.");
            } finally {
                this.guardando = false;
            }
        },

        async listarProgramaciones(conFiltros = false) {
            this.cargando = true;
            try {
                const params = conFiltros ? {
                    ...this.filtrosHistorial,
                    meses: this.filtrosHistorial.meses.join(",")
                } : {};
                Object.keys(params).forEach((key) => {
                    if (params[key] === "" || params[key] === null) delete params[key];
                });
                const { data } = await window.axios.get(`${API}/api/contabilidad/proyecciones`, { params });
                this.programaciones = data.items || [];
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible consultar las programaciones.");
            } finally {
                this.cargando = false;
            }
        },

        async abrirProgramacion(id, irAProgramaciones = false) {
            this.limpiarAlertas();
            this.cargando = true;
            try {
                const { data } = await window.axios.get(
                    `${API}/api/contabilidad/proyeccion/${encodeURIComponent(id)}/detalles`
                );
                this.proyeccion = data.proyeccion;
                this.resumen = data.resumen;
                this.detalles = data.detalles || [];
                this.mostrarAuditoria = false;
                if (irAProgramaciones) this.tab = "programaciones";
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible abrir la programación.");
            } finally {
                this.cargando = false;
            }
        },

        get detallesFiltrados() {
            const buscar = this.normalizar(this.filtroDetalle);
            return this.detalles.filter((item) => {
                const coincideTipo = !this.tipoDetalle || item.origen_tipo === this.tipoDetalle;
                const contenido = this.normalizar(`${item.tercero} ${item.numero_documento} ${item.referencia}`);
                return coincideTipo && (!buscar || contenido.includes(buscar));
            });
        },

        get accionesDisponibles() {
            const estado = this.normalizar(this.proyeccion?.estado);
            if (estado === "borrador") return [{ estado: "Revisión", label: "Enviar a revisión" }];
            if (estado === "revision") return [{ estado: "Aprobado", label: "Aprobar programación" }];
            if (estado === "aprobado") return [{ estado: "Pagado", label: "Marcar como pagada" }];
            return [];
        },

        async cambiarEstado(accion) {
            if (!window.confirm(`¿Confirmas: ${accion.label.toLowerCase()}?`)) return;
            this.guardando = true;
            try {
                await window.axios.post(
                    `${API}/api/contabilidad/proyeccion/${encodeURIComponent(this.proyeccion.id)}/transicion`,
                    { estado: accion.estado }
                );
                await this.abrirProgramacion(this.proyeccion.id);
                await this.listarProgramaciones(false);
                this.mensaje = `La programación quedó en estado ${accion.estado}.`;
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible cambiar el estado.");
            } finally {
                this.guardando = false;
            }
        },

        abrirAjuste(detalle) {
            const existentes = new Map((detalle.retenciones_aplicadas || []).map((item) => [item.tipo, item]));
            const base = Number(detalle.subtotal || 0);
            const iva = Number(detalle.iva || 0);
            this.ajuste = {
                detalle,
                motivo: detalle.motivo_ajuste || "",
                retenciones: [
                    { tipo: "ReteFuente", porcentaje: 0, base, valor: 0, ...(existentes.get("ReteFuente") || {}) },
                    { tipo: "ReteIVA", porcentaje: 0, base: iva, valor: 0, ...(existentes.get("ReteIVA") || {}) },
                    { tipo: "ReteICA", porcentaje: 0, base, valor: 0, ...(existentes.get("ReteICA") || {}) }
                ]
            };
        },

        recalcularRetencion(item) {
            item.valor = Math.round(Number(item.base || 0) * Number(item.porcentaje || 0)) / 100;
        },

        async guardarAjuste() {
            if (!this.ajuste?.motivo.trim()) {
                this.error = "Indica el motivo del ajuste.";
                return;
            }
            this.guardando = true;
            try {
                await window.axios.put(
                    `${API}/api/contabilidad/proyeccion/detalle/${this.ajuste.detalle.id}/retenciones`,
                    { retenciones: this.ajuste.retenciones, motivo: this.ajuste.motivo }
                );
                const id = this.proyeccion.id;
                this.ajuste = null;
                await this.abrirProgramacion(id);
                this.mensaje = "Retenciones actualizadas y registradas en la auditoría.";
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible guardar el ajuste.");
            } finally {
                this.guardando = false;
            }
        },

        async verAuditoria() {
            this.mostrarAuditoria = !this.mostrarAuditoria;
            if (!this.mostrarAuditoria || this.auditoria.length) return;
            try {
                const { data } = await window.axios.get(
                    `${API}/api/contabilidad/proyeccion/${this.proyeccion.id}/auditoria`
                );
                this.auditoria = data.items || [];
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible consultar la auditoría.");
            }
        },

        async exportarBanco() {
            try {
                const response = await window.axios.get(
                    `${API}/api/contabilidad/proyeccion/${this.proyeccion.id}/exportar-banco`,
                    { responseType: "blob" }
                );
                const blob = new Blob([response.data], { type: "text/csv;charset=utf-8" });
                const enlace = document.createElement("a");
                enlace.href = URL.createObjectURL(blob);
                enlace.download = `pagos-${this.proyeccion.anio}-${String(this.proyeccion.mes).padStart(2, "0")}-corte-${this.proyeccion.quincena === 1 ? "15" : "30"}.csv`;
                enlace.click();
                URL.revokeObjectURL(enlace.href);
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible descargar el archivo bancario.");
            }
        },

        async buscarBeneficiarios(destino = "factura") {
            const valor = destino === "perfil" ? this.busquedaPerfil : this.busquedaBeneficiario;
            if (String(valor).trim().length < 2) return;
            try {
                const { data } = await window.axios.get(`${API}/api/contabilidad/beneficiarios`, {
                    params: { buscar: valor }
                });
                if (destino === "perfil") this.perfiles = data.items || [];
                else {
                    this.beneficiarios = data.items || [];
                    this.busquedaBeneficiarioRealizada = true;
                }
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible buscar beneficiarios.");
            }
        },

        async cargarCatalogosProveedores() {
            if (this.catalogosProveedor.documentos.length) return;
            try {
                const { data } = await window.axios.get(`${API}/api/contabilidad/catalogos-proveedores`);
                this.catalogosProveedor = {
                    documentos: data.documentos || [],
                    bancos: data.bancos || [],
                    tipos_cuenta: data.tipos_cuenta || []
                };
                this.seleccionarTipoDocumentoProveedor();
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible cargar los datos para registrar proveedores.");
            }
        },

        seleccionarTipoDocumentoProveedor() {
            const esperado = this.proveedor.tipo_persona === "Jurídica" ? "nit" : "ciudadan";
            const documento = this.catalogosProveedor.documentos.find((item) => this.normalizar(item.titulo).includes(esperado));
            if (documento) this.proveedor.tipo_documento_id = documento.id;
        },

        async abrirRegistroProveedor() {
            this.limpiarAlertas();
            this.proveedor = nuevoProveedor();
            await this.cargarCatalogosProveedores();
            this.seleccionarTipoDocumentoProveedor();
            this.mostrarProveedor = true;
        },

        cerrarRegistroProveedor() {
            if (this.guardandoProveedor) return;
            this.mostrarProveedor = false;
        },

        async guardarProveedor() {
            this.limpiarAlertas();
            this.guardandoProveedor = true;
            try {
                const { data } = await window.axios.post(`${API}/api/contabilidad/beneficiarios`, this.proveedor);
                this.seleccionarBeneficiario(data);
                this.mostrarProveedor = false;
                this.mensaje = "Proveedor registrado y seleccionado para la factura.";
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible registrar el proveedor.");
            } finally {
                this.guardandoProveedor = false;
            }
        },

        seleccionarBeneficiario(item) {
            this.beneficiarioSeleccionado = item;
            this.factura.persona_id = item.id;
            this.busquedaBeneficiario = `${item.numero_documento} — ${item.nombre}`;
            this.beneficiarios = [];
            this.busquedaBeneficiarioRealizada = false;
            this.simulacionFactura = null;
        },

        seleccionarPerfil(item) {
            this.perfilSeleccionado = JSON.parse(JSON.stringify(item));
            this.busquedaPerfil = `${item.numero_documento} — ${item.nombre}`;
            this.perfiles = [];
        },

        limpiarFactura() {
            this.factura = nuevaFactura();
            this.beneficiarioSeleccionado = null;
            this.busquedaBeneficiario = "";
            this.beneficiarios = [];
            this.busquedaBeneficiarioRealizada = false;
            this.simulacionFactura = null;
        },

        async simularFactura() {
            if (!this.factura.persona_id || !Number(this.factura.subtotal)) {
                this.error = "Selecciona el beneficiario e ingresa el subtotal.";
                return null;
            }
            try {
                const { data } = await window.axios.post(`${API}/api/contabilidad/retenciones/simular`, {
                    persona_id: this.factura.persona_id,
                    tipo_pago: this.factura.tipo_gasto,
                    tipo_documento_pago: "factura_electronica",
                    subtotal: Number(this.factura.subtotal),
                    tiene_iva: this.factura.tiene_iva,
                    anticipo: Number(this.factura.anticipo || 0),
                    ciudad_servicio: this.factura.ciudad_servicio,
                    fecha_aplicacion: this.factura.fecha_pago_preferida || this.factura.fecha_emision
                });
                this.simulacionFactura = data;
                this.factura.iva = data.iva;
                return data;
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible calcular la factura.");
                return null;
            }
        },

        async guardarFactura() {
            this.limpiarAlertas();
            const calculo = await this.simularFactura();
            if (!calculo) return;
            this.guardando = true;
            try {
                const payload = { ...this.factura, iva: calculo.iva };
                const request = this.factura.id
                    ? window.axios.put(`${API}/api/contabilidad/facturas-proveedores/${this.factura.id}`, payload)
                    : window.axios.post(`${API}/api/contabilidad/facturas-proveedores`, payload);
                await request;
                this.limpiarFactura();
                await this.listarFacturas();
                this.mensaje = "Factura guardada y lista para su fecha de pago.";
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible guardar la factura.");
            } finally {
                this.guardando = false;
            }
        },

        editarFactura(item) {
            this.factura = {
                ...nuevaFactura(),
                ...item,
                fecha_emision: String(item.fecha_emision || "").slice(0, 10),
                fecha_vencimiento: String(item.fecha_vencimiento || "").slice(0, 10),
                fecha_pago_preferida: String(item.fecha_pago_preferida || "").slice(0, 10),
                soporte_url: item.documento_soporte?.url || ""
            };
            this.beneficiarioSeleccionado = { id: item.persona_id, nombre: item.beneficiario, numero_documento: item.documento };
            this.busquedaBeneficiario = `${item.documento} — ${item.beneficiario}`;
            this.simulacionFactura = null;
            window.scrollTo({ top: 0, behavior: "smooth" });
        },

        async anularFactura(item) {
            if (!window.confirm(`¿Anular la factura ${item.numero_factura}?`)) return;
            try {
                await window.axios.delete(`${API}/api/contabilidad/facturas-proveedores/${item.id}`);
                await this.listarFacturas();
                this.mensaje = "Factura anulada.";
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible anular la factura.");
            }
        },

        async listarFacturas() {
            try {
                const { data } = await window.axios.get(`${API}/api/contabilidad/facturas-proveedores`, {
                    params: { buscar: this.filtroFacturas }
                });
                this.facturas = data.items || [];
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible consultar las facturas.");
            }
        },

        async guardarPerfil() {
            if (!this.perfilSeleccionado?.id) return;
            this.guardando = true;
            try {
                const payload = Object.fromEntries(this.opcionesTributarias.map(([campo]) => [campo, !!this.perfilSeleccionado[campo]]));
                await window.axios.put(
                    `${API}/api/contabilidad/beneficiarios/${this.perfilSeleccionado.id}/perfil-tributario`,
                    payload
                );
                this.mensaje = "Perfil tributario actualizado.";
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible guardar el perfil.");
            } finally {
                this.guardando = false;
            }
        },

        async listarReglas() {
            try {
                const { data } = await window.axios.get(`${API}/api/contabilidad/configuracion/reglas`);
                this.reglas = data.items || [];
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible consultar la configuración.");
            }
        },

        editarRegla(item = null) {
            this.regla = item ? {
                ...JSON.parse(JSON.stringify(item)),
                vigencia_desde: String(item.vigencia_desde || "").slice(0, 10),
                vigencia_hasta: String(item.vigencia_hasta || "").slice(0, 10)
            } : nuevaRegla();
        },

        async guardarRegla() {
            this.guardando = true;
            try {
                const request = this.regla.id
                    ? window.axios.put(`${API}/api/contabilidad/configuracion/reglas/${this.regla.id}`, this.regla)
                    : window.axios.post(`${API}/api/contabilidad/configuracion/reglas`, this.regla);
                await request;
                await this.listarReglas();
                this.regla = nuevaRegla();
                this.mensaje = "Regla contable guardada.";
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible guardar la regla.");
            } finally {
                this.guardando = false;
            }
        },

        async simularRetenciones() {
            try {
                const { data } = await window.axios.post(`${API}/api/contabilidad/retenciones/simular`, {
                    ...this.simulador,
                    subtotal: Number(this.simulador.subtotal),
                    anticipo: Number(this.simulador.anticipo || 0)
                });
                this.resultadoSimulador = data;
            } catch (error) {
                this.error = this.errorDe(error, "No fue posible simular las retenciones.");
            }
        },

        alternarMes(mes) {
            const index = this.filtrosHistorial.meses.indexOf(mes);
            if (index >= 0) this.filtrosHistorial.meses.splice(index, 1);
            else this.filtrosHistorial.meses.push(mes);
        },

        normalizar(value) {
            return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        },

        nombreMes(value) {
            return this.meses.find((item) => item.valor === Number(value))?.nombre || "Mes";
        },

        tituloProgramacion(item) {
            return `Programación de pagos — ${this.formatearFecha(item?.fecha_pago_programada)}`;
        },

        etiquetaCorte(item) {
            if (Number(item?.quincena) === 1) return "Corte del 15";
            return Number(item?.mes) === 2 ? "Corte de febrero" : "Corte del 30";
        },

        estadoClase(value) {
            const map = {
                borrador: "bg-amber-100 text-amber-800",
                revision: "bg-blue-100 text-blue-800",
                aprobado: "bg-violet-100 text-violet-800",
                pagado: "bg-emerald-100 text-emerald-800",
                cancelado: "bg-slate-200 text-slate-700",
                pendiente: "bg-amber-100 text-amber-800",
                proyectada: "bg-blue-100 text-blue-800",
                pagada: "bg-emerald-100 text-emerald-800",
                anulada: "bg-slate-200 text-slate-600"
            };
            return map[this.normalizar(value)] || "bg-slate-100 text-slate-700";
        },

        tipoOrigen(value) {
            return { cuenta_cobro: "Cuenta de cobro", factura_proveedor: "Factura", nomina: "Nómina" }[value] || value;
        },

        nombreConcepto(value) {
            return this.conceptos.find(([id]) => id === value)?.[1] || value;
        },

        formatearMoneda(value, currency = "COP") {
            const number = Number(value || 0);
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency,
                maximumFractionDigits: currency === "COP" ? 0 : 2
            }).format(Number.isFinite(number) ? number : 0);
        },

        formatearValorOrigen(value, currency = "COP") {
            return this.formatearMoneda(value, currency || "COP");
        },

        formatearFecha(value, includeTime = false) {
            if (!value) return "—";
            const dateValue = new Date(includeTime ? value : `${String(value).slice(0, 10)}T12:00:00`);
            return new Intl.DateTimeFormat("es-CO", includeTime
                ? { dateStyle: "medium", timeStyle: "short" }
                : { day: "2-digit", month: "2-digit", year: "numeric" }
            ).format(dateValue);
        },

        formatearFechaHora(value) {
            return this.formatearFecha(value, true);
        }
    };
};
