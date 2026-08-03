// js/registro-horas-consultor.js
window.registroHorasApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        usuario: { id: null, nombre: "", rol: "" },
        esAsociado: false,
        asignaciones: [],
        cargando: true,
        filters: { cliente: "", tipo: "", estado: "" },
        modalOpen: false,
        itemSeleccionado: {},

        async init() {
            const user = window.auth ? window.auth.getUser() : null;
            if (user) {
                this.usuario = {
                    id: user.id,
                    nombre: user.nombre_usuario || "",
                    rol: user.rol || ""
                };
            }
            this.esAsociado = window.auth?.isAsociado?.() || false;
            await this.cargarAsignaciones();
        },

        async cargarAsignaciones() {
            this.cargando = true;
            try {
                const res = await axios.get(`${API}/registro-horas-asignaciones`);
                this.asignaciones = (res.data || [])
                    .filter((a) => {
                        const tipo = this.normalizarTipoAsignacion(a?.nombre_tipo_asignacion || "");
                        const compacto = tipo.replace(/\s+/g, "");
                        const esMesaOFabrica =
                            tipo.includes("mesa") ||
                            tipo.includes("service desk") ||
                            compacto.includes("servicedesk") ||
                            tipo.includes("fabrica");
                        return !esMesaOFabrica;
                    })
                    .map((a) => ({
                        ...a,
                        input_cantidad: 0
                    }));
            } catch (e) {
                this.asignaciones = [];
            } finally {
                this.cargando = false;
            }
        },

        get asignacionesFiltradas() {
            return this.asignaciones.filter((a) => {
                const f = this.filters;
                const matchCli = !f.cliente || a.nombre_cliente === f.cliente;
                const matchTipo = !f.tipo || a.nombre_tipo_asignacion === f.tipo;
                const matchEstado =
                    !f.estado ||
                    (f.estado === "Todos"
                        ? true
                        : ["Abierto", "Proceso"].includes(a.estado));
                return matchCli && matchTipo && matchEstado;
            });
        },

        get uniqueClientes() {
            return [...new Set(this.asignaciones.map((a) => a.nombre_cliente).filter(Boolean))];
        },

        get uniqueTipos() {
            return [...new Set(this.asignaciones.map((a) => a.nombre_tipo_asignacion).filter(Boolean))];
        },

        normalizarTipoAsignacion(tipoAsignacion) {
            return String(tipoAsignacion || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .replace(/\s+/g, " ")
                .trim();
        },

        esTipoMensual(tipoAsignacion) {
            const tipo = this.normalizarTipoAsignacion(tipoAsignacion);
            const compacto = tipo.replace(/\s+/g, "");
            return (
                tipo.includes("full") ||
                tipo.includes("part") ||
                tipo.includes("mensual") ||
                compacto.includes("mensual") ||
                tipo.includes("tiempo completo") ||
                compacto.includes("tiempocompleto") ||
                tipo.includes("medio tiempo") ||
                compacto.includes("mediotiempo")
            );
        },

        esTipoTiempoCostoFijo(tipoAsignacion) {
            const tipo = this.normalizarTipoAsignacion(tipoAsignacion);
            const compacto = tipo.replace(/\s+/g, "");
            return tipo.includes("tiempo y costo fijo") || compacto.includes("tiempoycostofijo");
        },

        esCostoTotal(item) {
            const raw = item?.es_costo_total;
            const boolVal = raw === true || raw === 1 || String(raw).toLowerCase() === "true" || String(raw) === "1";
            return this.esTipoTiempoCostoFijo(item?.nombre_tipo_asignacion) && boolVal;
        },

        obtenerTarifa(item) {
            if (this.esCostoTotal(item)) return 1;
            const esDias = this.esTipoMensual(item?.nombre_tipo_asignacion);
            return esDias ? item.valor_dia || 0 : item.valor_hora || 0;
        },

        calcularCosto(item) {
            const cantidad = parseFloat(item.input_cantidad) || 0;
            if (this.esCostoTotal(item)) return this.formatearDinero(cantidad);
            const tarifa = this.obtenerTarifa(item);
            return this.formatearDinero(tarifa * cantidad);
        },

        esExceso(item) {
            const reportado = parseFloat(item.input_cantidad) || 0;
            if (this.esCostoTotal(item)) {
                const disponible = item?.total_disponible;
                if (disponible === null || disponible === undefined || Number.isNaN(Number(disponible))) return false;
                return reportado > Number(disponible);
            }
            const esDias = this.esTipoMensual(item?.nombre_tipo_asignacion);
            if (esDias) {
                const disponible = item?.dias_disponibles;
                if (disponible === null || disponible === undefined || Number.isNaN(Number(disponible))) return false;
                return reportado > Number(disponible);
            }
            const disponible = item?.horas_disponibles;
            if (disponible === null || disponible === undefined || Number.isNaN(Number(disponible))) return false;
            return reportado > Number(disponible);
        },

        verDetalle(item) {
            this.itemSeleccionado = item;
            this.modalOpen = true;
        },

        esRechazado(item) {
            return String(item.estado_reporte || "").toLowerCase() === "rechazado";
        },

        tienePendientes(item) {
            return Number(item?.reportes_pendientes || 0) > 0;
        },

        formatearCantidad(val) {
            return new Intl.NumberFormat("es-CO", {
                maximumFractionDigits: 2
            }).format(Number(val || 0));
        },

        textoDisponible(item) {
            if (this.esCostoTotal(item)) {
                return this.formatearDinero(item?.total_disponible ?? item?.total_pagar ?? 0);
            }
            const esDias = this.esTipoMensual(item?.nombre_tipo_asignacion);
            if (esDias) {
                const disponible = Number(item?.dias_disponibles ?? item?.cantidad_dias ?? 0);
                return `${this.formatearCantidad(disponible)} Dias`;
            }
            const disponibleRaw = item?.horas_disponibles ?? item?.horas_asignadas;
            if (disponibleRaw === null || disponibleRaw === undefined) return "Sin tope";
            const disponible = Number(disponibleRaw);
            return `${this.formatearCantidad(disponible)} Hrs`;
        },

        async enviarReporte(item) {
            const tipo = item.nombre_tipo_asignacion;
            const esCostoTotal = this.esCostoTotal(item);
            const esDias = this.esTipoMensual(tipo);
            const unidad = esCostoTotal ? "COP" : (esDias ? "Dias" : "Horas");
            const cantidad = parseFloat(item.input_cantidad) || 0;
            if (!esCostoTotal && esDias && !Number.isInteger(cantidad)) {
                alert("Para asignaciones mensuales solo se permiten dias enteros.");
                return;
            }

            if (this.esExceso(item) && !esDias) {
                const maximo = esCostoTotal
                    ? Number(item?.total_disponible ?? item?.total_pagar ?? 0)
                    : Number(item?.horas_disponibles ?? item?.horas_asignadas ?? 0);
                alert(`No puedes reportar ${cantidad} ${unidad}. Maximo permitido: ${maximo}.`);
                return;
            }

            if (!confirm(`¿Reportar ${cantidad} ${unidad} para ${item.nombre_cliente}?`)) return;

            const tarifa = this.obtenerTarifa(item);
            const total = esCostoTotal ? cantidad : (tarifa * cantidad);

            const payload = {
                id_registro_asignacion: item.id,
                horas_reportadas: esCostoTotal ? 0 : (esDias ? 0 : cantidad),
                cantidad_dias_reportados: esCostoTotal ? 0 : (esDias ? cantidad : 0),
                total_cobrar: total,
                tipo_servicio: tipo,
                nro_caso_int_ext: item.nro_caso_interno || item.nro_caso_cliente || null
            };

            try {
                await axios.post(`${API}/reportar-horas`, payload);
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al enviar reporte";
                alert(msg);
                return;
            }

            alert("Reporte enviado correctamente");
            item.input_cantidad = 0;

            try {
                await this.cargarAsignaciones();
            } catch (e) {
                console.warn("Reporte enviado, pero no se pudo actualizar la lista", e);
            }
        },

        formatearDinero(val) {
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency: "COP",
                maximumFractionDigits: 0
            }).format(val || 0);
        },

        formatDate(dateStr) {
            if (!dateStr) return "Indefinido";
            return new Date(dateStr).toLocaleDateString("es-CO");
        }
    };
};
