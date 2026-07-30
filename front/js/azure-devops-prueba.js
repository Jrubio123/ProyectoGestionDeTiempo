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

        async init() {
            await this.loadProjects();
        },

        async loadProjects() {
            this.loadingProjects = true;
            this.error = "";
            this.projects = [];
            this.workItems = [];

            try {
                const response = await axios.get(`${API}/azure-devops/projects`, authConfig());
                this.organization = response.data?.organization || "";
                this.projects = response.data?.projects || [];
                if (this.projects.length > 0) {
                    this.selectedProject = this.projects[0].name;
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

            try {
                const response = await axios.get(`${API}/azure-devops/work-items`, {
                    ...authConfig(),
                    params: { project: this.selectedProject }
                });
                this.workItems = response.data?.workItems || [];
            } catch (error) {
                this.error = errorMessage(error);
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
