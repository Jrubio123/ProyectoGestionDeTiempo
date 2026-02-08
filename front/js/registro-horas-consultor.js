// js/registro-horas-consultor.js
window.registroHorasApp = function () {
    const API = "http://localhost:4000";

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
                this.asignaciones = (res.data || []).map((a) => ({
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

        obtenerTarifa(item) {
            const tipo = String(item?.nombre_tipo_asignacion || "").toLowerCase();
            const esDias = tipo.includes("full") || tipo.includes("part");
            return esDias ? item.valor_dia || 0 : item.valor_hora || 0;
        },

        calcularCosto(item) {
            const tarifa = this.obtenerTarifa(item);
            const cantidad = parseFloat(item.input_cantidad) || 0;
            return this.formatearDinero(tarifa * cantidad);
        },

        esExceso(item) {
            const reportado = parseFloat(item.input_cantidad) || 0;
            const tipo = String(item?.nombre_tipo_asignacion || "").toLowerCase();
            const esDias = tipo.includes("full") || tipo.includes("part");
            if (esDias) {
                return item.cantidad_dias > 0 && reportado > item.cantidad_dias;
            }
            return item.horas_asignadas > 0 && reportado > item.horas_asignadas;
        },

        verDetalle(item) {
            this.itemSeleccionado = item;
            this.modalOpen = true;
        },

        esRechazado(item) {
            return String(item.estado_reporte || "").toLowerCase() === "rechazado";
        },

        async enviarReporte(item) {
            const tipo = item.nombre_tipo_asignacion;
            const tipoLower = String(tipo || "").toLowerCase();
            const esDias = tipoLower.includes("full") || tipoLower.includes("part");
            const unidad = esDias ? "Días" : "Horas";
            const cantidad = parseFloat(item.input_cantidad) || 0;

            if (this.esExceso(item)) {
                const maximo = esDias ? (item.cantidad_dias || 0) : (item.horas_asignadas || 0);
                alert(`No puedes reportar ${cantidad} ${unidad}. Máximo permitido: ${maximo}.`);
                return;
            }

            if (!confirm(`¿Reportar ${cantidad} ${unidad} para ${item.nombre_cliente}?`)) return;

            const tarifa = this.obtenerTarifa(item);
            const total = tarifa * cantidad;

            const payload = {
                id_registro_asignacion: item.id,
                horas_reportadas: esDias ? 0 : cantidad,
                cantidad_dias_reportados: esDias ? cantidad : 0,
                total_cobrar: total,
                tipo_servicio: tipo,
                nro_caso_int_ext: item.nro_caso_interno || item.nro_caso_cliente || null
            };

            try {
                await axios.post(`${API}/reportar-horas`, payload);
                alert("Reporte enviado correctamente");
                item.input_cantidad = 0;
                await this.cargarAsignaciones();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al enviar reporte";
                alert(msg);
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
