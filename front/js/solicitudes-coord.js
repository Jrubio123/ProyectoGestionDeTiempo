// js/solicitudes-coord.js
window.solicitudesCoordApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    const emptyS2 = () => ({
        responsable_supervisor: "",
        fecha_fin: "",
        moneda: "COP",
        pais_pago: "",
        tarifa_hora: "",
        tarifa_mes: "",
        tarifa_medio_tiempo: "",
        tarifa_capacitacion: "",
        vpn_corona: false,
        necesita_s_user: false,
        grupo_usuario: "",
        grupo_distribucion: "",
        observaciones: ""
    });

    return {
        preregistros: [],
        filtro: "Todos",
        modalDetalle: false,
        guardandoS2: false,
        itemActivo: null,
        formS2: emptyS2(),

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async init() {
            await this.cargarPreregistros();
        },

        async cargarPreregistros() {
            try {
                const res = await axios.get(`${API}/api/preregistros?limit=300&page=1`, this.getAuthConfig());
                this.preregistros = Array.isArray(res?.data?.data) ? res.data.data : [];
            } catch (e) {
                this.preregistros = [];
            }
        },

        get preregistrosFiltrados() {
            if (this.filtro === "Todos") return this.preregistros;
            return this.preregistros.filter((p) => p.estado === this.filtro);
        },

        estadoClass(estado) {
            if (estado === "Pendiente Coordinador") return "border-[#ff6000]";
            if (["Pendiente Revision TH", "Pendiente Correo Silver"].includes(estado)) return "border-[#189fa9]";
            return "border-slate-300";
        },

        badgeClass(estado) {
            if (estado === "Pendiente Coordinador") return "rrhh-badge-attention";
            if (["Pendiente Revision TH", "Pendiente Correo Silver"].includes(estado)) return "rrhh-badge-progress";
            return "rrhh-badge-neutral";
        },

        requiereAccionCoord(p) {
            return p?.estado === "Pendiente Coordinador";
        },

        abrirDetalle(p) {
            this.itemActivo = JSON.parse(JSON.stringify(p || {}));
            this.formS2 = {
                responsable_supervisor: p?.responsable_supervisor || "",
                fecha_fin: p?.fecha_fin ? String(p.fecha_fin).split("T")[0] : "",
                moneda: p?.moneda || "COP",
                pais_pago: p?.pais_pago || "",
                tarifa_hora: p?.tarifa_hora ?? "",
                tarifa_mes: p?.tarifa_mes ?? "",
                tarifa_medio_tiempo: p?.tarifa_medio_tiempo ?? "",
                tarifa_capacitacion: p?.tarifa_capacitacion ?? "",
                vpn_corona: Boolean(p?.vpn_corona),
                necesita_s_user: Boolean(p?.necesita_s_user),
                grupo_usuario: p?.grupo_usuario || "",
                grupo_distribucion: p?.grupo_distribucion || "",
                observaciones: p?.observaciones || ""
            };
            this.modalDetalle = true;
        },

        cerrarDetalle() {
            this.modalDetalle = false;
            this.itemActivo = null;
            this.formS2 = emptyS2();
            this.guardandoS2 = false;
        },

        get seccion2Editable() {
            return this.itemActivo?.estado === "Pendiente Coordinador";
        },

        get s2Valida() {
            const f = this.formS2;
            return !!String(f.responsable_supervisor || "").trim()
                && !!String(f.moneda || "").trim()
                && typeof f.vpn_corona === "boolean"
                && typeof f.necesita_s_user === "boolean";
        },

        async guardarS2() {
            if (!this.itemActivo?.id || !this.seccion2Editable) return;
            if (!this.s2Valida) {
                alert("Completa los campos requeridos de la sección 2.");
                return;
            }
            this.guardandoS2 = true;
            const payload = {
                ...this.formS2,
                responsable_supervisor: String(this.formS2.responsable_supervisor || "").trim(),
                fecha_fin: this.formS2.fecha_fin || null,
                moneda: String(this.formS2.moneda || "").trim(),
                pais_pago: String(this.formS2.pais_pago || "").trim() || null,
                tarifa_hora: this.formS2.tarifa_hora === "" ? null : Number(this.formS2.tarifa_hora),
                tarifa_mes: this.formS2.tarifa_mes === "" ? null : Number(this.formS2.tarifa_mes),
                tarifa_medio_tiempo: this.formS2.tarifa_medio_tiempo === "" ? null : Number(this.formS2.tarifa_medio_tiempo),
                tarifa_capacitacion: this.formS2.tarifa_capacitacion === "" ? null : Number(this.formS2.tarifa_capacitacion),
                grupo_usuario: String(this.formS2.grupo_usuario || "").trim() || null,
                grupo_distribucion: String(this.formS2.grupo_distribucion || "").trim() || null,
                observaciones: String(this.formS2.observaciones || "").trim() || null
            };

            try {
                await axios.patch(`${API}/api/preregistros/${this.itemActivo.id}/seccion-2`, payload, this.getAuthConfig());
                await this.cargarPreregistros();
                this.cerrarDetalle();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error guardando sección 2";
                alert(msg);
            } finally {
                this.guardandoS2 = false;
            }
        },

        formatFecha(fecha) {
            if (!fecha) return "-";
            const d = new Date(fecha);
            if (Number.isNaN(d.getTime())) return String(fecha);
            return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
        }
    };
};
