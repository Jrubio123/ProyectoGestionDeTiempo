// js/asignacion-fabrica-mesa-servicio.js
const MAX_TICKETS_POR_ASIGNACION = 200;

window.mesaFabricaApp = function () {
    return {
        API: window.API_BASE || "http://localhost:4000",
        tickets: [],
        modalOpen: false,
        solicitudesOpen: false,
        esAsociado: false,

        form: {
            id: null,
            reporte_id: null,
            nro_caso_interno: "",
            nro_caso_cliente: "",
            tipo_servicio: "",
            wricef: "",
            requerimiento: "",
            perfil_fabrica: "",
            estado: "",
            estado_ticket: "",
            tipo_asignacion: "",
            scope_mesa_fabrica: "",
            estado_mesa_servicio: "",
            estado_fabrica: "",
            observacion: "",
            fecha_inicio: "",
            fecha_cierre: "",
            horas_reportadas: null,
            total_cobrar: null,
            valor_hora: null
        },

        async init() {
            this.esAsociado = Boolean(window.auth?.isAsociado?.());
            await this.cargarTickets();
        },

        async cargarTickets() {
            try {
                const res = await axios.get(`${this.API}/mesa-fabrica`);
                this.tickets = res.data || [];
            } catch (e) {
                this.tickets = [];
            }
        },

        editarTicket(item) {
            const rawEstadoTicket = this.getEstadoTicket(item);
            const estadoTicket = this.mapEstadoTicketToUi(item, rawEstadoTicket);
            const horasBase = Number(item?.horas_reportadas || 0);
            const totalBase = Number(item?.total_cobrar || 0);
            const tarifaInferida = horasBase > 0 ? (totalBase / horasBase) : 0;
            const perfilAsignado = this.getPerfilFabricaAsignado(item);
            this.form = {
                ...item,
                reporte_id: item?.reporte_id || null,
                estado_ticket: estadoTicket,
                tipo_asignacion: item?.tipo_asignacion || "",
                scope_mesa_fabrica: this.getScope(item),
                fecha_inicio: this.toDateInputValue(item?.fecha_ingreso_reporte || item?.fecha_inicio),
                fecha_cierre: this.toDateInputValue(item?.fecha_cierre_mesa_fab || item?.fecha_fin),
                observacion: item?.observacion_mesa_fabrica || item?.observacion || "",
                wricef: item?.wricef || "",
                requerimiento: item?.requerimiento || "",
                perfil_fabrica: perfilAsignado || "",
                horas_reportadas: item?.horas_reportadas ?? null,
                total_cobrar: this.esAsociado ? null : (item?.total_cobrar ?? null),
                valor_hora: item?.valor_hora ?? tarifaInferida ?? null
            };
            this.recalcularTotalForm();
            this.solicitudesOpen = false;
            this.modalOpen = true;
        },

        crearSolicitud(item) {
            if (!this.canCreateSolicitud(item)) {
                if (!this.isAsignacionOperable(item)) {
                    alert("La asignación está cerrada y no permite nuevos reportes.");
                    return;
                }
                alert("Se alcanzó el máximo de tickets para esta asignación.");
                return;
            }
            const scope = this.getScope(item);
            const perfilAsignado = this.getPerfilFabricaAsignado(item);
            this.form = {
                id: item.id,
                reporte_id: null,
                tipo_asignacion: item?.tipo_asignacion || "",
                tipo_asignacion_id: item?.tipo_asignacion_id || null,
                scope_mesa_fabrica: scope,
                nombre_modulo: item?.nombre_modulo || "",
                nro_caso_interno: "",
                nro_caso_cliente: "",
                tipo_servicio: "Servicio",
                wricef: "",
                requerimiento: "",
                perfil_fabrica: perfilAsignado || "",
                estado: item?.estado || "",
                estado_ticket: "",
                estado_mesa_servicio: "",
                estado_fabrica: "",
                observacion: "",
                fecha_inicio: this.todayDate(),
                fecha_cierre: "",
                horas_reportadas: null,
                total_cobrar: this.esAsociado ? null : 0,
                valor_hora: Number(item?.valor_hora || 0) || null
            };
            if (scope === "fabrica") {
                this.form.tipo_servicio = "";
            }
            this.solicitudesOpen = false;
            this.modalOpen = true;
        },

        async cerrarTicket(item) {
            return this.enviarTicket(item);
        },

        async enviarTicket(item) {
            if (!this.isAsignacionOperable(item)) {
                alert("La asignación está cerrada y no permite nuevos reportes.");
                return;
            }
            if (item?.estado_reporte === "Pendiente" || item?.estado_reporte === "Aprobado") {
                alert("Este ticket no se puede reenviar en este estado.");
                return;
            }
            const validacion = this.validarTicket(item);
            if (!validacion.ok) {
                alert(validacion.error);
                return;
            }
            if (!confirm("¿Enviar ticket a aprobación del coordinador?")) return;
            try {
                const scope = this.getScope(item);
                const esMesa = scope === "mesa";
                const estadoTicket = this.getEstadoTicket(item);
                const perfilAsignado = scope === "fabrica" ? this.getPerfilFabricaAsignado(item) : "";
                const fechaIngreso = this.resolveFechaIngreso(item, scope === "fabrica");
                await axios.post(`${this.API}/mesa-fabrica/${item.id}/enviar-aprobacion`, {
                    reporte_id: item.reporte_id || null,
                    scope,
                    fecha_inicio: fechaIngreso || null,
                    tipo_servicio: esMesa ? (item.tipo_servicio || null) : null,
                    nro_caso_cliente: esMesa ? (item.nro_caso_cliente || null) : null,
                    nro_caso_interno: esMesa ? (item.nro_caso_interno || null) : null,
                    nro_caso_int_ext: esMesa ? (item.nro_caso_cliente || item.nro_caso_interno || null) : null,
                    observacion_mesa_fabrica: item.observacion_mesa_fabrica || item.observacion || null,
                    fecha_cierre_mesa_fab: this.toDateInputValue(item.fecha_cierre_mesa_fab || item.fecha_fin),
                    total_cobrar: this.esAsociado ? null : (item.total_cobrar || null),
                    horas_reportadas: item.horas_reportadas || null,
                    requerimiento: item.requerimiento || null,
                    perfil_fabrica: scope === "fabrica" ? (perfilAsignado || null) : null,
                    wricef: item.wricef || null,
                    estado_mesa_servicio: scope === "mesa" ? (estadoTicket || null) : null,
                    estado_fabrica: scope === "fabrica" ? (estadoTicket || null) : null
                });
                alert("Ticket enviado a aprobación.");
                await this.cargarTickets();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al enviar ticket";
                alert(msg);
            }
        },

        async abrirSolicitudes() {
            await this.cargarTickets();
            this.solicitudesOpen = true;
        },

        async guardarCambios() {
            try {
                if (!this.isAsignacionOperable(this.form)) {
                    alert("La asignación está cerrada y no permite nuevos reportes.");
                    return;
                }
                const scope = this.getScope(this.form);
                const shouldClose = this.shouldShowFechaCierre();
                const validacion = this.validarTicket(this.form);
                if (!validacion.ok) {
                    alert(validacion.error);
                    return;
                }
                const perfilAsignado = scope === "fabrica" ? this.getPerfilFabricaAsignado(this.form) : "";
                const payload = {
                    ...this.form,
                    scope,
                    total_cobrar: this.esAsociado ? null : (this.form.total_cobrar || null),
                    tipo_servicio: scope === "mesa" ? (this.form.tipo_servicio || null) : null,
                    estado_mesa_servicio: scope === "mesa" ? (this.form.estado_ticket || null) : null,
                    estado_fabrica: scope === "fabrica" ? (this.form.estado_ticket || null) : null,
                    nro_caso_cliente: scope === "mesa" ? (this.form.nro_caso_cliente || null) : null,
                    nro_caso_interno: scope === "mesa" ? (this.form.nro_caso_interno || null) : null,
                    wricef: scope === "fabrica" ? (this.form.wricef || null) : null,
                    requerimiento: scope === "fabrica" ? (this.form.requerimiento || null) : null,
                    perfil_fabrica: scope === "fabrica" ? (perfilAsignado || null) : null,
                    fecha_inicio: this.resolveFechaIngreso(this.form, scope === "fabrica"),
                    fecha_cierre: shouldClose ? this.toDateInputValue(this.form.fecha_cierre) : null
                };
                await axios.put(`${this.API}/mesa-fabrica/${this.form.id}`, payload);
                alert("Ticket actualizado");
                this.modalOpen = false;
                await this.cargarTickets();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error guardando";
                alert(msg);
            }
        },

        mapEstadoTicketToUi(item, value) {
            const scope = this.getScope(item);
            const estadoNorm = this.normalizeTipo(value);
            if (scope === "fabrica" && (estadoNorm === "enproceso" || estadoNorm === "endesarrollo")) {
                return "En desarrollo";
            }
            return value || "";
        },

        validarTicket(item) {
            const scope = this.getScope(item);
            const estado = String(item?.estado_ticket || this.getEstadoTicket(item) || "").trim();
            const fechaIngreso = this.resolveFechaIngreso(item, scope === "fabrica");
            const fechaCierre = String(item?.fecha_cierre || item?.fecha_cierre_mesa_fab || "").trim();
            const horas = Number(item?.horas_reportadas || 0);

            if (!estado) return { ok: false, error: "Debes seleccionar un estado." };
            if (!fechaIngreso) return { ok: false, error: "Debes indicar la fecha de ingreso." };
            if (!(horas > 0)) return { ok: false, error: "Debes indicar horas mayores a 0." };

            if (scope === "mesa") {
                if (!String(item?.nro_caso_cliente || "").trim()) {
                    return { ok: false, error: "Debes indicar el número de caso cliente." };
                }
                if (!String(item?.nro_caso_interno || "").trim()) {
                    return { ok: false, error: "Debes indicar el número de caso interno." };
                }
                if (!String(item?.tipo_servicio || "").trim()) {
                    return { ok: false, error: "Debes seleccionar el tipo de servicio." };
                }
                if (estado === "Cerrado" && !fechaCierre) {
                    return { ok: false, error: "Debes indicar fecha de cierre cuando el estado es Cerrado." };
                }
            }

            if (scope === "fabrica") {
                if (!String(item?.wricef || "").trim()) {
                    return { ok: false, error: "Debes indicar WRICEF." };
                }
                if (!String(item?.requerimiento || "").trim()) {
                    return { ok: false, error: "Debes indicar el nombre del requerimiento." };
                }
                const perfilAsignado = this.getPerfilFabricaAsignado(item);
                if (!perfilAsignado) {
                    return { ok: false, error: "Debes seleccionar el perfil de fábrica." };
                }
                if (estado === "Finalizado" && !fechaCierre) {
                    return { ok: false, error: "Debes indicar fecha de cierre cuando el estado es Finalizado." };
                }
            }

            return { ok: true };
        },

        normalizeTipo(tipo) {
            return String(tipo || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .trim();
        },

        normalizeEstadoAsignacion(value) {
            return String(value || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .trim();
        },

        isAsignacionOperable(item = null) {
            const id = item?.id || this.form?.id || null;
            const estadoOrigen = item?.estado || this.form?.estado || (id ? (this.tickets || []).find((t) => t.id === id)?.estado : "");
            const estado = this.normalizeEstadoAsignacion(estadoOrigen);
            return estado === "abierto" || estado === "proceso";
        },

        canCreateSolicitud(item) {
            return this.isAsignacionOperable(item) && this.countTicketsByAsignacion(item) < MAX_TICKETS_POR_ASIGNACION;
        },

        countTicketsByAsignacion(item) {
            const id = item?.id;
            if (!id) return 0;
            return (this.tickets || []).filter((t) => t.id === id && Boolean(t?.reporte_id)).length;
        },

        normalizeScope(value) {
            const norm = this.normalizeTipo(value);
            if (norm === "mesa") return "mesa";
            if (norm === "fabrica") return "fabrica";
            return "";
        },

        getScope(item) {
            const source = item || this.form;
            const explicitScope = this.normalizeScope(source?.scope_mesa_fabrica);
            if (explicitScope) return explicitScope;

            const tipo = this.normalizeTipo(source?.tipo_asignacion || "");
            const tipoCompacto = tipo.replace(/\s+/g, "");
            const hasMesaByTipo =
                tipo.includes("mesa") ||
                tipo.includes("service desk") ||
                tipoCompacto.includes("servicedesk");
            const hasFabricaByTipo = tipo.includes("fabrica");
            if (hasFabricaByTipo && !hasMesaByTipo) return "fabrica";
            if (hasMesaByTipo && !hasFabricaByTipo) return "mesa";

            const hasFabricaHints = Boolean(
                String(source?.estado_fabrica || "").trim() ||
                String(source?.wricef || "").trim() ||
                String(source?.requerimiento || "").trim() ||
                String(source?.perfil_fabrica || "").trim()
            );
            const hasMesaHints = Boolean(
                String(source?.estado_mesa_servicio || "").trim() ||
                String(source?.nro_caso_cliente || "").trim() ||
                String(source?.nro_caso_interno || "").trim() ||
                String(source?.tipo_servicio || "").trim()
            );
            if (hasFabricaHints && !hasMesaHints) return "fabrica";
            if (hasMesaHints && !hasFabricaHints) return "mesa";
            if (hasFabricaHints) return "fabrica";
            if (hasMesaHints) return "mesa";
            if (hasFabricaByTipo) return "fabrica";
            return "mesa";
        },

        isMesa(item = null) {
            return this.getScope(item || this.form) === "mesa";
        },

        isFabrica(item = null) {
            return this.getScope(item || this.form) === "fabrica";
        },

        perfilFabricaOptions() {
            return ["ABAP", "ABAP TM", "PI/PO", "CPI", "FIORI", "WF", "DATASERVICE", "DATASPHERE"];
        },

        getPerfilFabricaAsignado(item = null) {
            const source = item || this.form;
            const actual = this.normalizePerfilFabrica(source?.perfil_fabrica);
            if (actual) return actual;
            const asignacionId = source?.id;
            if (!asignacionId) return "";
            for (const ticket of this.tickets || []) {
                if (String(ticket?.id || "") !== String(asignacionId)) continue;
                const perfil = this.normalizePerfilFabrica(ticket?.perfil_fabrica);
                if (perfil) return perfil;
            }
            return "";
        },

        perfilFabricaBloqueado() {
            const asignacionId = this.form?.id;
            if (!asignacionId) return false;
            for (const ticket of this.tickets || []) {
                if (String(ticket?.id || "") !== String(asignacionId)) continue;
                if (this.normalizePerfilFabrica(ticket?.perfil_fabrica)) return true;
            }
            return false;
        },

        normalizePerfilFabrica(value) {
            const raw = String(value || "").trim();
            if (!raw) return "";
            const norm = raw
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/\s+/g, "")
                .toUpperCase()
                .trim();
            const byNorm = new Map(this.perfilFabricaOptions().map((opt) => [
                String(opt).replace(/\s+/g, "").toUpperCase(),
                opt
            ]));
            return byNorm.get(norm) || "";
        },

        estadoOptions() {
            const scope = this.getScope(this.form);
            if (scope === "fabrica") return ["En desarrollo", "Finalizado"];
            return ["Cerrado", "En proceso", "Transferido Silver", "Transferido Corona"];
        },

        shouldShowFechaCierre() {
            const scope = this.getScope(this.form);
            const value = String(this.form?.estado_ticket || "");
            if (scope === "fabrica") return value === "Finalizado";
            return value === "Cerrado";
        },

        getEstadoTicket(item) {
            const scope = this.getScope(item);
            if (scope === "fabrica") return item?.estado_fabrica || "";
            return item?.estado_mesa_servicio || "";
        },

        recalcularTotalForm() {
            if (this.esAsociado) {
                this.form.total_cobrar = null;
                return;
            }
            const horas = Number(this.form?.horas_reportadas || 0);
            const tarifa = Number(this.form?.valor_hora || 0);
            if (horas > 0 && tarifa > 0) {
                this.form.total_cobrar = horas * tarifa;
                return;
            }
            this.form.total_cobrar = 0;
        },

        formatMoney(v) {
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency: "COP",
                minimumFractionDigits: 0,
                maximumFractionDigits: 2
            }).format(Number(v || 0));
        },

        formatDate(d) {
            return d ? String(d).split("T")[0] : "";
        },

        resolveFechaIngreso(item, fallbackToday = false) {
            const candidatos = [
                item?.fecha_inicio,
                item?.fecha_ingreso_reporte,
                item?.created_at
            ];
            for (const valor of candidatos) {
                const parsed = this.toDateInputValue(valor);
                if (parsed) return parsed;
            }
            return fallbackToday ? this.todayDate() : "";
        },

        toDateInputValue(value) {
            const raw = String(value || "").trim();
            if (!raw) return "";
            const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
            if (match && match[1]) return match[1];
            const parsed = new Date(raw);
            if (Number.isNaN(parsed.getTime())) return "";
            return parsed.toISOString().slice(0, 10);
        },

        codigoTicket(item) {
            const scope = this.getScope(item);
            const base = String(item?.reporte_id || item?.id || "")
                .replace(/-/g, "")
                .toUpperCase()
                .slice(0, 8);
            const prefijo = scope === "fabrica" ? "FB" : "MS";
            return `${prefijo}-${base || "SINCOD"}`;
        },

        ticketCasoTexto(item) {
            const caso = String(item?.nro_caso_cliente || item?.nro_caso_interno || "").trim();
            if (caso) return caso;
            const refFabrica = String(item?.wricef || item?.requerimiento || "").trim();
            if (refFabrica) return refFabrica;
            return "---";
        },

        todayDate() {
            const d = new Date();
            const m = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            return `${d.getFullYear()}-${m}-${day}`;
        },

        estadoAprobacionLabel(item) {
            if (item?.estado_reporte === "Pendiente") return "En revisión";
            if (item?.estado_reporte === "Rechazado") return "Rechazado";
            if (item?.estado_reporte === "Aprobado") return "Aprobado";
            return "Borrador";
        },

        estadoBadgeClass(item) {
            const estado = String(item?.estado_reporte || "").toLowerCase();
            if (estado === "pendiente") return "bg-amber-100 text-amber-700 border-amber-200";
            if (estado === "rechazado") return "bg-red-100 text-red-700 border-red-200";
            if (estado === "aprobado") return "bg-emerald-100 text-emerald-700 border-emerald-200";
            return "bg-slate-100 text-slate-700 border-slate-200";
        },

        get solicitudesPorEnviar() {
            return (this.tickets || []).filter((t) => {
                const estado = String(t?.estado_reporte || "").toLowerCase();
                return Boolean(t?.reporte_id) && (estado === "rechazado" || estado === "revisión" || estado === "revision");
            });
        },

        get solicitudesEnviadas() {
            return (this.tickets || []).filter((t) =>
                Boolean(t?.reporte_id) && String(t?.estado_reporte || "").toLowerCase() === "pendiente"
            );
        },

        get assignmentCards() {
            const map = new Map();
            for (const row of this.tickets || []) {
                if (!map.has(row.id)) map.set(row.id, row);
            }
            return Array.from(map.values());
        },

        canEdit(item) {
            const estado = String(item?.estado_reporte || "").toLowerCase();
            return this.isAsignacionOperable(item) &&
                Boolean(item?.reporte_id) &&
                (estado === "rechazado" || estado === "revisión" || estado === "revision");
        },

        canSend(item) {
            const estado = String(item?.estado_reporte || "").toLowerCase();
            return this.isAsignacionOperable(item) &&
                Boolean(item?.reporte_id) &&
                (estado === "rechazado" || estado === "revisión" || estado === "revision");
        }
    };
};
