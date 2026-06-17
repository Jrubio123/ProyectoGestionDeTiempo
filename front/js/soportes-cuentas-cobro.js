window.soportesCuentasCobroApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const ESTADOS_FIRMA_PENDIENTE = ["pending", "in_progress", "en_firma", "started", "sent"];

    return {
        soportes: [],
        consultores: [],
        aprobadores: [],
        filtros: {
            consultor_id: "",
            coordinador_id: ""
        },
        loading: false,
        modalFirmasAtascadasOpen: false,
        firmasAtascadasSearch: "",
        forzandoFirmaId: null,
        modalErrorSeguridadOpen: false,
        errorSeguridadSearch: "",
        subiendoSeguridadId: null,
        modalCargarSeguridadOpen: false,

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

        abrirSoporte(item, tipo) {
            const url = this.getSoporteUrl(item, tipo);
            if (!url) {
                alert("No hay archivo disponible para este soporte.");
                return;
            }
            window.open(url, "_blank", "noopener,noreferrer");
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
        },

        abrirModalFirmasAtascadas() {
            this.firmasAtascadasSearch = "";
            this.modalFirmasAtascadasOpen = true;
        },

        cerrarModalFirmasAtascadas() {
            this.modalFirmasAtascadasOpen = false;
        },

        abrirModalErrorSeguridad() {
            this.errorSeguridadSearch = "";
            this.modalErrorSeguridadOpen = true;
        },

        cerrarModalErrorSeguridad() {
            this.modalErrorSeguridadOpen = false;
        },

        isFirmaAtascada(item) {
            const firma = item?.datos_adjuntos?.firma;
            if (!firma || typeof firma !== "object") return false;
            const docFirmadoUrl = firma?.documento_firmado?.url;
            if (docFirmadoUrl) return false;
            const estado = String(firma.estado || "").toLowerCase().trim();
            if (ESTADOS_FIRMA_PENDIENTE.includes(estado)) return true;
            return Boolean(firma.url_firma);
        },

        estadoFirmaLabel(item) {
            const estado = String(item?.datos_adjuntos?.firma?.estado || "").trim();
            if (!estado) return "En_Firma";
            return estado;
        },

        firmasAtascadasFiltradas() {
            const lista = Array.isArray(this.soportes) ? this.soportes : [];
            const atascadas = lista.filter((item) => this.isFirmaAtascada(item));
            const q = String(this.firmasAtascadasSearch || "").trim().toLowerCase();
            if (!q) return atascadas;
            return atascadas.filter((item) =>
                String(item?.consultor_nombre || "").toLowerCase().includes(q)
            );
        },

        cuentasSinSeguridad() {
            const lista = Array.isArray(this.soportes) ? this.soportes : [];
            return lista.filter((item) =>
                this.getSoporteUrl(item, "cuenta") !== "" &&
                this.getSoporteUrl(item, "seguridad") === ""
            );
        },

        cuentasSinSeguridadFiltradas() {
            const cuentas = this.cuentasSinSeguridad();
            const q = String(this.errorSeguridadSearch || "").trim().toLowerCase();
            if (!q) return cuentas;
            return cuentas.filter((item) =>
                String(item?.consultor_nombre || "").toLowerCase().includes(q)
            );
        },

        leerArchivoComoDataUrl(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
                reader.readAsDataURL(file);
            });
        },

        async cargarSeguridadSocial(item, file) {
            if (!item?.id || !file) return;

            const fileName = String(file.name || "");
            const fileType = String(file.type || "").toLowerCase();
            const isPdf = fileType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
            if (!isPdf) {
                window.alert("Debe seleccionar un archivo PDF.");
                return;
            }

            this.subiendoSeguridadId = item.id;
            try {
                const dataUrl = await this.leerArchivoComoDataUrl(file);
                await axios.post(
                    `${API}/cuentas-cobro/${item.id}/seguridad-social`,
                    {
                        seguridad_social_nombre: file.name,
                        seguridad_social_base64: dataUrl
                    },
                    { headers: { "Content-Type": "application/json" } }
                );
                window.alert("Seguridad social cargada exitosamente.");
                await this.cargarSoportes();
            } catch (err) {
                const msg =
                    err?.response?.data?.error ||
                    err?.message ||
                    "Error al cargar la seguridad social. Intenta nuevamente.";
                window.alert(msg);
            } finally {
                this.subiendoSeguridadId = null;
            }
        },

        async forzarReinicioFirma(public_id) {
            if (!public_id) return;
            const ok = window.confirm(
                "¿Estás seguro de reiniciar el proceso de firma de este usuario? Esto invalidará el enlace que se le envió anteriormente."
            );
            if (!ok) return;

            this.forzandoFirmaId = public_id;
            try {
                await axios.post(
                    `${API}/cuentas-cobro/${public_id}/firma/iniciar`,
                    { force: true },
                    { headers: { "Content-Type": "application/json" } }
                );
                window.alert("Proceso de firma reiniciado correctamente. Se enviará un nuevo enlace al consultor.");
                this.cerrarModalFirmasAtascadas();
                await this.cargarSoportes();
            } catch (err) {
                const msg =
                    err?.response?.data?.error ||
                    err?.message ||
                    "Error al reiniciar la firma. Intenta nuevamente.";
                window.alert(msg);
            } finally {
                this.forzandoFirmaId = null;
            }
        }
    };
};
