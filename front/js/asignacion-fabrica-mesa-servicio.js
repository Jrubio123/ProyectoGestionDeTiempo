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
            observacion: "",
            fecha_cierre: ""
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
            this.form = { ...item };
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
                await axios.post(`${this.API}/mesa-fabrica/${item.id}/enviar-aprobacion`, {
                    tipo_servicio: item.tipo_servicio || null,
                    nro_caso_int_ext: item.nro_caso_cliente || item.nro_caso_interno || null,
                    observacion_mesa_fabrica: item.observacion || null,
                    fecha_cierre_mesa_fab: item.fecha_fin || null,
                    total_cobrar: item.total_cobrar || null,
                    horas_reportadas: item.horas_reportadas || null
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
                await axios.put(`${this.API}/mesa-fabrica/${this.form.id}`, this.form);
                alert("Ticket actualizado");
                this.modalOpen = false;
                await this.cargarTickets();
            } catch (e) {
                alert("Error guardando");
            }
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
