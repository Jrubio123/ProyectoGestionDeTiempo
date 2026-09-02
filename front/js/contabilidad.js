window.contabilidadApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const ahora = new Date();

    return {
        tab: "proyecciones",
        meses: [
            "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
            "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
        ].map((nombre, index) => ({ nombre, valor: index + 1 })),
        opcionesTributarias: [
            { campo: "es_gran_contribuyente", nombre: "Gran contribuyente", efecto: "No aplica ReteIVA" },
            { campo: "es_autorretenedor", nombre: "Autorretenedor", efecto: "No aplica ReteFuente" },
            { campo: "es_regimen_simple", nombre: "Régimen simple", efecto: "No aplica ReteFuente" },
            { campo: "es_entidad_sin_animo_lucro", nombre: "Entidad sin ánimo de lucro", efecto: "No aplica ReteFuente" }
        ],
        generacion: {
            anio: ahora.getFullYear(),
            mes: ahora.getMonth() + 1,
            quincena: ahora.getDate() <= 15 ? 1 : 2,
            trm_oficial: ""
        },
        simulador: {
            tipo_pago: "consultor",
            subtotal: 2000000,
            iva: 0,
            persona: {
                factura_en_colombia: true,
                declarante_renta: true,
                es_gran_contribuyente: false,
                es_autorretenedor: false,
                es_regimen_simple: false,
                es_entidad_sin_animo_lucro: false,
                ciudad_residencia: ""
            }
        },
        loteId: "",
        proyeccion: null,
        resumen: null,
        detalles: [],
        resultadoGeneracion: null,
        limbo: [],
        vistaPrevia: null,
        resultadoSimulador: null,
        previsualizando: false,
        generando: false,
        consultando: false,
        transicionando: false,
        simulando: false,
        error: "",
        mensaje: "",

        init() {
            this.limpiarAlertas();
        },

        limpiarAlertas() {
            this.error = "";
            this.mensaje = "";
        },

        limpiarVistaPrevia() {
            this.vistaPrevia = null;
            this.resultadoGeneracion = null;
            this.limpiarAlertas();
        },

        mensajeError(error, respaldo) {
            return error?.response?.data?.error || error?.message || respaldo;
        },

        payloadPeriodo() {
            const payload = {
                anio: Number(this.generacion.anio),
                mes: Number(this.generacion.mes),
                quincena: Number(this.generacion.quincena)
            };
            if (this.generacion.trm_oficial !== "" && this.generacion.trm_oficial !== null) {
                payload.trm_oficial = Number(this.generacion.trm_oficial);
            }
            return payload;
        },

        async previsualizarProyeccion() {
            this.limpiarAlertas();
            this.previsualizando = true;
            try {
                const response = await window.axios.post(
                    `${API}/api/contabilidad/proyeccion/previsualizar`,
                    this.payloadPeriodo()
                );
                this.vistaPrevia = response.data;
                this.proyeccion = null;
                this.resumen = null;
                this.detalles = [];
            } catch (error) {
                this.vistaPrevia = null;
                this.error = this.mensajeError(error, "No fue posible buscar los pagos disponibles.");
            } finally {
                this.previsualizando = false;
            }
        },

        async generarProyeccion() {
            if (!this.vistaPrevia?.resumen?.puede_generar) {
                this.error = "Primero busca y confirma los pagos disponibles.";
                return;
            }
            this.limpiarAlertas();
            this.generando = true;
            try {
                const response = await window.axios.post(
                    `${API}/api/contabilidad/proyeccion/generar`,
                    this.payloadPeriodo()
                );
                this.loteId = response.data?.proyeccion?.id || "";
                this.resultadoGeneracion = response.data?.resumen || null;
                this.limbo = response.data?.limbo || [];
                this.mensaje = "La proyección se generó en estado Borrador.";
                if (this.loteId) await this.consultarProyeccion(false);
            } catch (error) {
                const codigo = error?.response?.data?.codigo;
                this.error = codigo === "PROYECCION_SIN_DETALLES"
                    ? "Los pagos disponibles cambiaron mientras confirmabas. Vuelve a buscarlos antes de crear el lote."
                    : this.mensajeError(error, "No fue posible generar la proyección.");
                this.limbo = error?.response?.data?.datos?.limbo || [];
            } finally {
                this.generando = false;
            }
        },

        async abrirProyeccionExistente() {
            const id = this.vistaPrevia?.proyeccion_existente?.id;
            if (!id) return;
            this.loteId = id;
            await this.consultarProyeccion();
        },

        async consultarProyeccion(limpiar = true) {
            if (limpiar) this.limpiarAlertas();
            const id = String(this.loteId || "").trim();
            if (!id) {
                this.error = "Ingresa el ID de la proyección.";
                return;
            }
            this.consultando = true;
            try {
                const response = await window.axios.get(`${API}/api/contabilidad/proyeccion/${encodeURIComponent(id)}/detalles`);
                this.proyeccion = response.data?.proyeccion || null;
                this.resumen = response.data?.resumen || null;
                this.detalles = response.data?.detalles || [];
                this.loteId = this.proyeccion?.id || id;
            } catch (error) {
                this.proyeccion = null;
                this.resumen = null;
                this.detalles = [];
                this.error = this.mensajeError(error, "No fue posible consultar la proyección.");
            } finally {
                this.consultando = false;
            }
        },

        get accionesDisponibles() {
            const estado = this.normalizarTexto(this.proyeccion?.estado);
            if (estado === "borrador") return [{ estado: "Revisión", label: "Enviar a revisión" }];
            if (estado === "revision") return [{ estado: "Aprobado", label: "Aprobar lote" }];
            if (estado === "aprobado") return [{ estado: "Pagado", label: "Marcar como pagado" }];
            return [];
        },

        async transicionar(accion) {
            if (!this.proyeccion?.id || !accion?.estado) return;
            const confirmado = window.confirm(`¿Confirmas que deseas cambiar el lote a ${accion.estado}?`);
            if (!confirmado) return;
            this.limpiarAlertas();
            this.transicionando = true;
            try {
                await window.axios.post(
                    `${API}/api/contabilidad/proyeccion/${encodeURIComponent(this.proyeccion.id)}/transicion`,
                    { estado: accion.estado }
                );
                await this.consultarProyeccion(false);
                this.mensaje = `El lote cambió a ${accion.estado}.`;
            } catch (error) {
                this.error = this.mensajeError(error, "No fue posible cambiar el estado del lote.");
            } finally {
                this.transicionando = false;
            }
        },

        async simularRetenciones() {
            this.limpiarAlertas();
            this.simulando = true;
            try {
                const response = await window.axios.post(`${API}/api/contabilidad/retenciones/simular`, {
                    tipo_pago: this.simulador.tipo_pago,
                    subtotal: Number(this.simulador.subtotal),
                    iva: Number(this.simulador.iva || 0),
                    persona: { ...this.simulador.persona }
                });
                this.resultadoSimulador = response.data;
            } catch (error) {
                this.resultadoSimulador = null;
                this.error = this.mensajeError(error, "No fue posible simular las retenciones.");
            } finally {
                this.simulando = false;
            }
        },

        normalizarTexto(value) {
            return String(value || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .trim();
        },

        nombreMes(numero) {
            return this.meses.find((item) => item.valor === Number(numero))?.nombre || "Periodo";
        },

        estadoClase(estado) {
            const clases = {
                borrador: "bg-amber-100 text-amber-800",
                revision: "bg-blue-100 text-blue-800",
                aprobado: "bg-violet-100 text-violet-800",
                pagado: "bg-emerald-100 text-emerald-800",
                cancelado: "bg-slate-200 text-slate-700"
            };
            return clases[this.normalizarTexto(estado)] || "bg-slate-100 text-slate-700";
        },

        tipoOrigen(tipo) {
            return {
                cuenta_cobro: "Cuenta de cobro",
                factura_proveedor: "Factura de proveedor",
                nomina: "Nómina"
            }[tipo] || tipo || "Sin origen";
        },

        formatearMoneda(value) {
            const numero = Number(value || 0);
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency: "COP",
                maximumFractionDigits: 0
            }).format(Number.isFinite(numero) ? numero : 0);
        },

        formatearValorOrigen(value, moneda = "COP") {
            const numero = Number(value || 0);
            const codigo = String(moneda || "COP").toUpperCase();
            try {
                return new Intl.NumberFormat("es-CO", {
                    style: "currency",
                    currency: codigo,
                    maximumFractionDigits: 2
                }).format(Number.isFinite(numero) ? numero : 0);
            } catch (_) {
                return `${codigo} ${Number.isFinite(numero) ? numero.toLocaleString("es-CO") : "0"}`;
            }
        },

        formatearFecha(value) {
            if (!value) return "Sin fecha";
            const partes = String(value).slice(0, 10).split("-");
            if (partes.length !== 3) return String(value);
            return `${partes[2]}/${partes[1]}/${partes[0]}`;
        }
    };
};
