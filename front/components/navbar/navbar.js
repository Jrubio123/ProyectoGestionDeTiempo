function initNavbar() {
    const navLinks = document.querySelectorAll(".nav-link");

    function setActiveByHash() {
        const hash = window.location.hash || "#inicio";
        navLinks.forEach((link) => {
            if (link.getAttribute("href") === hash) {
                link.classList.add("active");
            } else {
                link.classList.remove("active");
            }
        });
    }

    setActiveByHash();
    window.addEventListener("hashchange", setActiveByHash);

    navLinks.forEach((link) => {
        link.addEventListener("click", function () {
            navLinks.forEach((l) => l.classList.remove("active"));
            this.classList.add("active");
        });
    });

    const searchInput = document.querySelector(".search-input");
    if (searchInput) {
        searchInput.addEventListener("keypress", function (e) {
            if (e.key === "Enter") {
                performSearch(this.value);
            }
        });
    }
}

function performSearch(query) {
    if (query.trim()) {
        console.log("Buscando:", query);
        alert(`Buscando: ${query}`);
    }
}

window.initNavbar = initNavbar;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNavbar);
} else {
    initNavbar();
}
