window.contratacionApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const PDF_NAMES = ["informativo_1.pdf", "informativo_2.pdf", "informativo_3.pdf"];
    const PDF_LABELS = [
        "Política de Tratamiento de Datos",
        "Reglamento Interno de Contratistas",
        "Términos y Condiciones del Servicio"
    ];
    const TIMER_SEGUNDOS = 45;

    return {
        // ── Estado general
        pantalla: "token",   // token | leyendo | firma | completado | error
        jwt: null,
        nombre: "",
        cargando: false,
        errorGlobal: "",

        // ── Ingreso de token
        tokenInput: "",
        tokenError: "",

        // ── Lectura de PDFs
        pdfActual: 0,          // índice 0..2
        checksCompletados: { pdf1: false, pdf2: false, pdf3: false },
        pdfBlobUrl: null,
        pdfCargando: false,
        timerSegundos: TIMER_SEGUNDOS,
        timerActivo: false,
        timerCompletado: false,
        checkHecho: false,
        _timerInterval: null,

        // ── Firma digital
        docsActuales: [],
        firmaCargando: false,
        firmaError: "",
        pollingInterval: null,

        // ── Init: leer token desde URL si viene en query param
        init() {
            const params = new URLSearchParams(window.location.search);
            const t = params.get("t");
            if (t) this.tokenInput = t;
        },

        // ─────────────────────────────────────────────────────
        // VALIDAR TOKEN
        // ─────────────────────────────────────────────────────
        async validarToken() {
            if (!this.tokenInput.trim()) {
                this.tokenError = "Ingresa tu código de acceso.";
                return;
            }
            this.tokenError = "";
            this.cargando = true;
            try {
                const res = await axios.post(`${API}/contratacion/validar`, {
                    token: this.tokenInput.trim().toLowerCase()
                });
                this.jwt = res.data.jwt;
                this.nombre = res.data.nombre;
                this.checksCompletados = res.data.checks_completados || { pdf1: false, pdf2: false, pdf3: false };
                this.docsActuales = res.data.docs_firma || [];

                const todosLeidos = this.checksCompletados.pdf1 && this.checksCompletados.pdf2 && this.checksCompletados.pdf3;
                if (todosLeidos) {
                    this.pantalla = "firma";
                } else {
                    this.pdfActual = this._primerPdfPendiente();
                    this.pantalla = "leyendo";
                    await this.cargarPdf();
                }
            } catch (e) {
                this.tokenError = e?.response?.data?.error || "Código no válido. Verifica e intenta de nuevo.";
            } finally {
                this.cargando = false;
            }
        },

        // ─────────────────────────────────────────────────────
        // LECTURA DE PDFs
        // ─────────────────────────────────────────────────────
        _primerPdfPendiente() {
            if (!this.checksCompletados.pdf1) return 0;
            if (!this.checksCompletados.pdf2) return 1;
            if (!this.checksCompletados.pdf3) return 2;
            return 2;
        },

        get pdfLabel() {
            return PDF_LABELS[this.pdfActual] || `Documento ${this.pdfActual + 1}`;
        },

        get timerProgreso() {
            return Math.round(((TIMER_SEGUNDOS - this.timerSegundos) / TIMER_SEGUNDOS) * 100);
        },

        get todoLeido() {
            return this.timerCompletado && this.checkHecho;
        },

        get todosChecks() {
            return this.checksCompletados.pdf1 && this.checksCompletados.pdf2 && this.checksCompletados.pdf3;
        },

        async cargarPdf() {
            if (this.pdfBlobUrl) {
                URL.revokeObjectURL(this.pdfBlobUrl);
                this.pdfBlobUrl = null;
            }
            this.pdfCargando = true;
            this.timerCompletado = false;
            this.checkHecho = false;
            this.timerSegundos = TIMER_SEGUNDOS;
            clearInterval(this._timerInterval);

            const nombre = PDF_NAMES[this.pdfActual];
            const keyCheck = `pdf${this.pdfActual + 1}`;
            if (this.checksCompletados[keyCheck]) {
                this.checkHecho = true;
                this.timerCompletado = true;
            }

            try {
                const resp = await axios.get(`${API}/contratacion/pdf/${nombre}`, {
                    headers: { Authorization: `Bearer ${this.jwt}` },
                    responseType: "blob"
                });
                this.pdfBlobUrl = URL.createObjectURL(new Blob([resp.data], { type: "application/pdf" }));
                this.iniciarTimer();
            } catch (e) {
                this.errorGlobal = e?.response?.data?.error || "No se pudo cargar el documento. Intenta de nuevo.";
            } finally {
                this.pdfCargando = false;
            }
        },

        iniciarTimer() {
            if (this.timerCompletado) return;
            this.timerActivo = true;
            this._timerInterval = setInterval(() => {
                if (this.timerSegundos > 0) {
                    this.timerSegundos--;
                } else {
                    clearInterval(this._timerInterval);
                    this.timerActivo = false;
                    this.timerCompletado = true;
                }
            }, 1000);
        },

        async marcarCheck() {
            if (!this.timerCompletado || this.checkHecho) return;
            const numero = this.pdfActual + 1;
            try {
                const res = await axios.patch(
                    `${API}/contratacion/check`,
                    { numero },
                    { headers: { Authorization: `Bearer ${this.jwt}` } }
                );
                this.checksCompletados = res.data.checks_completados;
                this.checkHecho = true;
            } catch (e) {
                this.errorGlobal = e?.response?.data?.error || "Error registrando confirmación.";
            }
        },

        async siguientePdf() {
            if (!this.todoLeido) return;
            if (this.pdfActual < 2) {
                this.pdfActual++;
                await this.cargarPdf();
            } else {
                this.pantalla = "firma";
                if (this.pdfBlobUrl) {
                    URL.revokeObjectURL(this.pdfBlobUrl);
                    this.pdfBlobUrl = null;
                }
            }
        },

        // ─────────────────────────────────────────────────────
        // FIRMA DIGITAL
        // ─────────────────────────────────────────────────────
        docFirmaInfo(idx) {
            return this.docsActuales.find(d => d.doc_index === idx) || null;
        },

        docFirmado(idx) {
            return this.docFirmaInfo(idx)?.estado === "signed";
        },

        get todosFirmados() {
            return this.docFirmado(1) && this.docFirmado(2);
        },

        async iniciarFirma(docIndex) {
            this.firmaError = "";
            this.firmaCargando = true;
            try {
                const res = await axios.post(
                    `${API}/contratacion/firmar`,
                    { doc_index: docIndex },
                    { headers: { Authorization: `Bearer ${this.jwt}` } }
                );
                const urlFirma = res.data.url_firma;
                if (urlFirma) {
                    window.open(urlFirma, "_blank", "noopener");
                    // Actualizar lista local
                    await this.refrescarEstado();
                } else {
                    this.firmaError = "No se recibió enlace de firma. Contacta a Talento Humano.";
                }
            } catch (e) {
                this.firmaError = e?.response?.data?.error || "Error iniciando firma digital.";
            } finally {
                this.firmaCargando = false;
            }
        },

        async refrescarEstado() {
            try {
                const res = await axios.get(`${API}/contratacion/estado`, {
                    headers: { Authorization: `Bearer ${this.jwt}` }
                });
                this.docsActuales = res.data.docs_firma || [];
                this.checksCompletados = res.data.checks_completados;
                if (res.data.estado === "completado") {
                    this.pantalla = "completado";
                    clearInterval(this.pollingInterval);
                }
            } catch (e) {
                // silencioso
            }
        },

        iniciarPolling() {
            clearInterval(this.pollingInterval);
            this.pollingInterval = setInterval(() => {
                if (this.pantalla === "firma" && !this.todosFirmados) {
                    this.refrescarEstado();
                } else {
                    clearInterval(this.pollingInterval);
                }
            }, 8000);
        },

        async yaFirme(docIndex) {
            await this.refrescarEstado();
            if (this.todosFirmados) {
                this.pantalla = "completado";
            }
        },

        destroy() {
            clearInterval(this._timerInterval);
            clearInterval(this.pollingInterval);
            if (this.pdfBlobUrl) URL.revokeObjectURL(this.pdfBlobUrl);
        }
    };
};
