window.azureDevOpsPruebaApp = function () {
    const API = window.API_BASE || "http://localhost:4000";
    const chartColors = [
        "#4f46e5",
        "#0ea5e9",
        "#14b8a6",
        "#f59e0b",
        "#8b5cf6",
        "#ef4444",
        "#64748b",
        "#ec4899"
    ];

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

    function countBy(items, field) {
        return items.reduce((counts, item) => {
            const key = String(item?.[field] ?? "").trim() || "Sin definir";
            counts.set(key, (counts.get(key) || 0) + 1);
            return counts;
        }, new Map());
    }

    return {
        loadingProjects: false,
        loadingItems: false,
        error: "",
        chartError: "",
        organization: "",
        projects: [],
        selectedProject: "",
        workItems: [],
        projectCount: 0,
        filterState: "",
        filterType: "",
        filterAssignedTo: "",
        filterPriority: "",
        typeChart: null,
        stateChart: null,

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
            this.resetFilters(false);
            this.destroyCharts();

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
            this.resetFilters(false);
            this.destroyCharts();

            try {
                const response = await axios.get(`${API}/azure-devops/work-items`, {
                    ...authConfig(),
                    params: { project: this.selectedProject }
                });
                this.workItems = response.data?.workItems || [];
                this.projectCount = Number(response.data?.projectCount || 1);
                this.scheduleCharts();
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

        resetFilters(render = true) {
            this.filterState = "";
            this.filterType = "";
            this.filterAssignedTo = "";
            this.filterPriority = "";
            if (render) this.scheduleCharts();
        },

        scheduleCharts() {
            window.setTimeout(() => this.renderCharts(), 0);
        },

        destroyCharts() {
            if (this.typeChart) {
                this.typeChart.destroy();
                this.typeChart = null;
            }
            if (this.stateChart) {
                this.stateChart.destroy();
                this.stateChart = null;
            }
        },

        renderCharts() {
            const typeCanvas = document.getElementById("azure-devops-type-chart");
            const stateCanvas = document.getElementById("azure-devops-state-chart");
            if (!typeCanvas || !stateCanvas) return;

            if (!window.Chart) {
                this.chartError = "No se pudo cargar Chart.js.";
                return;
            }
            this.chartError = "";

            this.destroyCharts();
            window.Chart.getChart(typeCanvas)?.destroy();
            window.Chart.getChart(stateCanvas)?.destroy();

            const filteredItems = this.filteredWorkItems;
            const typeCounts = countBy(filteredItems, "type");
            const stateCounts = countBy(filteredItems, "state");
            const typeLabels = [...typeCounts.keys()];
            const stateLabels = [...stateCounts.keys()];

            this.typeChart = new window.Chart(typeCanvas, {
                type: "doughnut",
                data: {
                    labels: typeLabels,
                    datasets: [{
                        data: typeLabels.map((label) => typeCounts.get(label)),
                        backgroundColor: typeLabels.map(
                            (_, index) => chartColors[index % chartColors.length]
                        ),
                        borderColor: "#ffffff",
                        borderWidth: 3,
                        hoverOffset: 8
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: "62%",
                    animation: {
                        duration: 900,
                        animateRotate: true,
                        animateScale: true
                    },
                    plugins: {
                        legend: {
                            position: "bottom",
                            labels: {
                                usePointStyle: true,
                                boxWidth: 8,
                                padding: 16
                            }
                        }
                    },
                    onClick: (_event, elements) => {
                        const index = elements?.[0]?.index;
                        if (index === undefined) return;
                        const value = typeLabels[index] === "Sin definir" ? "" : typeLabels[index];
                        this.filterType = this.filterType === value ? "" : value;
                        this.scheduleCharts();
                    }
                }
            });

            this.stateChart = new window.Chart(stateCanvas, {
                type: "bar",
                data: {
                    labels: stateLabels,
                    datasets: [{
                        label: "Registros",
                        data: stateLabels.map((label) => stateCounts.get(label)),
                        backgroundColor: stateLabels.map(
                            (_, index) => chartColors[index % chartColors.length]
                        ),
                        borderRadius: 7,
                        borderSkipped: false
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: {
                        duration: 900,
                        delay: (context) =>
                            context.type === "data" ? context.dataIndex * 70 : 0
                    },
                    scales: {
                        x: {
                            grid: { display: false }
                        },
                        y: {
                            beginAtZero: true,
                            ticks: { precision: 0 },
                            grid: { color: "rgba(148, 163, 184, 0.18)" }
                        }
                    },
                    plugins: {
                        legend: { display: false }
                    },
                    onClick: (_event, elements) => {
                        const index = elements?.[0]?.index;
                        if (index === undefined) return;
                        const value = stateLabels[index] === "Sin definir" ? "" : stateLabels[index];
                        this.filterState = this.filterState === value ? "" : value;
                        this.scheduleCharts();
                    }
                }
            });
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
