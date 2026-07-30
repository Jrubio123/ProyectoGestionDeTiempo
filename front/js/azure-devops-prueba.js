window.azureDevOpsPruebaApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const CACHE_PREFIX = "azure-devops:work-items:v1";
    const CACHE_TTL_MS = 15 * 60 * 1000;

    function authConfig() {
        const token = window.auth?.getToken?.() || localStorage.getItem("token");
        return {
            headers: {
                Authorization: `Bearer ${token}`
            }
        };
    }

    function errorMessage(error) {
        return error?.response?.data?.error || error?.message || "No fue posible consultar Azure DevOps.";
    }

    function uniqueSorted(values) {
        return [...new Set(values.filter(Boolean))]
            .sort((left, right) =>
                String(left).localeCompare(String(right), "es", { sensitivity: "base" })
            );
    }

    function currentUserKey() {
        const user = window.auth?.getUser?.() || {};
        return String(user.id || user.email || "usuario").trim().toLowerCase();
    }

    function cacheKey(organization, project) {
        return [
            CACHE_PREFIX,
            currentUserKey(),
            String(organization || "").trim().toLowerCase(),
            String(project || "").trim().toLowerCase()
        ].join(":");
    }

    function readCache(organization, project) {
        try {
            const key = cacheKey(organization, project);
            const raw = sessionStorage.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const savedAt = Number(parsed?.savedAt || 0);
            if (!savedAt || Date.now() - savedAt > CACHE_TTL_MS) {
                sessionStorage.removeItem(key);
                return null;
            }
            return parsed;
        } catch (error) {
            return null;
        }
    }

    function writeCache(organization, project, data) {
        try {
            sessionStorage.setItem(
                cacheKey(organization, project),
                JSON.stringify({
                    savedAt: Date.now(),
                    data
                })
            );
        } catch (error) {
            // La memoria de la pestaña puede estar bloqueada o sin espacio.
        }
    }

    return {
        loadingProjects: false,
        loadingItems: false,
        error: "",
        organization: "",
        projects: [],
        selectedProject: "",
        loadedProject: "",
        workItems: [],
        projectCount: 0,
        dataSource: "",
        lastLoadedAt: null,
        filterState: "",
        filterType: "",
        filterAssignedTo: "",
        filterPriority: "",

        async init() {
            await this.loadProjects();
        },

        async loadProjects() {
            this.loadingProjects = true;
            this.error = "";
            this.projects = [];
            this.workItems = [];
            this.selectedProject = "";
            this.loadedProject = "";
            this.projectCount = 0;
            this.dataSource = "";
            this.lastLoadedAt = null;
            this.resetFilters();

            try {
                const response = await axios.get(`${API}/azure-devops/projects`, authConfig());
                this.organization = response.data?.organization || "";
                this.projects = response.data?.projects || [];
                if (this.projects.length > 0) {
                    this.selectedProject = "__all__";
                    this.loadCachedWorkItems();
                }
            } catch (error) {
                this.error = errorMessage(error);
            } finally {
                this.loadingProjects = false;
            }
        },

        applyWorkItemsData(data, project, source, savedAt) {
            this.workItems = data?.workItems || [];
            this.projectCount = Number(data?.projectCount || 1);
            this.loadedProject = project;
            this.dataSource = source;
            this.lastLoadedAt = savedAt ? new Date(savedAt) : new Date();
            this.resetFilters();
        },

        loadCachedWorkItems() {
            this.error = "";
            this.workItems = [];
            this.loadedProject = "";
            this.projectCount = 0;
            this.dataSource = "";
            this.lastLoadedAt = null;
            this.resetFilters();

            if (!this.selectedProject) return false;
            const cached = readCache(this.organization, this.selectedProject);
            if (!cached?.data) return false;
            this.applyWorkItemsData(
                cached.data,
                this.selectedProject,
                "cache",
                cached.savedAt
            );
            return true;
        },

        async loadWorkItems(forceRefresh = false) {
            if (!this.selectedProject) return;
            const requestedProject = this.selectedProject;

            if (!forceRefresh) {
                const cached = readCache(this.organization, requestedProject);
                if (cached?.data) {
                    this.applyWorkItemsData(
                        cached.data,
                        requestedProject,
                        "cache",
                        cached.savedAt
                    );
                    return;
                }
            }

            this.loadingItems = true;
            this.error = "";
            this.workItems = [];
            this.loadedProject = "";
            this.projectCount = 0;
            this.dataSource = "";
            this.lastLoadedAt = null;
            this.resetFilters();

            try {
                const response = await axios.get(`${API}/azure-devops/work-items`, {
                    ...authConfig(),
                    params: { project: requestedProject }
                });
                if (this.selectedProject !== requestedProject) return;
                writeCache(this.organization, requestedProject, response.data || {});
                this.applyWorkItemsData(
                    response.data || {},
                    requestedProject,
                    "azure",
                    Date.now()
                );
            } catch (error) {
                this.error = errorMessage(error);
                this.projectCount = 0;
            } finally {
                this.loadingItems = false;
            }
        },

        get stateOptions() {
            return uniqueSorted(this.workItems.map((item) => item.state));
        },

        get typeOptions() {
            return uniqueSorted(this.workItems.map((item) => item.type));
        },

        get assignedToOptions() {
            return uniqueSorted(
                this.workItems.map((item) => item.assignedTo || "Sin asignar")
            );
        },

        get priorityOptions() {
            return uniqueSorted(
                this.workItems
                    .filter((item) => item.priority !== null && item.priority !== undefined)
                    .map((item) => String(item.priority))
            );
        },

        get filteredWorkItems() {
            return this.workItems.filter((item) => {
                if (this.filterState && item.state !== this.filterState) return false;
                if (this.filterType && item.type !== this.filterType) return false;
                if (
                    this.filterAssignedTo &&
                    (item.assignedTo || "Sin asignar") !== this.filterAssignedTo
                ) {
                    return false;
                }
                if (
                    this.filterPriority &&
                    String(item.priority ?? "") !== this.filterPriority
                ) {
                    return false;
                }
                return true;
            });
        },

        resetFilters() {
            this.filterState = "";
            this.filterType = "";
            this.filterAssignedTo = "";
            this.filterPriority = "";
        },

        formatDate(value) {
            if (!value) return "—";
            return new Intl.DateTimeFormat("es-CO", {
                dateStyle: "short",
                timeStyle: "short"
            }).format(new Date(value));
        },

        formatLoadedAt() {
            if (!this.lastLoadedAt) return "";
            return new Intl.DateTimeFormat("es-CO", {
                dateStyle: "short",
                timeStyle: "short"
            }).format(this.lastLoadedAt);
        }
    };
};
