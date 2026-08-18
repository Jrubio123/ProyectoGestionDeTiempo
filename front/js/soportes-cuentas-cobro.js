window.soportesCuentasCobroApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        soportes: [],
        consultores: [],
        aprobadores: [],
        filtros: {
            consultor_id: "",
            coordinador_id: ""
        },
        loading: false,
        modalDocsOpen: false,
        docsActuales: [],
        docsCuentaId: "",
        reiniciandoCuentaId: "",

        async init() {
            await Promise.all([this.cargarConsultores(), this.cargarAprobadores(), this.cargarSoportes()]);
        },

        async cargarConsultores() {
            try {
                const res = await axios.get(`${API}/consultores`);
                this.consultores = Array.isArray(res.data) ? res.data : [];
            } catch (e) {
                this.consultores = [];
            }
        },

        async cargarAprobadores() {
            try {
                const res = await axios.get(`${API}/cuentas-cobro/aprobadores`);
                this.aprobadores = Array.isArray(res.data) ? res.data : [];
            } catch (e) {
                this.aprobadores = [];
            }
        },

        async cargarSoportes() {
            this.loading = true;
            try {
                const params = new URLSearchParams();
                if (this.filtros.consultor_id) params.set("consultor_id", this.filtros.consultor_id);
                if (this.filtros.coordinador_id) params.set("coordinador_id", this.filtros.coordinador_id);

                const query = params.toString();
                const url = `${API}/cuentas-cobro/soportes${query ? `?${query}` : ""}`;
                const res = await axios.get(url);
                this.soportes = Array.isArray(res.data) ? res.data : [];
            } catch (e) {
                this.soportes = [];
            } finally {
                this.loading = false;
            }
        },

        limpiarFiltros() {
            this.filtros.consultor_id = "";
            this.filtros.coordinador_id = "";
            this.cargarSoportes();
        },

        cuentaCorta(id) {
            return String(id || "").split("-")[0].toUpperCase();
        },

        getSoporteUrl(item, tipo) {
            const soporte = item?.datos_adjuntos?.soportes || {};
            const cuentaUrl =
                soporte?.cuenta_cobro_firmada?.url ||
                item?.datos_adjuntos?.firma?.documento_firmado?.url ||
                "";
            if (tipo === "cuenta") {
                return cuentaUrl;
            }
            if (tipo === "seguridad") {
                const seguridadUrl =
                    soporte?.seguridad_social?.url ||
                    soporte?.seguridad_social_firma?.url ||
                    soporte?.anexo_firma?.url ||
                    "";
                if (!seguridadUrl) return "";
                return seguridadUrl === cuentaUrl ? "" : seguridadUrl;
            }
            return "";
        },

        getDocumentosDeItem(item) {
            const soporte = item?.datos_adjuntos?.soportes || {};
            const manuales = Array.isArray(soporte.documentos_manuales) ? soporte.documentos_manuales : [];
            if (manuales.length) {
                return manuales
                    .filter((d) => d && d.url)
                    .map((d, idx) => ({
                        nombre: d.nombre || `Documento ${idx + 1}`,
                        url: d.url,
                        principal: Boolean(d.principal)
                    }));
            }
            // Cuentas legacy (Click&Sign / carga previa): reconstruir desde soportes conocidos.
            const docs = [];
            const cuentaUrl = this.getSoporteUrl(item, "cuenta");
            if (cuentaUrl) docs.push({ nombre: "Cuenta firmada", url: cuentaUrl, principal: true });
            const seguridadUrl = this.getSoporteUrl(item, "seguridad");
            if (seguridadUrl) docs.push({ nombre: "Seguridad social", url: seguridadUrl, principal: false });
            return docs;
        },

        verDocumentos(item) {
            this.docsActuales = this.getDocumentosDeItem(item);
            this.docsCuentaId = this.cuentaCorta(item?.id);
            this.modalDocsOpen = true;
        },

        cerrarModalDocs() {
            this.modalDocsOpen = false;
            this.docsActuales = [];
            this.docsCuentaId = "";
        },

        puedeReiniciarDocumentos() {
            const rol = String(window.auth?.getUser?.()?.rol || "").toLowerCase().trim();
            return ["administrador", "coordinador"].includes(rol);
        },

        async reiniciarDocumentos(item) {
            const cuentaId = String(item?.id || "").trim();
            if (!cuentaId || this.reiniciandoCuentaId) return;

            const cuentaCorta = this.cuentaCorta(cuentaId);
            const confirmado = window.confirm(
                `¿Seguro que quieres reiniciar los documentos de la cuenta #${cuentaCorta}?\n\n` +
                "El consultor podrá subirlos nuevamente y se enviará otro correo al completar la carga. " +
                "Los archivos anteriores permanecerán en OneDrive."
            );
            if (!confirmado) return;

            this.reiniciandoCuentaId = cuentaId;
            try {
                await axios.delete(`${API}/cuentas-cobro/${cuentaId}/documentos`, {
                    data: { confirmacion: "REINICIAR_DOCUMENTOS" }
                });
                this.soportes = this.soportes.filter((soporte) => soporte.id !== cuentaId);
                if (this.docsCuentaId === cuentaCorta) this.cerrarModalDocs();
                window.alert(`Documentos de la cuenta #${cuentaCorta} reiniciados correctamente.`);
            } catch (e) {
                window.alert(e?.response?.data?.error || "No se pudieron reiniciar los documentos.");
            } finally {
                this.reiniciandoCuentaId = "";
            }
        },

        formatDate(d) {
            return d ? String(d).split("T")[0] : "";
        },

        formatearDinero(val) {
            return new Intl.NumberFormat("es-CO", {
                style: "currency",
                currency: "COP",
                maximumFractionDigits: 0
            }).format(Number(val || 0));
        }
    };
};
