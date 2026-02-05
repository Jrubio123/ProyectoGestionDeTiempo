async function loadComponent(containerId, url, initFnName) {
    const container = document.getElementById(containerId);
    if (!container) return;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Error HTTP: ${res.status}`);
        const html = await res.text();
        container.innerHTML = html;

        const initFn = window[initFnName];
        if (typeof initFn === "function") {
            initFn();
        }
    } catch (error) {
        console.error(`Error cargando componente ${url}:`, error);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    loadComponent("navbar-container", "/components/navbar/navbar.html", "initNavbar");
    loadComponent("sidebar-container", "/components/sidebar/sidebar.html", "initSidebar");
});
