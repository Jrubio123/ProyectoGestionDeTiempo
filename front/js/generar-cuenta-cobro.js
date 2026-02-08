// js/generar-cuenta-cobro.js
window.cuentaCobroApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        registros: [],
        usuarioId: null,
        totalBackend: 0,
        monedaBackend: "",

        form: {
            fecha_inicio: "",
            fecha_fin: "",
            total_letras: "",
            ciudad_cobro: ""
        },

        files: {
            cuenta: null,
            seguridad: null
        },

        async init() {
            if (window.auth) {
                const u = window.auth.getUser();
                if (u) this.usuarioId = u.id;
            }
            await this.cargarRegistros();
        },

        async cargarRegistros() {
            try {
                const id = this.usuarioId || "";
                const res = await axios.get(`${API}/horas-por-cobrar/${id}`);
                this.registros = (res.data || []).map((r) => ({
                    ...r,
                    caso: r.nro_caso_int_ext || null,
                    checked: false
                }));
                this.actualizarPeriodo();
            } catch (e) {
                this.registros = [];
            }
        },

        get totalSeleccionado() {
            if (this.totalBackend > 0) return this.totalBackend;
            return this.registros
                .filter((r) => r.checked)
                .reduce((sum, r) => sum + parseFloat(r.total_cobrar || 0), 0);
        },

        get isValid() {
            return (
                this.totalSeleccionado > 0 &&
                this.form.fecha_inicio &&
                this.form.fecha_fin &&
                this.form.total_letras &&
                this.form.ciudad_cobro
            );
        },

        toggleAll() {
            const allChecked = this.registros.every((r) => r.checked);
            this.registros.forEach((r) => (r.checked = !allChecked));
            this.actualizarPeriodo();
            this.actualizarLetras();
        },

        actualizarPeriodo() {
            const sel = this.registros.filter((r) => r.checked);
            if (sel.length === 0) {
                this.form.fecha_inicio = "";
                this.form.fecha_fin = "";
                this.form.total_letras = "";
                this.totalBackend = 0;
                return;
            }
            const fechas = sel.map((r) => new Date(r.created_at)).filter((d) => !isNaN(d));
            if (fechas.length === 0) return;
            const min = new Date(Math.min(...fechas));
            const max = new Date(Math.max(...fechas));
            this.form.fecha_inicio = this.form.fecha_inicio || min.toISOString().split("T")[0];
            this.form.fecha_fin = this.form.fecha_fin || max.toISOString().split("T")[0];
        },

        async actualizarLetras() {
            const seleccionados = this.registros.filter((r) => r.checked).map((r) => r.id);
            if (seleccionados.length === 0 || !this.usuarioId) return;
            try {
                const res = await axios.post(`${API}/cuentas-cobro/preview`, {
                    consultor_id: this.usuarioId,
                    ids_reportes: seleccionados
                });
                this.totalBackend = Number(res.data?.total || 0);
                this.form.total_letras = res.data?.total_letras || "";
                if (res.data?.fecha_inicio) this.form.fecha_inicio = res.data.fecha_inicio;
                if (res.data?.fecha_fin) this.form.fecha_fin = res.data.fecha_fin;
                this.monedaBackend = res.data?.moneda || "";
            } catch (e) {
                // fallback: no bloquear si falla
                this.totalBackend = 0;
            }
        },

        async generarCuenta() {
            if (!confirm("¿Estás seguro de enviar esta cuenta de cobro?")) return;

            const seleccionados = this.registros.filter((r) => r.checked).map((r) => r.id);
            if (seleccionados.length === 0) return;

            const payload = {
                consultor_id: this.usuarioId,
                fecha_inicio: this.form.fecha_inicio,
                fecha_fin: this.form.fecha_fin,
                total_letras: this.form.total_letras,
                ciudad_cobro: this.form.ciudad_cobro,
                total_numeros: this.totalSeleccionado,
                ids_reportes: seleccionados
            };

            try {
                await axios.post(`${API}/cuentas-cobro`, payload);
                alert("Cuenta de Cobro enviada exitosamente");

                this.form = { fecha_inicio: "", fecha_fin: "", total_letras: "", ciudad_cobro: "" };
                this.files = { cuenta: null, seguridad: null };
                await this.cargarRegistros();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error al generar la cuenta";
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

        formatDate(d) {
            return d ? d.split("T")[0] : "";
        }
    };
};
