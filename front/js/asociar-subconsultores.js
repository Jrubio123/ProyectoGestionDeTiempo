// js/asociar-subconsultores.js
document.addEventListener("alpine:init", () => {
    Alpine.data("subConsultoresApp", () => ({
        API: "http://localhost:4000",

        principal: { id: 3, nombre: "Juan Principal" },
        consultores: [],
        modal: { open: false, isEdit: false },

        form: {
            id: null,
            nombre_usuario: "",
            email: "",
            telefono: "",
            direccion: "",
            cedula: "",
            tipo_documento: "CC",
            banco: "",
            tipo_cuenta: "Ahorros",
            nro_cuenta_bancaria: "",
            moneda_cobro: "COP"
        },

        async init() {
            if (window.auth) {
                const user = window.auth.getUser();
                if (user) this.principal = user;
            }
            await this.cargarConsultores();
        },

        async cargarConsultores() {
            try {
                const res = await axios.get(`${this.API}/sub-consultores/${this.principal.id}`);
                this.consultores = res.data || [];
            } catch (e) {
                this.consultores = [];
                console.error(e);
            }
        },

        abrirModal() {
            this.modal = { open: true, isEdit: false };
            this.resetForm();
        },

        editar(c) {
            this.modal = { open: true, isEdit: true };
            this.form = { ...c };
        },

        async guardar() {
            try {
                const payload = { ...this.form, id_principal: this.principal.id };
                if (this.modal.isEdit) {
                    await axios.put(`${this.API}/sub-consultores/${this.form.id}`, payload);
                } else {
                    await axios.post(`${this.API}/sub-consultores`, payload);
                }
                alert("Guardado correctamente");
                this.modal.open = false;
                await this.cargarConsultores();
            } catch (e) {
                alert("Error al guardar");
            }
        },

        async eliminar(c) {
            if (!confirm(`¿Desvincular a ${c.nombre_usuario}?`)) return;
            try {
                await axios.delete(`${this.API}/sub-consultores/${c.id}`);
                await this.cargarConsultores();
            } catch (e) {
                alert("Error al eliminar");
            }
        },

        resetForm() {
            this.form = {
                id: null,
                nombre_usuario: "",
                email: "",
                telefono: "",
                direccion: "",
                cedula: "",
                tipo_documento: "CC",
                banco: "",
                tipo_cuenta: "Ahorros",
                nro_cuenta_bancaria: "",
                moneda_cobro: "COP"
            };
        }
    }));
});
