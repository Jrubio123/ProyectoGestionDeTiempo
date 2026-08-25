// js/gestion-personas.js
window.gestionPersonasApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

    return {
        puedeEditar: false,
        puedeCambiarActivo: false,
        puedeAgregar: false,
        puedeExportar: false,
        puedeExportarCompleto: false,
        tipoExportacion: "operativa",
        exportando: false,
        cargando: false,
        cargandoFicha: false,
        modalAddPersonaOpen: false,
        guardandoAdd: false,
        buscando: false,
        addError: "",
        tenantUsuarios: [],
        usuarioSeleccionado: "",
        addForm: {
            azure_oid: "",
            nombre: "",
            apellidos: "",
            email: "",
            tipo_documento_id: "",
            numero_documento: ""
        },

        personas: [],
        filtroTexto: "",
        filtroRol: "todos",
        filtroEstado: "todos",

        ficha: null,

        cat: {
            roles: [],
            bancos: [],
            tiposCuenta: [],
            tiposDocumento: [],
            principales: []
        },

        editando: {
            identidad: false,
            personal: false,
            cobro: false,
            laboral: false,
            operativa: false
        },
        draft: {
            identidad: {},
            personal: {},
            cobro: {},
            laboral: {},
            operativa: {}
        },
        guardando: {
            identidad: false,
            personal: false,
            cobro: false,
            laboral: false,
            operativa: false
        },
        errores: {
            identidad: null,
            personal: null,
            cobro: null,
            laboral: null,
            operativa: null
        },

        async init() {
            const cfg = this.getAuthConfig();
            if (!cfg) {
                window.location.href = "/login.html";
                return;
            }

            const roleKey = window.auth?.getRoleKey?.() || "other";
            this.puedeEditar = roleKey === "admin" || roleKey === "talento_humano";
            this.puedeCambiarActivo = roleKey === "admin";
            this.puedeAgregar = this.puedeEditar;
            this.puedeExportar = this.puedeEditar;
            this.puedeExportarCompleto = roleKey === "talento_humano";

            await Promise.all([
                this.cargarPersonas(),
                this.puedeEditar ? this.cargarCatalogos() : Promise.resolve()
            ]);
        },

        getAuthConfig() {
            const token = window.auth?.getToken?.();
            return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        },

        async cargarPersonas() {
            this.cargando = true;
            try {
                const res = await axios.get(`${API}/admin/personas`, this.getAuthConfig());
                this.personas = res.data || [];
            } catch (e) {
                this.personas = [];
            } finally {
                this.cargando = false;
            }
        },

        resetAddForm() {
            this.addForm = {
                azure_oid: "",
                nombre: "",
                apellidos: "",
                email: "",
                tipo_documento_id: "",
                numero_documento: ""
            };
            this.usuarioSeleccionado = "";
            this.addError = "";
        },

        abrirModalAgregar() {
            this.resetAddForm();
            this.modalAddPersonaOpen = true;
            this.cargarUsuariosTenant();
        },

        cerrarModalAgregar() {
            if (this.guardandoAdd) return;
            this.modalAddPersonaOpen = false;
            this.addError = "";
        },

        async cargarUsuariosTenant(q = "") {
            const query = String(q || "").trim();
            this.buscando = true;
            try {
                const cfg = this.getAuthConfig() || {};
                const res = await axios.get(`${API}/admin/tenant/usuarios`, {
                    ...cfg,
                    params: query.length >= 2 ? { q: query } : {}
                });
                this.tenantUsuarios = res.data || [];
            } catch (e) {
                this.tenantUsuarios = [];
            } finally {
                this.buscando = false;
            }
        },

        async buscarUsuariosTenant() {
            await this.cargarUsuariosTenant(this.usuarioSeleccionado || this.addForm.email);
        },

        aplicarUsuarioTenant(usuario) {
            if (!usuario) return;
            const nombreCompleto = String(usuario.nombre_usuario || "").trim();
            const partes = nombreCompleto.split(/\s+/).filter(Boolean);
            const nombreFallback = partes.shift() || "";
            const apellidosFallback = partes.join(" ");

            this.addForm.email = usuario.email || this.addForm.email;
            this.addForm.azure_oid = usuario.azure_oid || "";
            this.addForm.nombre = String(usuario.nombre || "").trim() || nombreFallback || this.addForm.nombre;
            this.addForm.apellidos = String(usuario.apellidos || "").trim() || apellidosFallback || this.addForm.apellidos;
            this.usuarioSeleccionado = `${usuario.nombre_usuario || ""} - ${usuario.email || ""}`;
            this.addError = "";
        },

        async cargarUsuarioSeleccionado() {
            const q = this.usuarioSeleccionado.trim().toLowerCase();
            if (!q) return;

            const usuario = this.tenantUsuarios.find((u) => {
                const label = `${u.nombre_usuario || ""} - ${u.email || ""}`.toLowerCase();
                const email = String(u.email || "").toLowerCase();
                return label === q || email === q;
            });

            if (!usuario?.email) {
                this.addError = "Selecciona un usuario valido de la lista";
                return;
            }

            this.aplicarUsuarioTenant(usuario);
        },

        async cargarDesdeEmailTenant() {
            const q = this.addForm.email.trim().toLowerCase();
            if (!q) return;

            let usuario = this.tenantUsuarios.find(
                (u) => String(u.email || "").toLowerCase() === q
            );
            if (!usuario && q.length >= 2) {
                await this.cargarUsuariosTenant(q);
                usuario = this.tenantUsuarios.find(
                    (u) => String(u.email || "").toLowerCase() === q
                );
            }
            if (usuario) {
                this.aplicarUsuarioTenant(usuario);
            }
        },

        async crearPersona() {
            this.guardandoAdd = true;
            this.addError = "";
            try {
                const payload = { ...this.addForm };
                delete payload.azure_oid;
                await axios.post(`${API}/admin/personas`, payload, this.getAuthConfig());
                this.modalAddPersonaOpen = false;
                alert("Persona creada correctamente");
                await this.cargarPersonas();
            } catch (err) {
                this.addError = err?.response?.data?.error || "Error al crear persona";
            } finally {
                this.guardandoAdd = false;
            }
        },

        get personasFiltradas() {
            return this.personas.filter((p) => {
                const txt = String(this.filtroTexto || "").toLowerCase().trim();
                const matchTxt = !txt ||
                    String(p.nombre_usuario || "").toLowerCase().includes(txt) ||
                    String(p.email || "").toLowerCase().includes(txt) ||
                    String(p.rol || "").toLowerCase().includes(txt) ||
                    String(p.ciudad || "").toLowerCase().includes(txt);

                const matchRol = this.filtroRol === "todos" || String(p.rol || "") === this.filtroRol;
                const matchEstado =
                    this.filtroEstado === "todos" ||
                    (this.filtroEstado === "activos" && p.activo) ||
                    (this.filtroEstado === "inactivos" && !p.activo);

                return matchTxt && matchRol && matchEstado;
            });
        },

        get rolesUnicos() {
            const set = new Set(this.personas.map((p) => p.rol).filter(Boolean));
            return Array.from(set).sort();
        },

        async cargarLibreriaExcel() {
            if (window.XLSX) return;
            await new Promise((resolve, reject) => {
                const existente = document.querySelector('script[data-personas-xlsx="true"]');
                if (existente) {
                    existente.addEventListener("load", resolve, { once: true });
                    existente.addEventListener("error", reject, { once: true });
                    return;
                }
                const script = document.createElement("script");
                script.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
                script.dataset.personasXlsx = "true";
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        },

        async descargarExcelPersonas() {
            if (!this.puedeExportar || this.exportando) return;
            if (this.tipoExportacion === "completa" && !this.puedeExportarCompleto) return;
            if (
                this.tipoExportacion === "completa" &&
                !confirm("El archivo completo contiene datos personales y bancarios. Deseas descargarlo?")
            ) return;

            this.exportando = true;
            try {
                await this.cargarLibreriaExcel();
                const cfg = this.getAuthConfig() || {};
                const params = { tipo: this.tipoExportacion };
                if (this.filtroRol !== "todos") params.rol = this.filtroRol;
                const res = await axios.get(`${API}/admin/personas/exportar`, { ...cfg, params });
                const filas = Array.isArray(res.data?.filas) ? res.data.filas : [];
                if (!filas.length) {
                    alert("No hay personas para el rol seleccionado.");
                    return;
                }

                const columnas = Array.from(new Set(filas.flatMap((fila) => Object.keys(fila || {}))));
                const hoja = window.XLSX.utils.json_to_sheet(filas, { header: columnas });
                hoja["!cols"] = columnas.map((columna) => ({
                    wch: Math.min(
                        45,
                        Math.max(12, columna.length + 2, ...filas.slice(0, 100).map((fila) => String(fila[columna] ?? "").length + 2))
                    )
                }));
                const libro = window.XLSX.utils.book_new();
                window.XLSX.utils.book_append_sheet(libro, hoja, "Personas");

                const rol = this.filtroRol === "todos"
                    ? "todos"
                    : String(this.filtroRol).toLowerCase().replace(/[^a-z0-9]+/g, "-");
                const fecha = new Date().toISOString().slice(0, 10);
                window.XLSX.writeFile(libro, `personas-${this.tipoExportacion}-${rol}-${fecha}.xlsx`);
            } catch (err) {
                alert(err?.response?.data?.error || "No se pudo generar el Excel de personas.");
            } finally {
                this.exportando = false;
            }
        },

        get fichaSinUsuario() {
            return this.ficha?.registro_tipo === "persona" || !this.ficha?.usuario_id;
        },

        get fichaEsVinculada() {
            return String(this.ficha?.tipo_vinculacion || "").toLowerCase() === "vinculado";
        },

        get cargoActual() {
            return this.ficha?.cargo_actual || this.ficha?.cargo || this.ficha?.solicitud_perfil || this.ficha?.persona_modulo || "-";
        },

        get responsableActual() {
            return this.ficha?.responsable_actual || this.ficha?.jefe_inmediato || this.ficha?.supervisor_nombre || "-";
        },

        get monedaRelacion() {
            return this.ficha?.moneda_relacion || (this.fichaEsVinculada ? this.ficha?.salario_moneda : this.ficha?.moneda_cobro) || "-";
        },

        get tarifaRelacion() {
            if (this.fichaEsVinculada) return null;
            const modalidad = String(this.ficha?.solicitud_modalidad || this.ficha?.modalidad || "").toLowerCase();
            if (modalidad.includes("hora")) return this.ficha?.tarifa_hora;
            if (modalidad.includes("medio")) return this.ficha?.tarifa_medio_tiempo || this.ficha?.tarifa_mes;
            return this.ficha?.tarifa_mes || this.ficha?.tarifa_hora || this.ficha?.tarifa_capacitacion;
        },

        endpointFicha(persona = this.ficha) {
            if (!persona) return null;
            const sinUsuario = persona.registro_tipo === "persona" || !persona.usuario_id;
            const id = sinUsuario
                ? (persona.persona_public_id || persona.id)
                : (persona.usuario_id || persona.id);
            return sinUsuario ? `${API}/admin/personas/p/${id}` : `${API}/admin/personas/${id}`;
        },

        async seleccionar(persona) {
            if (this.ficha?.id === persona.id) return;
            this.ficha = null;
            this.cerrarTodosLosDrafts();
            this.cargandoFicha = true;
            try {
                const res = await axios.get(this.endpointFicha(persona), this.getAuthConfig());
                this.ficha = res.data;
            } catch (e) {
                this.ficha = null;
            } finally {
                this.cargandoFicha = false;
            }
        },

        cerrarTodosLosDrafts() {
            Object.keys(this.editando).forEach((k) => {
                this.editando[k] = false;
                this.errores[k] = null;
            });
        },

        async cargarCatalogos() {
            try {
                const [resRoles, resBancos, resTiposCuenta, resDocs, resPrincipales] = await Promise.all([
                    axios.get(`${API}/admin/roles`, this.getAuthConfig()),
                    axios.get(`${API}/admin/bancos`, this.getAuthConfig()),
                    axios.get(`${API}/admin/tipos-cuenta-bancaria`, this.getAuthConfig()),
                    axios.get(`${API}/documentos-identidad`, this.getAuthConfig()),
                    axios.get(`${API}/consultores/principales`, this.getAuthConfig())
                ]);

                this.cat.roles = resRoles.data || [];
                this.cat.bancos = resBancos.data || [];
                this.cat.tiposCuenta = resTiposCuenta.data || [];
                this.cat.tiposDocumento = resDocs.data || [];
                this.cat.principales = resPrincipales.data || [];
            } catch (e) {
                this.cat.roles = [];
                this.cat.bancos = [];
                this.cat.tiposCuenta = [];
                this.cat.tiposDocumento = [];
                this.cat.principales = [];
            }
        },

        abrirEdicion(seccion) {
            if (this.fichaSinUsuario && ["identidad", "operativa"].includes(seccion)) return;
            this.cerrarTodosLosDrafts();
            this.editando[seccion] = true;

            if (seccion === "identidad") {
                this.draft.identidad = {
                    nombre_usuario: this.ficha?.nombre_usuario || "",
                    email: this.ficha?.email || "",
                    rol_id: this.ficha?.rol_id || "",
                    activo: Boolean(this.ficha?.activo),
                    azure_oid: this.ficha?.azure_oid || ""
                };
                return;
            }

            if (seccion === "personal") {
                this.draft.personal = {
                    tipo_documento_id: this.ficha?.tipo_documento_id || "",
                    cedula: this.ficha?.cedula || "",
                    telefono: this.ficha?.telefono || "",
                    direccion: this.ficha?.direccion || "",
                    ciudad: this.ficha?.ciudad || "",
                    tipo_persona: this.ficha?.tipo_persona || ""
                };
                return;
            }

            if (seccion === "cobro") {
                this.draft.cobro = {
                    moneda_cobro: this.ficha?.moneda_cobro || "COP",
                    banco_id: this.ficha?.banco_id || "",
                    tipo_cuenta_id: this.ficha?.tipo_cuenta_id || "",
                    nro_cuenta_bancaria: this.ficha?.nro_cuenta_bancaria || "",
                    factura_en_colombia:
                        this.ficha?.factura_en_colombia === true ? "true" :
                        this.ficha?.factura_en_colombia === false ? "false" : ""
                };
                return;
            }

            if (seccion === "laboral") {
                this.draft.laboral = {
                    tipo_trabajador: this.ficha?.tipo_trabajador || "",
                    cargo: this.ficha?.cargo || "",
                    salario_mensual: this.ficha?.salario_mensual || "",
                    salario_moneda: this.ficha?.salario_moneda || "COP",
                    periodo_pago: this.ficha?.periodo_pago || "",
                    periodo_prueba: this.ficha?.periodo_prueba || "",
                    jefe_inmediato: this.ficha?.jefe_inmediato || "",
                    caja_compensacion: this.ficha?.caja_compensacion || "",
                    condiciones_especiales: this.ficha?.condiciones_especiales || "",
                    duracion_contrato: this.ficha?.duracion_contrato || "",
                    fecha_inicio_labores: this.ficha?.fecha_inicio_labores ? String(this.ficha.fecha_inicio_labores).slice(0, 10) : "",
                    lugar_celebracion: this.ficha?.lugar_celebracion || "",
                    eps: this.ficha?.eps || "",
                    afp: this.ficha?.afp || "",
                    arl: this.ficha?.arl || ""
                };
                return;
            }

            if (seccion === "operativa") {
                this.draft.operativa = {
                    tipo_consultor: this.ficha?.tipo_consultor || "",
                    consultor_principal_id: this.ficha?.consultor_principal_id || ""
                };
            }
        },

        cancelarEdicion(seccion) {
            this.editando[seccion] = false;
            this.errores[seccion] = null;
        },

        async guardar(seccion) {
            this.guardando[seccion] = true;
            this.errores[seccion] = null;
            const payload = { ...this.draft[seccion] };

            if (seccion === "identidad") {
                if (this.puedeCambiarActivo) {
                    payload.activo = payload.activo === true || String(payload.activo).toLowerCase() === "true";
                } else {
                    delete payload.activo;
                }
            }

            Object.keys(payload).forEach((k) => {
                if (payload[k] === "") payload[k] = null;
            });

            try {
                const fichaEndpoint = this.endpointFicha();
                await axios.put(
                    `${fichaEndpoint}/${seccion}`,
                    payload,
                    this.getAuthConfig()
                );

                const res = await axios.get(fichaEndpoint, this.getAuthConfig());
                this.ficha = res.data;

                const idx = this.personas.findIndex((p) => p.id === this.ficha.id);
                if (idx !== -1) {
                    this.personas[idx] = {
                        ...this.personas[idx],
                        nombre_usuario: this.ficha.nombre_usuario,
                        email: this.ficha.email,
                        activo: this.ficha.activo,
                        rol: this.ficha.rol,
                        ciudad: this.ficha.ciudad
                    };
                }

                this.editando[seccion] = false;
            } catch (err) {
                this.errores[seccion] = err?.response?.data?.error || "Error al guardar";
            } finally {
                this.guardando[seccion] = false;
            }
        },

        inicialAvatar(nombre) {
            return String(nombre || "?").charAt(0).toUpperCase();
        },

        colorAvatar(rol) {
            const mapa = {
                Administrador: "bg-indigo-600",
                Coordinador: "bg-purple-500",
                Consultor: "bg-emerald-500",
                Reclutador: "bg-amber-500",
                Comercial: "bg-sky-500",
                "Talento Humano": "bg-rose-500"
            };
            return mapa[rol] || "bg-slate-400";
        },

        formatFechaHora(ts) {
            if (!ts) return "-";
            try {
                return new Date(ts).toLocaleString("es-CO", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit"
                });
            } catch {
                return "-";
            }
        },

        formatMonto(value, moneda) {
            if (value === null || value === undefined || value === "") return "-";
            const numero = Number(value);
            if (!Number.isFinite(numero)) return "-";
            try {
                return new Intl.NumberFormat("es-CO", {
                    style: "currency",
                    currency: String(moneda || "COP").toUpperCase(),
                    maximumFractionDigits: 2
                }).format(numero);
            } catch (_) {
                return `${moneda || ""} ${numero}`.trim();
            }
        }
    };
};
