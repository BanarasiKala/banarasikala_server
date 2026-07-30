const express = require("express");
const multer = require("multer");
const router = express.Router();
const CustomerController = require("../controllers/CustomerController");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");

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

// ── Admin: User Directory ──
// Under /admin so these can never be confused with the customer's own /me routes above.
// 'verified/bulk' is declared before 'verified/:id' — Express matches in declaration order.
router.get("/admin/list", authMiddleware, adminMiddleware, CustomerController.adminList);
router.put("/admin/verified/bulk", authMiddleware, adminMiddleware, CustomerController.setVerifiedBulk);
router.put("/admin/verified/:id", authMiddleware, adminMiddleware, CustomerController.setVerified);

module.exports = router;
