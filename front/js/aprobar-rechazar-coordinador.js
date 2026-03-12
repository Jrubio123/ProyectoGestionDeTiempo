// js/aprobar-rechazar-coordinador.js
window.aprobacionApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        reportes: [],
        filters: { cliente: "", tipo: "", search: "" },
        modalRechazo: { open: false, id: null, motivo: "" },
        modalDetalle: { open: false, reporte: null },

        async init() {
            await this.cargarDatos();
        },

        async cargarDatos() {
            try {
                const res = await axios.get(`${API}/aprobaciones/pendientes`);
                this.reportes = res.data || [];
            } catch (e) {
                this.reportes = [];
            }
        },

        get reportesFiltrados() {
            return this.reportes.filter((r) => {
                const f = this.filters;
                const matchCli = !f.cliente || r.nombre_cliente === f.cliente;
                const matchTipo = !f.tipo || r.nombre_tipo_asignacion === f.tipo;
                const search = (f.search || "").toLowerCase();
                const codigo = this.codigoTicket(r).toLowerCase();
                const casoCliente = this.casoCliente(r).toLowerCase();
                const casoInterno = this.casoInterno(r).toLowerCase();
                const referencia = this.referenciaTicket(r).toLowerCase();
                const matchSearch =
                    !search ||
                    (r.nombre_consultor || "").toLowerCase().includes(search) ||
                    casoCliente.includes(search) ||
                    casoInterno.includes(search) ||
                    referencia.includes(search) ||
                    codigo.includes(search);
                return matchCli && matchTipo && matchSearch;
            });
        },

        get uniqueClientes() {
            return [...new Set(this.reportes.map((r) => r.nombre_cliente).filter(Boolean))];
        },

        get uniqueTipos() {
            return [...new Set(this.reportes.map((r) => r.nombre_tipo_asignacion).filter(Boolean))];
        },

        get totalPendiente() {
            return this.reportesFiltrados.reduce((sum, r) => sum + Number(r.total_cobrar || 0), 0);
        },

        async aprobar(id) {
            if (!confirm("¿Aprobar reporte?")) return;
            try {
                await axios.put(`${API}/aprobaciones/${id}`, { estado: "Aprobado" });
                this.quitar(id);
            } catch (e) {
                alert("Error");
            }
        },

        abrirRechazo(id) {
            this.modalRechazo = { open: true, id: id, motivo: "" };
        },

        abrirDetalle(reporte) {
            this.modalDetalle = { open: true, reporte: { ...(reporte || {}) } };
        },

        cerrarDetalle() {
            this.modalDetalle = { open: false, reporte: null };
        },

        async confirmarRechazo() {
            try {
                await axios.put(`${API}/aprobaciones/${this.modalRechazo.id}`, {
                    estado: "Rechazado",
                    motivo: this.modalRechazo.motivo
                });
                this.quitar(this.modalRechazo.id);
                this.modalRechazo.open = false;
            } catch (e) {
                alert("Error");
            }
        },

        quitar(id) {
            this.reportes = this.reportes.filter((r) => r.id !== id);
        },

        exportarExcel() {
            const csvContent =
                "data:text/csv;charset=utf-8," +
                ["Fecha,Consultor,Cliente,Total"].join(",") +
                "\n" +
                this.reportesFiltrados
                    .map((r) => `${r.fecha_reporte},${r.nombre_consultor},${r.nombre_cliente},${r.total_cobrar}`)
                    .join("\n");
            const encodedUri = encodeURI(csvContent);
            window.open(encodedUri);
        },

        formatearDinero(val) {
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency: "COP",
                maximumFractionDigits: 0
            }).format(val || 0);
        },

        formatDate(d) {
            return d ? d.split("T")[0] : "";
        },

        normalizeTipo(tipo) {
            return String(tipo || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .trim();
        },

        parseCasePayload(rawValue) {
            const raw = String(rawValue ?? "").trim();
            if (!raw) {
                return { nro_caso_cliente: "", nro_caso_interno: "" };
            }
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    return {
                        nro_caso_cliente: String(parsed.nro_caso_cliente ?? parsed.cliente ?? parsed.caso_cliente ?? "").trim(),
                        nro_caso_interno: String(parsed.nro_caso_interno ?? parsed.interno ?? parsed.caso_interno ?? "").trim()
                    };
                }
            } catch (err) {
                // Texto simple legacy.
            }
            return { nro_caso_cliente: raw, nro_caso_interno: raw };
        },

        casoCliente(item) {
            const directo = String(item?.nro_caso_cliente || "").trim();
            if (directo) return directo;
            const fallback = String(item?.asignacion_nro_caso_cliente || "").trim();
            if (fallback) return fallback;
            return this.parseCasePayload(item?.nro_caso_int_ext).nro_caso_cliente || "";
        },

        casoInterno(item) {
            const directo = String(item?.nro_caso_interno || "").trim();
            if (directo) return directo;
            const fallback = String(item?.asignacion_nro_caso_interno || "").trim();
            if (fallback) return fallback;
            return this.parseCasePayload(item?.nro_caso_int_ext).nro_caso_interno || "";
        },

        resumenCaso(item) {
            const cliente = this.casoCliente(item);
            const interno = this.casoInterno(item);
            if (cliente && interno) return `Cliente: ${cliente} | Interno: ${interno}`;
            if (cliente) return `Cliente: ${cliente}`;
            if (interno) return `Interno: ${interno}`;
            return "Sin caso";
        },

        referenciaTicket(item) {
            const req = String(item?.requerimiento || "").trim();
            const wricef = String(item?.wricef || "").trim();
            const perfil = String(item?.perfil_fabrica || "").trim();
            return [req, wricef, perfil].filter(Boolean).join(" | ");
        },

        resumenCantidad(item) {
            const dias = Number(item?.cantidad_dias_reportados || 0);
            const horas = Number(item?.horas_reportadas || 0);
            if (dias > 0 && horas > 0) return `${dias} dias | ${horas} horas`;
            if (dias > 0) return `${dias} dias`;
            if (horas > 0) return `${horas} horas`;
            return "-";
        },

        periodoAsignacion(item) {
            const inicio = this.formatDate(item?.asignacion_fecha_inicio || "");
            const fin = this.formatDate(item?.asignacion_fecha_fin || "");
            if (inicio && fin) return `${inicio} a ${fin}`;
            return inicio || fin || "-";
        },

        codigoTicket(item) {
            const tipo = this.normalizeTipo(item?.nombre_tipo_asignacion || "");
            const esFabrica = tipo.includes("fabrica");
            const esMesa = tipo.includes("mesa de servicio");
            const prefijo = esFabrica ? "FB" : (esMesa ? "MS" : "RH");
            const base = String(item?.id || "")
                .replace(/-/g, "")
                .toUpperCase()
                .slice(0, 8);
            return `${prefijo}-${base || "SINCOD"}`;
        }
    };
};
