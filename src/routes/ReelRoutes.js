const express = require("express");
const router = express.Router();
const ReelController = require("../controllers/ReelController");
const {
  authMiddleware,
  optionalAuthMiddleware,
  adminMiddleware,
} = require("../middleware/authMiddleware");

// ─── Admin (static paths first so they don't collide with /:id) ──────────────
router.get("/admin/all", authMiddleware, adminMiddleware, ReelController.adminList);
router.get("/admin/upload-url", authMiddleware, adminMiddleware, ReelController.getUploadUrl);
router.get("/admin/comments/pending", authMiddleware, adminMiddleware, ReelController.pendingComments);
router.put("/admin/comments/:commentId/approve", authMiddleware, adminMiddleware, ReelController.approveComment);
router.delete("/admin/comments/:commentId", authMiddleware, adminMiddleware, ReelController.deleteComment);
router.post("/", authMiddleware, adminMiddleware, ReelController.create);
router.put("/:id", authMiddleware, adminMiddleware, ReelController.update);
router.delete("/:id", authMiddleware, adminMiddleware, ReelController.remove);

// ─── Customer (login required) ───────────────────────────────────────────────
router.post("/:id/like", authMiddleware, ReelController.toggleLike);
router.post("/:id/comments", authMiddleware, ReelController.addComment);

// ─── Public (no login; optional auth so we know if the viewer liked it) ──────
router.get("/", optionalAuthMiddleware, ReelController.list);
router.get("/product/:productId", ReelController.getForProduct);
router.get("/:id", optionalAuthMiddleware, ReelController.getOne);
router.get("/:id/comments", ReelController.getComments);
router.post("/:id/view", ReelController.view);

module.exports = router;
