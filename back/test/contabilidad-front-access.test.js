const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("la proyección de pagos está registrada como vista y ruta", () => {
  const router = read("front/router.js");

  assert.match(router, /contabilidad:\s+"\/js\/contabilidad\.js"/);
  assert.match(router, /contabilidad:\s*"contabilidad"/);
  assert.equal(fs.existsSync(path.join(root, "front/views/contabilidad.html")), true);
  assert.equal(fs.existsSync(path.join(root, "front/js/contabilidad.js")), true);
});

test("el menú de contabilidad se muestra solo a los tres roles autorizados", () => {
  const sidebarHtml = read("front/components/sidebar/sidebar.html");
  const sidebarJs = read("front/components/sidebar/sidebar.js");
  const router = read("front/router.js");

  assert.match(sidebarHtml, /data-roles="admin contabilidad talento_humano"/);
  assert.match(sidebarHtml, /href="#contabilidad"/);
  assert.match(sidebarJs, /roleRoutes\.contabilidad\s*=\s*\["inicio",\s*"contabilidad",\s*"vacaciones"\]/);
  assert.match(router, /roleRoutes\.contabilidad\s*=\s*\["inicio",\s*"contabilidad",\s*"vacaciones"\]/);
  assert.match(router, /talento_humano:\s*\[[^\]]*"contabilidad"\]/);
  assert.match(router, /admin:\s*\[[^\]]*"contabilidad"\]/);
});

test("la vista usa los endpoints del módulo de contabilidad", () => {
  const viewScript = read("front/js/contabilidad.js");

  assert.match(viewScript, /\/api\/contabilidad\/proyeccion\/generar/);
  assert.match(viewScript, /\/api\/contabilidad\/proyeccion\/\$\{encodeURIComponent\(id\)\}\/detalles/);
  assert.match(viewScript, /\/api\/contabilidad\/retenciones\/simular/);
  assert.match(viewScript, /\/api\/contabilidad\/proyeccion\/\$\{encodeURIComponent\(this\.proyeccion\.id\)\}\/transicion/);
});
