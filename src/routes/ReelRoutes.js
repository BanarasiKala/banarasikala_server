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
// Comments publish on write, so there is no approve step — this is the record, and
// delete is the moderation tool. Deleting a thread root removes its replies too.
router.get("/admin/comments", authMiddleware, adminMiddleware, ReelController.listComments);
router.delete("/admin/comments/:commentId", authMiddleware, adminMiddleware, ReelController.deleteComment);
router.post("/", authMiddleware, adminMiddleware, ReelController.create);
router.put("/:id", authMiddleware, adminMiddleware, ReelController.update);
router.delete("/:id", authMiddleware, adminMiddleware, ReelController.remove);

// ─── Customer (login required) ───────────────────────────────────────────────
// Two segments, so it cannot be swallowed by the one-segment DELETE /:id above; the
// service checks the comment is the caller's own before removing it.
router.delete("/comments/:commentId", authMiddleware, ReelController.deleteOwnComment);
router.post("/:id/like", authMiddleware, ReelController.toggleLike);
router.post("/:id/comments", authMiddleware, ReelController.addComment);

// ─── Public (no login; optional auth so we know if the viewer liked it) ──────
router.get("/", optionalAuthMiddleware, ReelController.list);
router.get("/product/:productId", ReelController.getForProduct);
router.get("/:id", optionalAuthMiddleware, ReelController.getOne);
router.get("/:id/comments", ReelController.getComments);
router.post("/:id/view", ReelController.view);

module.exports = router;
