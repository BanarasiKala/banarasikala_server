const express = require("express");
const multer = require("multer");
const router = express.Router();
const CustomerController = require("../controllers/CustomerController");
const { authMiddleware } = require("../middleware/authMiddleware");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

router.get("/me", authMiddleware, CustomerController.me);
router.put("/me", authMiddleware, CustomerController.updateMe);
router.post(
  "/me/avatar",
  authMiddleware,
  upload.single("avatar"),
  CustomerController.uploadAvatar,
);

module.exports = router;
