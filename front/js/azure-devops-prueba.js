window.azureDevOpsPruebaApp = function () {
    const API = window.API_BASE || "http://localhost:4000";

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

    return {
        loadingProjects: false,
        loadingItems: false,
        error: "",
        organization: "",
        projects: [],
        selectedProject: "",
        workItems: [],
        projectCount: 0,

        async init() {
            await this.loadProjects();
        },

        async loadProjects() {
            this.loadingProjects = true;
            this.error = "";
            this.projects = [];
            this.workItems = [];
            this.selectedProject = "";
            this.projectCount = 0;

            try {
                const response = await axios.get(`${API}/azure-devops/projects`, authConfig());
                this.organization = response.data?.organization || "";
                this.projects = response.data?.projects || [];
                if (this.projects.length > 0) {
                    this.selectedProject = "__all__";
                }
            } catch (error) {
                this.error = errorMessage(error);
            } finally {
                this.loadingProjects = false;
            }
        },

        async loadWorkItems() {
            if (!this.selectedProject) return;
            this.loadingItems = true;
            this.error = "";
            this.workItems = [];
            this.projectCount = 0;

            try {
                const response = await axios.get(`${API}/azure-devops/work-items`, {
                    ...authConfig(),
                    params: { project: this.selectedProject }
                });
                this.workItems = response.data?.workItems || [];
                this.projectCount = Number(response.data?.projectCount || 1);
            } catch (error) {
                this.error = errorMessage(error);
                this.projectCount = 0;
            } finally {
                this.loadingItems = false;
            }
        },

        formatDate(value) {
            if (!value) return "—";
            return new Intl.DateTimeFormat("es-CO", {
                dateStyle: "short",
                timeStyle: "short"
            }).format(new Date(value));
        }
    };
};
