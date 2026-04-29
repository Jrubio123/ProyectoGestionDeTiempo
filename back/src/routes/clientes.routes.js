const express = require("express");
const router = express.Router();
const { requireAccess } = require("../middlewares/access");
const { listClientes, createCliente, updateCliente, deleteCliente } = require("../services/clientes.service");

router.get("/", requireAccess({ roles: ["Administrador", "Coordinador", "Comercial", "Talento Humano"] }), listClientes);
router.post("/", requireAccess({ roles: ["Administrador"] }), createCliente);
router.put("/:id", requireAccess({ roles: ["Administrador"] }), updateCliente);
router.delete("/:id", requireAccess({ roles: ["Administrador"] }), deleteCliente);

module.exports = router;
