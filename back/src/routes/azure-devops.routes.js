const express = require("express");
const { requireAccess } = require("../middlewares/access");
const {
  getProjects,
  getRecentWorkItems
} = require("../services/azure-devops.service");

const router = express.Router();
const OPERATION_ACCESS = requireAccess({ roles: ["Administrador", "Coordinador"] });

router.get("/projects", OPERATION_ACCESS, getProjects);
router.get("/work-items", OPERATION_ACCESS, getRecentWorkItems);

module.exports = router;
