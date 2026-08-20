window.capacidadFabricaApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const CACHE_PREFIX = "capacidad-fabrica:v1";
    const CACHE_TTL_MS = 15 * 60 * 1000;

    function todayInBogota() {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Bogota",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    }

    return {
        roleKey: "other",
        puedeGestionar: false,
        tab: "dashboard",
        cargando: false,
        error: "",
        mensaje: "",
        catalogos: { categorias: [], estados: [], clientes: [], configuracion: { horas_semanales: 42 } },
        dashboard: { semana: {}, resumen: {}, personas: [] },
        requerimientos: [],
        personas: [],
        weekDate: todayInBogota(),
        incluirFinalizados: false,
        filtroRequerimiento: "",
        filtroOrigen: "",
        filtroEstado: "",
        busquedaPersona: "",
        busquedaMicrosoft: "",
        resultadosMicrosoft: [],
        buscandoMicrosoft: false,
        modalManual: false,
        guardandoManual: false,
        manual: {},
        modalDistribucion: false,
        guardandoDistribucion: false,
        requerimientoDistribucion: null,
        distribucion: [],
        modalHistorial: false,
        cargandoHistorial: false,
        historial: [],
        historialTitulo: "",

        async init() {
            this.roleKey = window.auth?.getRoleKey?.() || "other";
            this.puedeGestionar = this.roleKey === "admin" || this.roleKey === "coordinador";
            this.tab = this.puedeGestionar ? "dashboard" : "personas";
            await this.cargarCatalogos();
            await this.cargarPersonas();
            if (this.puedeGestionar) {
                await Promise.all([this.cargarDashboard(), this.cargarRequerimientos()]);
            }
        },

        authConfig(extra = {}) {
            const token = window.auth?.getToken?.() || localStorage.getItem("token");
            return {
                ...extra,
                headers: {
                    ...(extra.headers || {}),
                    Authorization: `Bearer ${token}`
                }
            };
        },

        userKey() {
            const user = window.auth?.getUser?.() || {};
            return String(user.id || user.email || "usuario").toLowerCase();
        },

        cacheKey(name) {
            return `${CACHE_PREFIX}:${this.userKey()}:${name}`;
        },

        readCache(name) {
            try {
                const key = this.cacheKey(name);
                const cached = JSON.parse(sessionStorage.getItem(key) || "null");
                if (!cached?.savedAt || Date.now() - cached.savedAt > CACHE_TTL_MS) {
                    sessionStorage.removeItem(key);
                    return null;
                }
                return cached.data;
            } catch (_) {
                return null;
            }
        },

        writeCache(name, data) {
            try {
                sessionStorage.setItem(this.cacheKey(name), JSON.stringify({ savedAt: Date.now(), data }));
            } catch (_) {
                // El módulo funciona aunque el navegador no permita almacenamiento de sesión.
            }
        },

        clearDataCache() {
            try {
                Object.keys(sessionStorage)
                    .filter((key) => key.startsWith(`${CACHE_PREFIX}:${this.userKey()}:`))
                    .forEach((key) => sessionStorage.removeItem(key));
            } catch (_) {}
        },

        errorText(error, fallback = "No fue posible completar la operación.") {
            return error?.response?.data?.error || error?.message || fallback;
        },

        notify(message) {
            this.mensaje = message;
            window.setTimeout(() => {
                if (this.mensaje === message) this.mensaje = "";
            }, 3500);
        },

        async cargarCatalogos() {
            const cached = this.readCache("catalogos");
            if (cached) {
                this.catalogos = cached;
                return;
            }
            try {
                const response = await axios.get(`${API}/capacidad-fabrica/catalogos`, this.authConfig());
                this.catalogos = response.data;
                this.writeCache("catalogos", response.data);
            } catch (error) {
                this.error = this.errorText(error, "No se cargó la configuración del módulo.");
            }
        },

        async cargarDashboard(force = false) {
            if (!this.puedeGestionar) return;
            const cacheName = `dashboard:${this.weekDate}`;
            const cached = force ? null : this.readCache(cacheName);
            if (cached) {
                this.dashboard = cached;
                return;
            }
            this.cargando = true;
            this.error = "";
            try {
                const response = await axios.get(`${API}/capacidad-fabrica/dashboard`, this.authConfig({
                    params: { fecha: this.weekDate }
                }));
                this.dashboard = response.data;
                this.writeCache(cacheName, response.data);
            } catch (error) {
                this.error = this.errorText(error, "No se calculó la capacidad semanal.");
            } finally {
                this.cargando = false;
            }
        },

        async cargarRequerimientos(force = false) {
            if (!this.puedeGestionar) return;
            const cacheName = `requerimientos:${this.incluirFinalizados}`;
            const cached = force ? null : this.readCache(cacheName);
            if (cached) {
                this.requerimientos = cached;
                return;
            }
            this.cargando = true;
            this.error = "";
            try {
                const response = await axios.get(`${API}/capacidad-fabrica/requerimientos`, this.authConfig({
                    params: { incluir_finalizados: this.incluirFinalizados }
                }));
                this.requerimientos = response.data || [];
                this.writeCache(cacheName, this.requerimientos);
            } catch (error) {
                this.error = this.errorText(error, "No se cargaron los requerimientos.");
            } finally {
                this.cargando = false;
            }
        },

        async cargarPersonas() {
            try {
                const response = await axios.get(`${API}/capacidad-fabrica/personas`, this.authConfig({
                    params: { q: this.busquedaPersona || undefined }
                }));
                this.personas = response.data || [];
            } catch (error) {
                this.error = this.errorText(error, "No se cargaron las personas.");
            }
        },

        async sincronizarAzure() {
            if (!this.puedeGestionar || this.cargando) return;
            this.cargando = true;
            this.error = "";
            try {
                const response = await axios.post(`${API}/capacidad-fabrica/sincronizar-azure`, {}, this.authConfig());
                const data = response.data || {};
                this.clearDataCache();
                await Promise.all([this.cargarCatalogos(), this.cargarRequerimientos(true), this.cargarDashboard(true)]);
                this.notify(`Azure sincronizado: ${data.creados || 0} nuevos y ${data.actualizados || 0} actualizados.`);
            } catch (error) {
                this.error = this.errorText(error, "No se pudo sincronizar Azure DevOps.");
            } finally {
                this.cargando = false;
            }
        },

        abrirManual() {
            const firstState = this.catalogos.estados.find((item) => item.codigo === "EN_ESTIMACION")
                || this.catalogos.estados[0];
            this.manual = {
                cliente_id: "",
                persona_id: "",
                tipo: "Requerimiento",
                titulo: "",
                estado_codigo: firstState?.codigo || "",
                effort_total: "",
                prioridad: 2,
                fecha_inicio: this.weekDate,
                fecha_fin: "",
                distribucion: this.catalogos.categorias.map((item) => ({
                    codigo: item.codigo,
                    nombre: item.nombre,
                    porcentaje: Number(item.porcentaje_predeterminado)
                }))
            };
            this.modalManual = true;
        },

        get totalManual() {
            return this.manual?.distribucion?.reduce((sum, item) => sum + Number(item.porcentaje || 0), 0) || 0;
        },

        async guardarManual() {
            this.guardandoManual = true;
            this.error = "";
            try {
                await axios.post(`${API}/capacidad-fabrica/requerimientos/manual`, this.manual, this.authConfig());
                this.modalManual = false;
                this.clearDataCache();
                await Promise.all([this.cargarRequerimientos(true), this.cargarDashboard(true)]);
                this.notify("Requerimiento manual creado.");
            } catch (error) {
                this.error = this.errorText(error, "No se creó el requerimiento.");
            } finally {
                this.guardandoManual = false;
            }
        },

        async cambiarEstado(item, code) {
            if (item.origen !== "MANUAL" || code === item.estado_codigo) return;
            const previous = item.estado_codigo;
            try {
                await axios.patch(`${API}/capacidad-fabrica/requerimientos/${item.id}`, {
                    estado_codigo: code
                }, this.authConfig());
                item.estado_codigo = code;
                item.estado = this.catalogos.estados.find((state) => state.codigo === code)?.nombre || code;
                this.clearDataCache();
                await this.cargarDashboard(true);
                this.notify("Estado actualizado.");
            } catch (error) {
                item.estado_codigo = previous;
                this.error = this.errorText(error, "No se actualizó el estado.");
            }
        },

        abrirDistribucion(item) {
            this.requerimientoDistribucion = item;
            const current = new Map((item.distribucion || []).map((entry) => [entry.codigo, Number(entry.porcentaje)]));
            this.distribucion = this.catalogos.categorias.map((category) => ({
                codigo: category.codigo,
                nombre: category.nombre,
                porcentaje: current.has(category.codigo)
                    ? current.get(category.codigo)
                    : Number(category.porcentaje_predeterminado)
            }));
            this.modalDistribucion = true;
        },

        get totalDistribucion() {
            return this.distribucion.reduce((sum, item) => sum + Number(item.porcentaje || 0), 0);
        },

        async guardarDistribucion() {
            if (!this.requerimientoDistribucion) return;
            this.guardandoDistribucion = true;
            this.error = "";
            try {
                await axios.put(
                    `${API}/capacidad-fabrica/requerimientos/${this.requerimientoDistribucion.id}/distribucion`,
                    { distribucion: this.distribucion },
                    this.authConfig()
                );
                this.modalDistribucion = false;
                this.clearDataCache();
                await Promise.all([this.cargarRequerimientos(true), this.cargarDashboard(true)]);
                this.notify("Distribución actualizada.");
            } catch (error) {
                this.error = this.errorText(error, "No se guardó la distribución.");
            } finally {
                this.guardandoDistribucion = false;
            }
        },

        async verHistorial(item) {
            this.modalHistorial = true;
            this.cargandoHistorial = true;
            this.historialTitulo = item.titulo;
            this.historial = [];
            try {
                const response = await axios.get(
                    `${API}/capacidad-fabrica/requerimientos/${item.id}/historial`,
                    this.authConfig()
                );
                this.historial = response.data || [];
            } catch (error) {
                this.error = this.errorText(error, "No se cargó el historial.");
            } finally {
                this.cargandoHistorial = false;
            }
        },

        async buscarMicrosoft() {
            if (this.busquedaMicrosoft.trim().length < 2) {
                this.resultadosMicrosoft = [];
                return;
            }
            this.buscandoMicrosoft = true;
            try {
                const response = await axios.get(`${API}/admin/tenant/usuarios`, this.authConfig({
                    params: { q: this.busquedaMicrosoft.trim() }
                }));
                this.resultadosMicrosoft = response.data || [];
            } catch (error) {
                this.error = this.errorText(error, "No se pudo buscar en Microsoft 365.");
            } finally {
                this.buscandoMicrosoft = false;
            }
        },

        async agregarDesdeMicrosoft(person) {
            try {
                await axios.post(`${API}/capacidad-fabrica/personas/desde-microsoft`, person, this.authConfig());
                this.resultadosMicrosoft = this.resultadosMicrosoft.filter((item) => item.azure_oid !== person.azure_oid);
                await this.cargarPersonas();
                this.clearDataCache();
                if (this.puedeGestionar) await this.cargarDashboard(true);
                this.notify("Persona vinculada y marcada como Fábrica.");
            } catch (error) {
                this.error = this.errorText(error, "No se vinculó la persona.");
            }
        },

        async cambiarPertenencia(person) {
            const desired = !person.pertenece_fabrica;
            try {
                await axios.patch(`${API}/capacidad-fabrica/personas/${person.id}/fabrica`, {
                    pertenece_fabrica: desired
                }, this.authConfig());
                person.pertenece_fabrica = desired;
                this.clearDataCache();
                if (this.puedeGestionar) await this.cargarDashboard(true);
                this.notify(desired ? "Persona agregada a Fábrica." : "Persona retirada de Fábrica.");
            } catch (error) {
                this.error = this.errorText(error, "No se actualizó la persona.");
            }
        },

        get requerimientosFiltrados() {
            const text = this.filtroRequerimiento.trim().toLowerCase();
            return this.requerimientos.filter((item) => {
                if (this.filtroOrigen && item.origen !== this.filtroOrigen) return false;
                if (this.filtroEstado && item.estado_codigo !== this.filtroEstado) return false;
                if (!text) return true;
                return [item.external_id, item.cliente, item.titulo, item.responsable]
                    .some((value) => String(value || "").toLowerCase().includes(text));
            });
        },

        integrantesFabrica() {
            return this.personas.filter((person) => person.pertenece_fabrica);
        },

        occupancyClass(value) {
            const percentage = Number(value || 0);
            if (percentage > 100) return "bg-red-500";
            if (percentage >= 80) return "bg-amber-500";
            return "bg-emerald-500";
        },

        formatNumber(value) {
            return new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(Number(value || 0));
        },

        formatDate(value, includeTime = false) {
            if (!value) return "—";
            return new Intl.DateTimeFormat("es-CO", includeTime
                ? { dateStyle: "short", timeStyle: "short", timeZone: "America/Bogota" }
                : { dateStyle: "medium", timeZone: "UTC" }
            ).format(new Date(value));
        }
    };
};
