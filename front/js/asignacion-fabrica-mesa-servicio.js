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
            if (!confirm("¿Deseas cerrar este ticket? Se enviará a aprobación.")) return;
            this.form = {
                ...item,
                estado: "Cerrado",
                fecha_cierre: new Date().toISOString().split("T")[0]
            };
            await this.guardarCambios();
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
        }
    };
};
