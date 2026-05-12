window.contratacionApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const FIRMA_POLLING_INTERVAL_MS = 10000;
    const FIRMA_POLLING_MAX_ATTEMPTS = 30;
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
        formItem: null,      // { clave, label, tipo:'form' }
        videoDisponible: false,
        checksCompletados: {},

        // Datos personales
        personaDatos: {},
        personaCatalogos: {
            documentos_identidad: [],
            modulos: [],
            estados_civiles: []
        },
        personaDatosCargando: false,
        personaDatosGuardando: false,
        personaDatosError: "",
        personaDatosDirty: false,
        personaDatosCargados: false,

        // ── Navegación inline (sin modal overlay)
        docActualIdx: 0,
        pdfBlobUrl: null,
        pdfCargando: false,
        pdfError: "",
        timerSeg: TIMER_PDF,
        timerOk: false,
        confirmoLectura: false,
        _timer: null,
        _pdfCargadoParaIdx: null, // evita recargar el mismo PDF

        // ── Firma digital
        docsActuales: [],
        firmaCargando: false,
        firmaError: "",
        descargaDocIndex: null,
        pollingInterval: null,
        pollingIntentos: 0,
        _pollingEnCurso: false,

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
                    this.iniciarPolling();
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
                this.formItem = res.data.form ? { ...res.data.form, tipo: "form" } : null;
                this.videoDisponible = res.data.video_disponible;
            } catch {
                // La lista queda vacía; el usuario verá el visor vacío
            }
        },

        // ─────────────────────────────────────────────────────
        // COMPUTED
        // ─────────────────────────────────────────────────────
        get allItems() {
            return this.formItem ? [...this.docs, this.formItem] : [...this.docs];
        },

        get requiredItems() {
            return this.allItems;
        },

        get docActual() {
            return this.allItems[this.docActualIdx] || null;
        },

        get totalItems() { return this.requiredItems.length; },

        get totalCheckeados() {
            return this.requiredItems.filter(d => this.checksCompletados[d.clave] && !(d.tipo === "form" && this.personaDatosDirty)).length;
        },

        get todosChecks() {
            if (this.formItem && this.personaDatosDirty) return false;
            return this.requiredItems.length > 0 && this.requiredItems.every(d => this.checksCompletados[d.clave]);
        },

        get puedeAvanzar() {
            if (!this.docActual) return false;
            if (this.docActual.tipo === "form") {
                return !!this.checksCompletados[this.docActual?.clave] && !this.personaDatosDirty && !this.personaDatosGuardando;
            }
            if (this.docActual.tipo !== "pdf") return true;
            return !!this.checksCompletados[this.docActual?.clave];
        },

        get requiereEdadesHijos() {
            return Number(this.personaDatos?.hijos || 0) > 0;
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

        isChecked(clave) {
            if (this.formItem?.clave === clave && this.personaDatosDirty) return false;
            return !!this.checksCompletados[clave];
        },

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
            if (!this.puedeAvanzar || (this.docActual?.tipo === "pdf" && !this.confirmoLectura)) return;
            if (this.docActualIdx < this.allItems.length - 1) {
                await this.siguiente();
            } else if (this.todosChecks) {
                this.pantalla = "firma";
                this.iniciarPolling();
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

            // Formularios internos: no hay PDF que cargar
            if (doc.tipo !== "pdf") {
                this._limpiarPdfActual();
                if (doc.tipo === "form") await this.cargarDatosPersona();
                return;
            }

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
        _limpiarPdfActual() {
            this.pdfCargando = false;
            this.pdfError = "";
            this._pdfCargadoParaIdx = null;
            if (this.pdfBlobUrl) {
                URL.revokeObjectURL(this.pdfBlobUrl);
                this.pdfBlobUrl = null;
            }
        },

        _reiniciarTimer() {
            clearInterval(this._timer);
            const clave = this.docActual?.clave;
            const checkCompletado = !!this.checksCompletados[clave];
            this.timerOk = checkCompletado;
            this.confirmoLectura = checkCompletado;
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
            if (!this.confirmoLectura || !this.timerOk || !this.docActual || this.isChecked(this.docActual.clave)) return;
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
        // DATOS PERSONALES
        // ─────────────────────────────────────────────────────
        _datosPersonaVacios() {
            return {
                nombre: "",
                apellidos: "",
                fecha_nacimiento: "",
                sexo: "",
                lugar_nacimiento: "",
                tipo_documento_id: "",
                numero_documento: "",
                lugar_expedicion: "",
                nacionalidad: "",
                estado_civil: "",
                direccion_residencia: "",
                barrio: "",
                ciudad_residencia: "",
                departamento_pais: "",
                pais_residencia: "",
                correo_electronico: "",
                numero_contacto: "",
                titulo_profesional: "",
                modulo_id: "",
                modulo_otro: "",
                eps: "",
                arl: "",
                afp: "",
                nombre_contacto_emergencia: "",
                parentesco: "",
                telefono_contacto_emergencia: "",
                hijos: 0,
                edades_hijos: "",
                visa_paises: "",
                acepta_tratamiento_datos: false
            };
        },

        marcarPersonaDatosDirty() {
            this.personaDatosDirty = true;
        },

        async cargarDatosPersona({ force = false } = {}) {
            if (this.personaDatosCargados && !force) return;
            this.personaDatosCargando = true;
            this.personaDatosError = "";
            try {
                const res = await axios.get(`${API}/contratacion/datos-persona`, {
                    headers: { Authorization: `Bearer ${this.jwt}` }
                });
                this.personaDatos = { ...this._datosPersonaVacios(), ...(res.data?.datos || {}) };
                this.personaCatalogos = {
                    documentos_identidad: res.data?.catalogos?.documentos_identidad || [],
                    modulos: res.data?.catalogos?.modulos || [],
                    estados_civiles: res.data?.catalogos?.estados_civiles || []
                };
                this.personaDatosCargados = true;
                this.personaDatosDirty = false;
                if (res.data?.check_completado) {
                    this.checksCompletados = { ...this.checksCompletados, [this.formItem?.clave || "datos_personales"]: true };
                }
            } catch (e) {
                this.personaDatosError = e?.response?.data?.error || "No se pudieron cargar tus datos personales.";
            } finally {
                this.personaDatosCargando = false;
            }
        },

        async guardarDatosPersona() {
            if (this.personaDatosGuardando) return;
            this.personaDatosGuardando = true;
            this.personaDatosError = "";
            try {
                const payload = { ...this.personaDatos };
                if (Number(payload.hijos || 0) <= 0) payload.edades_hijos = "";
                const res = await axios.post(
                    `${API}/contratacion/datos-persona`,
                    payload,
                    { headers: { Authorization: `Bearer ${this.jwt}` } }
                );
                this.checksCompletados = res.data?.checks_completados || this.checksCompletados;
                this.checksCompletados = { ...this.checksCompletados, [this.formItem?.clave || "datos_personales"]: true };
                this.personaDatosDirty = false;
                this.personaDatosCargados = true;
            } catch (e) {
                const faltantes = e?.response?.data?.faltantes;
                this.personaDatosError = Array.isArray(faltantes) && faltantes.length
                    ? `Faltan: ${faltantes.join(", ")}`
                    : (e?.response?.data?.error || "No se pudieron guardar tus datos personales.");
            } finally {
                this.personaDatosGuardando = false;
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

        estadoDocFirmaReconciliacion(doc) {
            const raw = String(doc?.estado || "").trim().toLowerCase().replace(/\s+/g, "_");
            if (["signed", "firmado", "completado", "approved", "done"].includes(raw)) return "signed";
            if (["rejected", "rechazado", "declined", "cancelled", "canceled", "expired", "expirado", "expirada", "failed", "error"].includes(raw)) return "rejected";
            if (["en_proceso", "in_progress", "inprogress", "en_firma"].includes(raw) || raw.includes("progress")) return "en_proceso";
            if (["sent", "started", "created", "open", "start_signature", "start"].includes(raw)) return "sent";
            return "pending";
        },

        puedeReconciliarDoc(doc) {
            const estado = this.estadoDocFirmaReconciliacion(doc);
            if (estado === "pending") return false;
            if (!["sent", "en_proceso"].includes(estado)) return false;
            return Boolean(doc?.request_id || doc?.contract_id || doc?.signature_id);
        },

        docFirmado(idx) {
            return this.estadoDocFirma(this.docFirmaInfo(idx)) === "signed";
        },

        docBloqueado(doc) {
            return false;
        },

        puedeIniciarFirma(doc) {
            if (!doc) return false;
            if (this.firmaCargando) return false;
            if (this.estadoDocFirma(doc) === "signed") return false;
            return true;
        },

        get todosFirmados() {
            return this.totalDocsFirma > 0 && this.totalDocsFirmados === this.totalDocsFirma;
        },

        requiereReconciliacionFirma({ docIndex = null } = {}) {
            const docs = docIndex
                ? this.docsFirmaOrdenados.filter((doc) => Number(doc?.doc_index) === Number(docIndex))
                : this.docsFirmaOrdenados;
            return docs.some((doc) => this.puedeReconciliarDoc(doc));
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
                    await this.refrescarEstado({ reconciliar: false });
                    this.iniciarPolling();
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

        async refrescarEstado({ reconciliar = false, docIndex = null } = {}) {
            try {
                let data = null;
                if (reconciliar && this.requiereReconciliacionFirma({ docIndex })) {
                    try {
                        const reconcileRes = await axios.post(
                            `${API}/contratacion/firma/reconciliar`,
                            docIndex ? { doc_index: docIndex } : {},
                            { headers: { Authorization: `Bearer ${this.jwt}` } }
                        );
                        data = reconcileRes?.data || null;
                    } catch (e) {
                        this.detenerPollingFirma();
                        this.firmaError = e?.response?.data?.error || "No se pudo actualizar el estado de firma.";
                        data = null;
                        return false;
                    }
                }
                // Solo Authorization: Cache-Control/Pragma disparan preflight y el back
                // debe listarlos en CORS; el query _ts evita caché del GET sin headers extra.
                if (!data) {
                    const res = await axios.get(`${API}/contratacion/estado`, {
                        headers: { Authorization: `Bearer ${this.jwt}` },
                        params: { _ts: Date.now() }
                    });
                    data = res?.data || null;
                }
                this.docsActuales = data?.docs_firma || [];
                this.checksCompletados = data?.checks_completados || {};
                if (data?.estado === "completado" && !this.requiereReconciliacionFirma()) {
                    this.pantalla = "completado";
                    this.detenerPollingFirma();
                }
                return true;
            } catch (e) {
                this.detenerPollingFirma();
                if (reconciliar) {
                    this.firmaError = e?.response?.data?.error || "No se pudo actualizar el estado de firma.";
                }
                return false;
            }
        },

        detenerPollingFirma() {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
            }
            this._pollingEnCurso = false;
        },

        iniciarPolling() {
            this.detenerPollingFirma();
            this.pollingIntentos = 0;

            const debeSeguir = () =>
                this.pantalla === "firma" &&
                (!this.todosFirmados || this.requiereReconciliacionFirma()) &&
                this.pollingIntentos < FIRMA_POLLING_MAX_ATTEMPTS;

            if (!debeSeguir()) return;

            const tick = async () => {
                if (this._pollingEnCurso) return;
                if (!debeSeguir()) {
                    this.detenerPollingFirma();
                    return;
                }

                this.pollingIntentos += 1;
                this._pollingEnCurso = true;
                const ok = await this.refrescarEstado({ reconciliar: true });
                this._pollingEnCurso = false;

                if (!ok || !debeSeguir()) {
                    this.detenerPollingFirma();
                }
            };

            tick();
            this.pollingInterval = setInterval(tick, FIRMA_POLLING_INTERVAL_MS);
        },

        async yaFirme(docIndex) {
            const ok = await this.refrescarEstado({ reconciliar: true, docIndex });
            if (!ok) return;
            if (this.todosFirmados && !this.requiereReconciliacionFirma()) {
                this.pantalla = "completado";
                this.detenerPollingFirma();
            }
            else this.iniciarPolling();
        },

        destroy() {
            clearInterval(this._timer);
            this.detenerPollingFirma();
            if (this.pdfBlobUrl) URL.revokeObjectURL(this.pdfBlobUrl);
        }
    };
};
