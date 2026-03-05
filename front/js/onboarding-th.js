// js/onboarding-th.js
window.onboardingThApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    const emptyS3 = () => ({
        direccion: "",
        tipo_persona: "Natural",
        banco_id: "",
        tipo_cuenta: "Ahorros",
        numero_cuenta: "",
        correo_silver: ""
    });

    return {
        preregistros: [],
        bancos: [],
        filtro: "Todos",
        modalDetalle: false,
        modalAnular: false,
        guardandoS3: false,
        aprobando: false,
        anulando: false,
        itemActivo: null,
        formS3: emptyS3(),
        motivoAnulacion: "",

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async init() {
            await Promise.all([this.cargarBancos(), this.cargarPreregistros()]);
        },

        async cargarBancos() {
            try {
                const res = await axios.get(`${API}/bancos`, this.getAuthConfig());
                this.bancos = res.data || [];
            } catch (e) {
                this.bancos = [];
            }
        },

        async cargarPreregistros() {
            try {
                const res = await axios.get(`${API}/api/preregistros?limit=400&page=1`, this.getAuthConfig());
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
            if (estado === "Pendiente Revision TH") return "border-[#189fa9]";
            if (estado === "Pendiente Correo Silver") return "border-[#5a189a]";
            if (estado === "Completado") return "border-[#1c9b65]";
            if (estado === "Anulado") return "border-slate-300";
            return "border-slate-300";
        },

        badgeClass(estado) {
            if (estado === "Pendiente Coordinador") return "rrhh-badge-attention";
            if (estado === "Pendiente Revision TH") return "rrhh-badge-progress";
            if (estado === "Pendiente Correo Silver") return "rrhh-badge-structure";
            if (estado === "Completado") return "rrhh-badge-progress";
            return "rrhh-badge-neutral";
        },

        accionPrincipalLabel(p) {
            if (p.estado === "Pendiente Revision TH") return "Completar revisión";
            if (p.estado === "Pendiente Correo Silver") return "Ingresar correo Silver";
            return "Ver detalle";
        },

        accionPrincipalClass(p) {
            if (p.estado === "Pendiente Correo Silver") return "bg-[#5a189a] text-white hover:bg-[#4a137f]";
            if (p.estado === "Pendiente Revision TH") return "rrhh-btn-primary";
            return "rrhh-btn-ghost";
        },

        abrirDetalle(p, focoCorreo = false) {
            this.itemActivo = JSON.parse(JSON.stringify(p || {}));
            this.formS3 = {
                direccion: p?.direccion || "",
                tipo_persona: p?.tipo_persona || "Natural",
                banco_id: p?.banco?.id || "",
                tipo_cuenta: p?.tipo_cuenta || "Ahorros",
                numero_cuenta: p?.numero_cuenta || "",
                correo_silver: p?.correo_silver || ""
            };
            this.modalDetalle = true;
            if (focoCorreo) {
                setTimeout(() => document.getElementById("thCorreoSilver")?.focus(), 80);
            }
        },

        cerrarDetalle() {
            this.modalDetalle = false;
            this.modalAnular = false;
            this.itemActivo = null;
            this.formS3 = emptyS3();
            this.motivoAnulacion = "";
            this.guardandoS3 = false;
            this.aprobando = false;
            this.anulando = false;
        },

        get seccion3Editable() {
            const e = this.itemActivo?.estado;
            return e === "Pendiente Revision TH" || e === "Pendiente Correo Silver";
        },

        get s3BaseValida() {
            const f = this.formS3;
            return !!String(f.direccion || "").trim()
                && !!String(f.tipo_persona || "").trim()
                && !!String(f.banco_id || "").trim()
                && !!String(f.tipo_cuenta || "").trim()
                && !!String(f.numero_cuenta || "").trim();
        },

        get puedeAprobar() {
            if (!this.seccion3Editable || !this.s3BaseValida) return false;
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(this.formS3.correo_silver || "").trim());
        },

        async guardarS3() {
            if (!this.itemActivo?.id || !this.seccion3Editable) return;
            if (!this.s3BaseValida) {
                alert("Completa todos los campos requeridos de la sección 3.");
                return;
            }
            this.guardandoS3 = true;
            try {
                await axios.patch(
                    `${API}/api/preregistros/${this.itemActivo.id}/seccion-3`,
                    {
                        direccion: String(this.formS3.direccion || "").trim(),
                        tipo_persona: String(this.formS3.tipo_persona || "").trim(),
                        banco_id: this.formS3.banco_id,
                        tipo_cuenta: String(this.formS3.tipo_cuenta || "").trim(),
                        numero_cuenta: String(this.formS3.numero_cuenta || "").trim(),
                        correo_silver: String(this.formS3.correo_silver || "").trim() || null
                    },
                    this.getAuthConfig()
                );
                await this.cargarPreregistros();
                this.cerrarDetalle();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error guardando sección 3";
                alert(msg);
            } finally {
                this.guardandoS3 = false;
            }
        },

        async aprobarPreregistro() {
            if (!this.itemActivo?.id || !this.puedeAprobar) return;
            this.aprobando = true;
            try {
                await axios.post(`${API}/api/preregistros/${this.itemActivo.id}/aprobar`, {}, this.getAuthConfig());
                await this.cargarPreregistros();
                this.cerrarDetalle();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error aprobando preregistro";
                alert(msg);
            } finally {
                this.aprobando = false;
            }
        },

        abrirModalAnular() {
            this.modalAnular = true;
            this.motivoAnulacion = "";
        },

        async confirmarAnulacion() {
            if (!this.itemActivo?.id) return;
            if (String(this.motivoAnulacion || "").trim().length < 20) {
                alert("El motivo debe tener al menos 20 caracteres.");
                return;
            }
            this.anulando = true;
            try {
                await axios.post(
                    `${API}/api/preregistros/${this.itemActivo.id}/anular`,
                    { motivo_anulacion: String(this.motivoAnulacion || "").trim() },
                    this.getAuthConfig()
                );
                await this.cargarPreregistros();
                this.cerrarDetalle();
            } catch (e) {
                const msg = e?.response?.data?.error || "Error anulando preregistro";
                alert(msg);
            } finally {
                this.anulando = false;
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
