const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const {
  listUsuariosRoles,
  listUsuariosLicencias,
  patchUsuarioLicenciaEstado,
  actualizarRolUsuario
} = require("../services/usuarios.service");

router.get("/admin/usuarios-roles", requireAccess({ roles: ["Administrador"] }), listUsuariosRoles);
router.get("/admin/usuarios-licencias", requireAccess({ roles: ["Administrador"] }), listUsuariosLicencias);
router.patch("/admin/usuarios-licencias/:public_id/estado", requireAccess({ roles: ["Administrador"] }), patchUsuarioLicenciaEstado);
router.put("/admin/usuarios/:id/rol", requireAccess({ roles: ["Administrador"] }), actualizarRolUsuario);

module.exports = router;
