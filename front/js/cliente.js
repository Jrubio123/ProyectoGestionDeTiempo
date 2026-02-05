// js/cliente.js
// Asegúrate de que esté disponible en el scope global
window.clientesApp = function() {
    const API = "http://localhost:4000";

    return {
        clientes: [],
        form: {
            id: null,
            titulo: '',
            nit: '',
            prefijo: '',
            correlativo: ''
        },
        errors: {},

        async init() {
            console.log('Inicializando clientesApp');
            await this.cargarClientes();
        },

        async cargarClientes() {
            try {
                console.log('Cargando clientes...');
                const res = await axios.get(`${API}/clientes`);
                this.clientes = res.data;
                console.log('Clientes cargados:', this.clientes.length);
            } catch (error) {
                console.error('Error cargando clientes:', error);
                alert('Error al cargar clientes');
            }
        },

        async guardarCliente() {
            if (!this.formValido) {
                alert('Complete los campos requeridos correctamente');
                return;
            }

            try {
                if (this.form.id) {
                    // EDITAR
                    await axios.put(
                        `${API}/clientes/${this.form.id}`,
                        this.form
                    );
                    alert('Cliente actualizado correctamente');
                } else {
                    // CREAR
                    await axios.post(
                        `${API}/clientes`,
                        this.form
                    );
                    alert('Cliente creado correctamente');
                }

                await this.cargarClientes();
                this.nuevoCliente();
            } catch (error) {
                console.error('Error guardando cliente:', error);
                const errorMsg = error.response?.data?.error || 'Error al guardar cliente';
                alert(errorMsg);
            }
        },

        editarCliente(cliente) {
            this.form = {
                id: cliente.id,
                titulo: cliente.titulo,
                nit: cliente.nit,
                prefijo: cliente.prefijo || '',
                correlativo: cliente.correlativo || ''
            };
            this.errors = {};
        },

        async eliminarCliente(id) {
            if (!confirm("¿Está seguro de eliminar este cliente?")) return;

            try {
                await axios.delete(`${API}/clientes/${id}`);
                await this.cargarClientes();
                alert('Cliente eliminado correctamente');
            } catch (error) {
                console.error('Error eliminando cliente:', error);
                if (error.response?.data?.tiene_consultorias) {
                    alert('No se puede eliminar: el cliente tiene consultorías asociadas');
                } else {
                    alert('Error al eliminar cliente');
                }
            }
        },

        nuevoCliente() {
            this.form = {
                id: null,
                titulo: '',
                nit: '',
                prefijo: '',
                correlativo: ''
            };
            this.errors = {};
        },

        validarTitulo() {
            if (!this.form.titulo.trim()) {
                this.errors.titulo = "El nombre es requerido";
                return;
            }

            const existe = this.clientes.some(c =>
                c.titulo.toLowerCase() === this.form.titulo.toLowerCase() &&
                c.id !== this.form.id
            );

            this.errors.titulo = existe ? "Cliente ya existe" : "";
        },

        validarNit() {
            if (!this.form.nit.trim()) {
                this.errors.nit = "El NIT es requerido";
                return;
            }

            const existe = this.clientes.some(c =>
                c.nit === this.form.nit &&
                c.id !== this.form.id
            );

            this.errors.nit = existe ? "NIT ya existe" : "";
        },

        get formValido() {
            return this.form.titulo.trim() &&
                   this.form.nit.trim() &&
                   !this.errors.titulo &&
                   !this.errors.nit;
        }
    };
};