function initSidebar() {
    const sidebar = document.querySelector(".sidebar");
    const toggleBtn = document.getElementById("sidebarToggle");
    const menuItems = document.querySelectorAll(".menu-item");
    const logoutBtn = document.querySelector(".logout-btn");

    if (!sidebar) return;

    if (toggleBtn) {
        toggleBtn.addEventListener("click", function () {
            sidebar.classList.toggle("collapsed");
            const isCollapsed = sidebar.classList.contains("collapsed");
            localStorage.setItem("sidebarCollapsed", isCollapsed);
        });
    }

    const savedState = localStorage.getItem("sidebarCollapsed");
    if (savedState === "true") {
        sidebar.classList.add("collapsed");
    }

    menuItems.forEach((item) => {
        const link = item.querySelector(".menu-link");
        if (!link) return;
        link.addEventListener("click", function () {
            menuItems.forEach((i) => i.classList.remove("active"));
            item.classList.add("active");
        });
    });

    if (logoutBtn) {
        logoutBtn.addEventListener("click", function () {
            if (confirm("¿Estás seguro de que quieres cerrar sesión?")) {
                console.log("Cerrando sesión...");
                window.location.href = "/login";
            }
        });
    }
}

window.initSidebar = initSidebar;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSidebar);
} else {
    initSidebar();
}
