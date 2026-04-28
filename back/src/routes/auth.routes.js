const express = require("express");
const router = express.Router();

const {
  registerUser,
  loginUser,
  getCurrentUser,
  getUserPhoto,
  loginWithMicrosoft
} = require("../services/auth.service");

router.post("/register", registerUser);
router.post("/login", loginUser);
router.get("/me", getCurrentUser);
router.get("/photo", getUserPhoto);
router.post("/microsoft", loginWithMicrosoft);

module.exports = router;
