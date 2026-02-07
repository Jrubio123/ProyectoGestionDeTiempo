// js/asignacion-fabrica-mesa-servicio.js
document.addEventListener("alpine:init", () => {
    Alpine.data("mesaFabricaApp", () => ({
        API: "http://localhost:4000",

        usuario: { id: 3 },
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
                const res = await axios.get(`${this.API}/mesa-fabrica/${this.usuario.id}`);
                this.tickets = res.data || [];
            } catch (e) {
                this.tickets = [
                    {
                        id: 1,
                        tipo_asignacion: "Mesa de servicio",
                        nombre_cliente: "Prebel S.A.",
                        nombre_modulo: "SAP FI",
                        nro_caso_interno: "INT-001",
                        nro_caso_cliente: "REQ-999",
                        estado: "Abierto",
                        fecha_inicio: "2023-10-01",
                        nombre_coordinador: "Ana Coord"
                    }
                ];
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
            return d ? d.split("T")[0] : "";
        }
    }));
});
