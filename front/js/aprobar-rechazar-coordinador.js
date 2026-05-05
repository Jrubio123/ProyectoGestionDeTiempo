// js/aprobar-rechazar-coordinador.js
window.aprobacionApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        reportes: [],
        filters: { cliente: "", tipo: "", search: "" },
        modalRechazo: { open: false, id: null, motivo: "" },
        modalDetalle: { open: false, reporte: null },
        modalExport: { open: false, fecha_inicio: "", fecha_fin: "", loading: false, error: "" },

        async init() {
            this.resetExportDates();
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
            this.abrirModalSolicitudes();
        },

        resetExportDates() {
            const now = new Date();
            const first = new Date(now.getFullYear(), now.getMonth(), 1);
            const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            this.modalExport.fecha_inicio = this.toDateInput(first);
            this.modalExport.fecha_fin = this.toDateInput(last);
        },

        abrirModalSolicitudes() {
            if (!this.modalExport.fecha_inicio || !this.modalExport.fecha_fin) {
                this.resetExportDates();
            }
            this.modalExport.error = "";
            this.modalExport.open = true;
        },

        cerrarModalSolicitudes() {
            this.modalExport.open = false;
            this.modalExport.error = "";
        },

        async descargarSolicitudes(tipo) {
            if (this.modalExport.loading) return;
            this.modalExport.error = "";

            const fechaInicio = this.modalExport.fecha_inicio;
            const fechaFin = this.modalExport.fecha_fin;
            if (!fechaInicio || !fechaFin) {
                this.modalExport.error = "Selecciona fecha inicio y fecha fin.";
                return;
            }
            if (fechaFin < fechaInicio) {
                this.modalExport.error = "La fecha fin no puede ser menor a la fecha inicio.";
                return;
            }

            this.modalExport.loading = true;
            try {
                const res = await axios.get(`${API}/aprobaciones/solicitudes`, {
                    params: { fecha_inicio: fechaInicio, fecha_fin: fechaFin, tipo }
                });
                const rows = (res.data || []).map((r) => this.normalizarSolicitudExcel(r));
                if (!rows.length) {
                    this.modalExport.error = "No hay solicitudes para descargar en ese rango.";
                    return;
                }
                this.generarExcel(rows, this.tipoExportLabel(tipo), this.nombreArchivoSolicitudes(tipo));
            } catch (e) {
                this.modalExport.error = e?.response?.data?.error || "Error descargando solicitudes.";
            } finally {
                this.modalExport.loading = false;
            }
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

        toDateInput(date) {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, "0");
            const d = String(date.getDate()).padStart(2, "0");
            return `${y}-${m}-${d}`;
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

        normalizarSolicitudExcel(item) {
            return {
                id: this.codigoTicket(item),
                estado: item?.estado || item?.estado_reporte || item?.estado_asignacion || "Abierto",
                tipo: item?.nombre_tipo_asignacion || "",
                modulo: item?.nombre_modulo || "",
                empresa: item?.nombre_cliente || "",
                persona: item?.nombre_consultor || "",
                email: item?.email_consultor || "",
                caso_cliente: this.casoCliente(item),
                caso_interno: this.casoInterno(item),
                fecha_inicio: this.formatDate(item?.fecha_inicio || item?.asignacion_fecha_inicio || item?.fecha_reporte || ""),
                fecha_fin: this.formatDate(item?.fecha_fin || item?.asignacion_fecha_fin || item?.fecha_cierre_mesa_fab || ""),
                horas: Number(item?.horas_reportadas || 0) || "",
                dias: Number(item?.cantidad_dias_reportados || 0) || "",
                total: Number(item?.total_cobrar || 0) || "",
                observacion: item?.observacion_ticket || item?.asignacion_observacion || ""
            };
        },

        columnasExcel() {
            return [
                { key: "id", label: "ID", width: 95 },
                { key: "estado", label: "Estado", width: 95 },
                { key: "tipo", label: "Tipo", width: 130 },
                { key: "modulo", label: "Modulo", width: 130 },
                { key: "empresa", label: "Empresa", width: 170 },
                { key: "persona", label: "Persona", width: 170 },
                { key: "email", label: "Email", width: 190 },
                { key: "caso_cliente", label: "Caso cliente", width: 125 },
                { key: "caso_interno", label: "Caso interno", width: 125 },
                { key: "fecha_inicio", label: "Fecha inicio", width: 95 },
                { key: "fecha_fin", label: "Fecha fin", width: 95 },
                { key: "horas", label: "Horas", width: 70, type: "Number" },
                { key: "dias", label: "Dias", width: 70, type: "Number" },
                { key: "total", label: "Total", width: 95, type: "Number", money: true },
                { key: "observacion", label: "Observacion", width: 240 }
            ];
        },

        generarExcel(rows, sheetName, filename) {
            const columnas = this.columnasExcel();
            const safeSheet = this.escapeXml(String(sheetName || "Solicitudes").slice(0, 31));
            const header = columnas
                .map((c) => `<Cell ss:StyleID="header"><Data ss:Type="String">${this.escapeXml(c.label)}</Data></Cell>`)
                .join("");
            const body = rows.map((row) => {
                const cells = columnas.map((col) => this.excelCell(row[col.key], col));
                return `<Row>${cells.join("")}</Row>`;
            }).join("");
            const widths = columnas.map((c) => `<Column ss:Width="${c.width || 100}"/>`).join("");
            const xml =
                `<?xml version="1.0"?>` +
                `<?mso-application progid="Excel.Sheet"?>` +
                `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
                `xmlns:o="urn:schemas-microsoft-com:office:office" ` +
                `xmlns:x="urn:schemas-microsoft-com:office:excel" ` +
                `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
                `<Styles>` +
                `<Style ss:ID="header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#16A34A" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center"/></Style>` +
                `<Style ss:ID="money"><NumberFormat ss:Format="Currency"/></Style>` +
                `</Styles>` +
                `<Worksheet ss:Name="${safeSheet}"><Table>${widths}<Row>${header}</Row>${body}</Table></Worksheet>` +
                `</Workbook>`;
            this.descargarArchivo(xml, filename);
        },

        excelCell(value, col) {
            if (value === null || value === undefined || value === "") {
                return `<Cell><Data ss:Type="String"></Data></Cell>`;
            }
            if (col.type === "Number" && Number.isFinite(Number(value))) {
                const style = col.money ? ` ss:StyleID="money"` : "";
                return `<Cell${style}><Data ss:Type="Number">${Number(value)}</Data></Cell>`;
            }
            return `<Cell><Data ss:Type="String">${this.escapeXml(value)}</Data></Cell>`;
        },

        descargarArchivo(content, filename) {
            const blob = new Blob([content], { type: "application/vnd.ms-excel;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        },

        nombreArchivoSolicitudes(tipo) {
            const label = {
                mesa: "Mesa_Servicio",
                fabrica: "Fabrica",
                general: "General"
            }[tipo] || "General";
            const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
            const base = this.modalExport.fecha_inicio || this.toDateInput(new Date());
            const [year, month] = base.split("-");
            const mes = meses[Math.max(0, Math.min(11, Number(month || 1) - 1))];
            return `Solicitudes_${label}_${mes}_${year}.xls`;
        },

        tipoExportLabel(tipo) {
            if (tipo === "mesa") return "Mesa de Servicio";
            if (tipo === "fabrica") return "Fabrica";
            return "General";
        },

        escapeXml(value) {
            return String(value ?? "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&apos;");
        },

        codigoTicket(item) {
            const tipo = this.normalizeTipo(item?.nombre_tipo_asignacion || "");
            const compacto = tipo.replace(/\s+/g, "");
            const esFabrica = tipo.includes("fabrica");
            const esMesa =
                tipo.includes("mesa") ||
                tipo.includes("service desk") ||
                compacto.includes("servicedesk");
            const prefijo = esFabrica ? "FB" : (esMesa ? "MS" : "RH");
            const base = String(item?.id || "")
                .replace(/-/g, "")
                .toUpperCase()
                .slice(0, 8);
            return `${prefijo}-${base || "SINCOD"}`;
        }
    };
};
