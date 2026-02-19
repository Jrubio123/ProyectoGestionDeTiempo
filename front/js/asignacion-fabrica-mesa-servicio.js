// js/asignacion-fabrica-mesa-servicio.js
window.mesaFabricaApp = function () {
    return {
        API: window.API_BASE || "http://localhost:4000",
        tickets: [],
        modalOpen: false,

        form: {
            id: null,
            nro_caso_interno: "",
            nro_caso_cliente: "",
            tipo_servicio: "",
            estado: "",
            estado_ticket: "",
            tipo_asignacion: "",
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
            const estadoTicket = this.getEstadoTicket(item);
            this.form = {
                ...item,
                estado_ticket: estadoTicket,
                tipo_asignacion: item?.tipo_asignacion || "",
                fecha_inicio: item?.fecha_inicio || "",
                fecha_cierre: item?.fecha_cierre_mesa_fab || item?.fecha_fin || "",
                observacion: item?.observacion_mesa_fabrica || item?.observacion || "",
                horas_reportadas: item?.horas_reportadas ?? null,
                total_cobrar: item?.total_cobrar ?? null,
                valor_hora: item?.valor_hora ?? null
            };
            this.recalcularTotalForm();
            this.modalOpen = true;
        },

        async cerrarTicket(item) {
            return this.enviarTicket(item);
        },

        async enviarTicket(item) {
            if (item?.estado_reporte === "Pendiente") {
                alert("Este ticket ya está en aprobación.");
                return;
            }
            if (!confirm("¿Enviar ticket a aprobación del coordinador?")) return;
            try {
                const scope = this.getScope(item);
                const estadoTicket = this.getEstadoTicket(item);
                await axios.post(`${this.API}/mesa-fabrica/${item.id}/enviar-aprobacion`, {
                    tipo_servicio: item.tipo_servicio || null,
                    nro_caso_int_ext: item.nro_caso_cliente || item.nro_caso_interno || null,
                    observacion_mesa_fabrica: item.observacion_mesa_fabrica || item.observacion || null,
                    fecha_cierre_mesa_fab: item.fecha_cierre_mesa_fab || item.fecha_fin || null,
                    total_cobrar: item.total_cobrar || null,
                    horas_reportadas: item.horas_reportadas || null,
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

        async guardarCambios() {
            try {
                const payload = {
                    ...this.form,
                    fecha_inicio: this.form.fecha_inicio || null,
                    fecha_cierre: this.form.fecha_cierre || null
                };
                await axios.put(`${this.API}/mesa-fabrica/${this.form.id}`, payload);
                alert("Ticket actualizado");
                this.modalOpen = false;
                await this.cargarTickets();
            } catch (e) {
                alert("Error guardando");
            }
        },

        normalizeTipo(tipo) {
            return String(tipo || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .trim();
        },

        getScope(item) {
            const tipo = this.normalizeTipo(item?.tipo_asignacion || this.form?.tipo_asignacion || "");
            if (tipo.includes("mesa de servicio")) return "mesa";
            if (tipo.includes("fabrica")) return "fabrica";
            return "mesa";
        },

        estadoOptions() {
            const scope = this.getScope(this.form);
            if (scope === "fabrica") return ["En Desarrollo", "Finalizado"];
            return ["Cerrado", "En Proceso", "Transferido Silver", "Transferido Corona"];
        },

        shouldShowFechaCierre() {
            const scope = this.getScope(this.form);
            const value = String(this.form?.estado_ticket || "");
            if (scope === "fabrica") return value === "Finalizado";
            return value === "Cerrado";
        },

        getEstadoTicket(item) {
            return item?.estado_mesa_servicio || item?.estado_fabrica || "";
        },

        recalcularTotalForm() {
            const horas = Number(this.form?.horas_reportadas || 0);
            const tarifa = Number(this.form?.valor_hora || 0);
            this.form.total_cobrar = horas > 0 && tarifa > 0 ? horas * tarifa : (this.form.total_cobrar || null);
        },

        formatMoney(v) {
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency: "COP",
                maximumFractionDigits: 0
            }).format(Number(v || 0));
        },

        formatDate(d) {
            return d ? String(d).split("T")[0] : "";
        },

        estadoAprobacionLabel(item) {
            if (item?.estado_reporte === "Pendiente") return "En revisión";
            if (item?.estado_reporte === "Rechazado") return "Rechazado";
            if (item?.estado_reporte === "Aprobado") return "Aprobado";
            return "Borrador";
        }
    };
};
