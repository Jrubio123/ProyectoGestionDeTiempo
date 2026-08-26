const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildUserAssignedLicenses } = require("../src/services/usuarios.service");

const routesSource = fs.readFileSync(
  path.resolve(__dirname, "../src/routes/usuarios.routes.js"),
  "utf8"
);
const frontSource = fs.readFileSync(
  path.resolve(__dirname, "../../front/js/gestion-licencias-admin.js"),
  "utf8"
);

test("distingue licencias directas, heredadas y mixtas", () => {
  const licenses = buildUserAssignedLicenses(
    {
      assignedLicenses: [
        { skuId: "SKU-DIRECTA" },
        { skuId: "SKU-GRUPO" },
        { skuId: "SKU-MIXTA" }
      ],
      licenseAssignmentStates: [
        { skuId: "SKU-DIRECTA", assignedByGroup: null, state: "Active" },
        { skuId: "SKU-GRUPO", assignedByGroup: "grupo-1", state: "Active" },
        { skuId: "SKU-MIXTA", assignedByGroup: null, state: "Active" },
        { skuId: "SKU-MIXTA", assignedByGroup: "grupo-2", state: "Active" }
      ]
    },
    new Map([
      ["sku-directa", "MICROSOFT_365_DIRECTA"],
      ["sku-grupo", "MICROSOFT_365_GRUPO"],
      ["sku-mixta", "MICROSOFT_365_MIXTA"]
    ])
  );

  assert.deepEqual(
    licenses.map(({ skuPartNumber, assignmentType, removable }) => ({
      skuPartNumber,
      assignmentType,
      removable
    })),
    [
      { skuPartNumber: "MICROSOFT_365_DIRECTA", assignmentType: "directa", removable: true },
      { skuPartNumber: "MICROSOFT_365_GRUPO", assignmentType: "grupo", removable: false },
      { skuPartNumber: "MICROSOFT_365_MIXTA", assignmentType: "mixta", removable: true }
    ]
  );
});

test("consulta licencias por OID o correo al abrir la desactivacion", () => {
  assert.match(routesSource, /\/admin\/usuarios\/:id\/licencias-actuales/);
  assert.match(frontSource, /async abrirConfirmacion\(usuario\)/);
  assert.match(frontSource, /\/licencias-actuales/);
  assert.match(frontSource, /puedeConsultarEntra: !!\(usuario\.azure_oid \|\| usuario\.email\)/);
  assert.match(frontSource, /if \(!usuario\.activo \|\| !this\.modal\.puedeConsultarEntra\) return/);
});
