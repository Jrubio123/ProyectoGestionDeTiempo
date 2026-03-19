window.contratacionApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const TIMER_PDF = 20; // segundos mínimos de lectura por PDF

    return {
        // ── Estado general
        pantalla: "token",   // token | leyendo | firma | completado
        jwt: null,
        nombre: "",
        cargando: false,
        errorGlobal: "",

        // ── Ingreso de token
        tokenInput: "",
        tokenError: "",

        // ── Documentos
        docs: [],            // [{ clave, label, tipo:'pdf', archivo }]
        linkItem: null,      // { clave, label, tipo:'link', url }
        videoDisponible: false,
        checksCompletados: {},

        // ── Navegación inline (sin modal overlay)
        docActualIdx: 0,
        pdfBlobUrl: null,
        pdfCargando: false,
        pdfError: "",
        timerSeg: TIMER_PDF,
        timerOk: false,
        _timer: null,
        _pdfCargadoParaIdx: null, // evita recargar el mismo PDF

        // ── Firma digital
        docsActuales: [],
        firmaCargando: false,
        firmaError: "",
        descargaDocIndex: null,
        pollingInterval: null,

        // ── Init
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
                this.checksCompletados = res.data.checks_completados || {};
                this.docsActuales = res.data.docs_firma || [];

                await this.cargarDocsInfo();

                if (this.todosChecks) {
                    this.pantalla = "firma";
                } else {
                    // Posicionar en el primer doc pendiente
                    this.docActualIdx = this._primerPendiente();
                    this.pantalla = "leyendo";
                    await this.cargarDocActual();
                }
            } catch (e) {
                this.tokenError = e?.response?.data?.error || "Código no válido. Verifica e intenta de nuevo.";
            } finally {
                this.cargando = false;
            }
        },

        // ─────────────────────────────────────────────────────
        // CARGAR LISTA DE DOCUMENTOS
        // ─────────────────────────────────────────────────────
        async cargarDocsInfo() {
            try {
                const res = await axios.get(`${API}/contratacion/docs-info`, {
                    headers: { Authorization: `Bearer ${this.jwt}` }
                });
                this.docs = res.data.docs.map(d => ({ ...d, tipo: "pdf", descarga_archivo: d?.descarga_archivo || null }));
                this.linkItem = { ...res.data.link, tipo: "link" };
                this.videoDisponible = res.data.video_disponible;
            } catch {
                // La lista queda vacía; el usuario verá el visor vacío
            }
        },

        // ─────────────────────────────────────────────────────
        // COMPUTED
        // ─────────────────────────────────────────────────────
        get allItems() {
            return this.linkItem ? [...this.docs, this.linkItem] : [...this.docs];
        },

        get requiredItems() {
            return this.allItems;
        },

        get docActual() {
            return this.allItems[this.docActualIdx] || null;
        },

        get totalItems() { return this.requiredItems.length; },

        get totalCheckeados() {
            return this.requiredItems.filter(d => this.checksCompletados[d.clave]).length;
        },

        get todosChecks() {
            return this.requiredItems.length > 0 && this.requiredItems.every(d => this.checksCompletados[d.clave]);
        },

        get puedeAvanzar() {
            if (!this.docActual) return false;
            if (this.docActual.tipo !== "pdf") return true;
            return !!this.checksCompletados[this.docActual?.clave];
        },

        get videoUrl() {
            if (!this.jwt || !this.videoDisponible) return null;
            return `${API}/contratacion/video?t=${encodeURIComponent(this.jwt)}`;
        },

        get docsFirmaOrdenados() {
            const list = Array.isArray(this.docsActuales) ? [...this.docsActuales] : [];
            return list.sort((a, b) => Number(a?.doc_index || 0) - Number(b?.doc_index || 0));
        },

        get totalDocsFirma() {
            return this.docsFirmaOrdenados.length;
        },

        get totalDocsFirmados() {
            return this.docsFirmaOrdenados.filter((d) => this.estadoDocFirma(d) === "signed").length;
        },

        isChecked(clave) { return !!this.checksCompletados[clave]; },

        _extensionDesdeNombre(nombre = "") {
            const clean = String(nombre || "").trim();
            const idx = clean.lastIndexOf(".");
            if (idx < 0) return "";
            return clean.slice(idx);
        },

        _nombreDescargaDesdeDoc(doc, fallbackName = "Documento.pdf") {
            const base = String(doc?.label || "Documento")
                .replace(/[<>:"/\\|?*#%{}~]/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            const ext = this._extensionDesdeNombre(fallbackName) || ".pdf";
            return `${base || "Documento"}${ext}`;
        },

        _parseFileNameFromDisposition(disposition = "") {
            const raw = String(disposition || "");
            const m = raw.match(/filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?/i);
            if (!m?.[1]) return "";
            try {
                return decodeURIComponent(m[1].replace(/\"/g, ""));
            } catch {
                return m[1].replace(/\"/g, "");
            }
        },

        _primerPendiente() {
            const idx = this.allItems.findIndex(d => !this.checksCompletados[d.clave]);
            return idx >= 0 ? idx : 0;
        },

        // ─────────────────────────────────────────────────────
        // NAVEGACIÓN ENTRE DOCUMENTOS
        // ─────────────────────────────────────────────────────
        async irA(idx) {
            if (idx === this.docActualIdx) return;
            this.docActualIdx = idx;
            await this.cargarDocActual();
        },

        async anterior() {
            if (this.docActualIdx > 0) {
                this.docActualIdx--;
                await this.cargarDocActual();
            }
        },

        async siguiente() {
            if (this.docActualIdx < this.allItems.length - 1) {
                this.docActualIdx++;
                await this.cargarDocActual();
            }
        },

        async siguienteOFirmar() {
            if (!this.puedeAvanzar) return;
            if (this.docActualIdx < this.allItems.length - 1) {
                await this.siguiente();
            } else if (this.todosChecks) {
                this.pantalla = "firma";
            } else {
                // Ir al primer pendiente
                this.docActualIdx = this._primerPendiente();
                await this.cargarDocActual();
            }
        },

        // ─────────────────────────────────────────────────────
        // CARGAR PDF DEL DOCUMENTO ACTUAL
        // ─────────────────────────────────────────────────────
        async cargarDocActual() {
            const doc = this.docActual;
            if (!doc) return;

            // Reiniciar timer siempre al cambiar de doc
            this._reiniciarTimer();

            // Link: no hay PDF que cargar
            if (doc.tipo === "link") return;

            // PDF: evitar recarga si ya está cargado
            if (this._pdfCargadoParaIdx === this.docActualIdx && this.pdfBlobUrl) return;

            this.pdfError = "";
            this.pdfCargando = true;
            if (this.pdfBlobUrl) {
                URL.revokeObjectURL(this.pdfBlobUrl);
                this.pdfBlobUrl = null;
            }
            this._pdfCargadoParaIdx = null;

            try {
                const resp = await axios.get(`${API}/contratacion/pdf/${encodeURIComponent(doc.archivo)}`, {
                    headers: { Authorization: `Bearer ${this.jwt}` },
                    responseType: "blob"
                });
                const contentType = String(resp?.headers?.["content-type"] || "application/pdf");
                this.pdfBlobUrl = URL.createObjectURL(new Blob([resp.data], { type: contentType }));
                this._pdfCargadoParaIdx = this.docActualIdx;
            } catch (e) {
                this.pdfError = e?.response?.data?.error || "No se pudo cargar el documento. Intenta de nuevo.";
            } finally {
                this.pdfCargando = false;
            }
        },

        // ─────────────────────────────────────────────────────
        // TIMER DE LECTURA
        // ─────────────────────────────────────────────────────
        _reiniciarTimer() {
            clearInterval(this._timer);
            const clave = this.docActual?.clave;
            this.timerOk = !!this.checksCompletados[clave];
            this.timerSeg = TIMER_PDF;
            if (!this.timerOk && this.docActual?.tipo === "pdf") {
                this._timer = setInterval(() => {
                    if (this.timerSeg > 0) {
                        this.timerSeg--;
                    } else {
                        clearInterval(this._timer);
                        this.timerOk = true;
                    }
                }, 1000);
            }
        },

        // ─────────────────────────────────────────────────────
        // DESCARGA DEL PDF ACTUAL (usa el blob ya en memoria)
        // ─────────────────────────────────────────────────────
        descargarDoc() {
            if (!this.pdfBlobUrl || !this.docActual) return;
            const a = document.createElement("a");
            a.href = this.pdfBlobUrl;
            a.download = this._nombreDescargaDesdeDoc(this.docActual, this.docActual?.archivo || "Documento.pdf");
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        },

        async descargarArchivo(nombreArchivo, fallbackLabel = "") {
            if (!nombreArchivo) return;
            const fileNameFromDoc = String(nombreArchivo || "").trim();
            let blob = null;
            let fileName = fileNameFromDoc;

            if (this.docActual?.archivo === fileNameFromDoc && this.pdfBlobUrl) {
                const resp = await fetch(this.pdfBlobUrl);
                blob = await resp.blob();
            } else {
                const resp = await axios.get(`${API}/contratacion/pdf/${encodeURIComponent(fileNameFromDoc)}`, {
                    headers: { Authorization: `Bearer ${this.jwt}` },
                    responseType: "blob"
                });
                const headerName = this._parseFileNameFromDisposition(resp?.headers?.["content-disposition"] || "");
                fileName = headerName || fileNameFromDoc;
                blob = resp.data;
            }

            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = fileName || this._nombreDescargaDesdeDoc({ label: fallbackLabel || this.docActual?.label }, fileNameFromDoc || "Documento.pdf");
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        },

        // ─────────────────────────────────────────────────────
        // CONFIRMAR LECTURA DE PDF
        // ─────────────────────────────────────────────────────
        async confirmarLectura() {
            if (!this.timerOk || !this.docActual || this.isChecked(this.docActual.clave)) return;
            await this._registrarCheck(this.docActual.clave);
            // Auto-descarga si el doc es una plantilla/formato que el usuario va a necesitar usar
            if (this.docActual.plantilla) {
                const archivoDescarga = this.docActual?.descarga_archivo || this.docActual?.archivo;
                if (archivoDescarga) {
                    try {
                        await this.descargarArchivo(archivoDescarga, this.docActual?.label || "Documento");
                    } catch (err) {
                        console.warn("No se pudo descargar automaticamente la plantilla:", err?.message || err);
                    }
                }
            }
        },

        // ─────────────────────────────────────────────────────
        // ABRIR LINK EXTERNO
        // ─────────────────────────────────────────────────────
        async abrirLink() {
            if (!this.linkItem) return;
            window.open(this.linkItem.url, "_blank", "noopener,noreferrer");
            if (!this.isChecked(this.linkItem.clave)) {
                await this._registrarCheck(this.linkItem.clave);
            }
        },

        // ─────────────────────────────────────────────────────
        // REGISTRAR CHECK EN BACKEND
        // ─────────────────────────────────────────────────────
        async _registrarCheck(clave) {
            try {
                const res = await axios.patch(
                    `${API}/contratacion/check`,
                    { clave },
                    { headers: { Authorization: `Bearer ${this.jwt}` } }
                );
                this.checksCompletados = res.data.checks_completados || this.checksCompletados;
                this.checksCompletados = { ...this.checksCompletados, [clave]: true };
            } catch (e) {
                console.error("Error registrando check:", e?.message);
            }
        },

        // ─────────────────────────────────────────────────────
        // FIRMA DIGITAL
        // ─────────────────────────────────────────────────────
        docFirmaInfo(idx) {
            return this.docsFirmaOrdenados.find((d) => Number(d?.doc_index) === Number(idx)) || null;
        },

        docTituloFirma(doc) {
            if (!doc) return "Documento";
            return doc.titulo || doc.doc_key || `Documento ${doc.doc_index || ""}`.trim();
        },

        estadoDocFirma(doc) {
            const raw = String(doc?.estado || "").trim().toLowerCase();
            if (["signed", "firmado", "completado", "approved", "done"].includes(raw)) return "signed";
            if (["rejected", "rechazado", "declined", "cancelled", "canceled"].includes(raw)) return "rejected";
            return "pending";
        },

        docFirmado(idx) {
            return this.estadoDocFirma(this.docFirmaInfo(idx)) === "signed";
        },

        docBloqueado(doc) {
            if (!doc || this.estadoDocFirma(doc) === "signed") return false;
            const currentIndex = Number(doc.doc_index || 0);
            return this.docsFirmaOrdenados
                .filter((item) => Number(item?.doc_index || 0) < currentIndex)
                .some((item) => this.estadoDocFirma(item) !== "signed");
        },

        puedeIniciarFirma(doc) {
            if (!doc) return false;
            if (this.firmaCargando) return false;
            if (this.estadoDocFirma(doc) === "signed") return false;
            if (this.docBloqueado(doc)) return false;
            return true;
        },

        get todosFirmados() {
            return this.totalDocsFirma > 0 && this.totalDocsFirmados === this.totalDocsFirma;
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

        async descargarContratoPdf(docIndex, docTitulo = "") {
            if (!docIndex || this.descargaDocIndex === docIndex) return;
            this.firmaError = "";
            this.descargaDocIndex = docIndex;
            try {
                const resp = await axios.get(`${API}/contratacion/docs-firma/${docIndex}/pdf`, {
                    headers: { Authorization: `Bearer ${this.jwt}` },
                    responseType: "blob"
                });
                const contentType = String(resp?.headers?.["content-type"] || "application/pdf");
                const blob = new Blob([resp.data], { type: contentType });
                const blobUrl = URL.createObjectURL(blob);
                const disposition = String(resp?.headers?.["content-disposition"] || "");
                const fileNameFromHeader = this._parseFileNameFromDisposition(disposition);
                const fallbackExt = contentType.includes("wordprocessingml.document")
                    ? ".docx"
                    : contentType.includes("application/msword")
                        ? ".doc"
                        : contentType.includes("spreadsheetml.sheet")
                            ? ".xlsx"
                            : ".pdf";
                const fallbackName = `${docTitulo || `Documento_${docIndex}`}${fallbackExt}`;
                const fileName = fileNameFromHeader || fallbackName;

                const a = document.createElement("a");
                a.href = blobUrl;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(blobUrl);
            } catch (e) {
                this.firmaError = e?.response?.data?.error || "No se pudo descargar el archivo de este documento.";
            } finally {
                this.descargaDocIndex = null;
            }
        },

        async refrescarEstado() {
            try {
                // Solo Authorization: Cache-Control/Pragma disparan preflight y el back
                // debe listarlos en CORS; el query _ts evita caché del GET sin headers extra.
                const res = await axios.get(`${API}/contratacion/estado`, {
                    headers: { Authorization: `Bearer ${this.jwt}` },
                    params: { _ts: Date.now() }
                });
                this.docsActuales = res.data.docs_firma || [];
                this.checksCompletados = res.data.checks_completados || {};
                if (res.data.estado === "completado") {
                    this.pantalla = "completado";
                    clearInterval(this.pollingInterval);
                }
            } catch {
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

        async yaFirme() {
            await this.refrescarEstado();
            if (this.todosFirmados) this.pantalla = "completado";
        },

        destroy() {
            clearInterval(this._timer);
            clearInterval(this.pollingInterval);
            if (this.pdfBlobUrl) URL.revokeObjectURL(this.pdfBlobUrl);
        }
    };
};
