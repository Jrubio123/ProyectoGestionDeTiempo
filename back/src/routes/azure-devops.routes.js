const express = require("express");
const { requireAccess } = require("../middlewares/access");
const {
  getProjects,
  getRecentWorkItems
} = require("../services/azure-devops.service");

const router = express.Router();
const ADMIN_ACCESS = requireAccess({ roles: ["Administrador"] });

router.get("/projects", ADMIN_ACCESS, getProjects);
router.get("/work-items", ADMIN_ACCESS, getRecentWorkItems);

module.exports = router;
