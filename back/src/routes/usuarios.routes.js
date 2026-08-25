const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const {
  listUsuariosRoles,
  listUsuariosLicencias,
  getUsuarioLicenciasActuales,
  patchUsuarioLicenciaEstado,
  actualizarRolUsuario,
  actualizarUsuarioActivo,
  asignarLicenciaUsuario,
  getLicenciasHistorial
} = require("../services/usuarios.service");

router.get("/admin/usuarios-roles", requireAccess({ roles: ["Administrador"] }), listUsuariosRoles);
router.get("/admin/usuarios-licencias", requireAccess({ roles: ["Administrador"] }), listUsuariosLicencias);
router.patch("/admin/usuarios-licencias/:public_id/estado", requireAccess({ roles: ["Administrador"] }), patchUsuarioLicenciaEstado);
router.put("/admin/usuarios/:id/rol", requireAccess({ roles: ["Administrador"] }), actualizarRolUsuario);
router.get("/admin/usuarios/:id/licencias-actuales", requireAccess({ roles: ["Administrador"] }), getUsuarioLicenciasActuales);
router.put("/admin/usuarios/:id/activo", requireAccess({ roles: ["Administrador"] }), actualizarUsuarioActivo);
router.post("/admin/usuarios/:id/licencia", requireAccess({ roles: ["Administrador"] }), asignarLicenciaUsuario);
router.get("/admin/usuarios/:id/licencias-historial", requireAccess({ roles: ["Administrador"] }), getLicenciasHistorial);

module.exports = router;
