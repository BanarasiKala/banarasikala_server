const ReelService = require("../services/ReelService");
const { generateS3PresignedUploadUrl } = require("../config/s3");

const toInt = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const logError = (label, error) => {
  console.error(`[ReelController] ${label}:`, error?.message || error);
};

const ReelController = {
  // ─── Public ──────────────────────────────────────────────────────────────
  async list(req, res) {
    try {
      const limit = Math.min(Math.max(toInt(req.query.limit, 20), 1), 50);
      const offset = Math.max(toInt(req.query.offset, 0), 0);
      const customerId = req.userRole === "customer" ? req.user?.id : null;
      const result = await ReelService.listPublishedReels({ customerId, limit, offset });
      res.json(result);
    } catch (error) {
      logError("list", error);
      res.status(500).json({ message: "Could not load reels." });
    }
  },

  async getOne(req, res) {
    try {
      const customerId = req.userRole === "customer" ? req.user?.id : null;
      const reel = await ReelService.getReelById(req.params.id, { customerId });
      if (!reel) return res.status(404).json({ message: "Reel not found." });
      res.json(reel);
    } catch (error) {
      logError("getOne", error);
      res.status(500).json({ message: "Could not load reel." });
    }
  },

  async getComments(req, res) {
    try {
      const comments = await ReelService.listApprovedComments(req.params.id);
      res.json({ comments });
    } catch (error) {
      logError("getComments", error);
      res.status(500).json({ message: "Could not load comments." });
    }
  },

  async view(req, res) {
    try {
      await ReelService.incrementView(req.params.id);
      res.status(204).send();
    } catch (error) {
      logError("view", error);
      res.status(204).send(); // view counting must never block playback
    }
  },

  // ─── Customer (auth required) ──────────────────────────────────────────────
  async toggleLike(req, res) {
    try {
      const result = await ReelService.toggleLike(req.params.id, req.user.id);
      res.json(result);
    } catch (error) {
      logError("toggleLike", error);
      res.status(400).json({ message: error.message || "Could not update like." });
    }
  },

  async addComment(req, res) {
    try {
      const result = await ReelService.addComment(req.params.id, req.user.id, req.body.comment);
      res.status(201).json({
        ...result,
        message: "Comment submitted and awaiting approval.",
      });
    } catch (error) {
      logError("addComment", error);
      res.status(400).json({ message: error.message || "Could not submit comment." });
    }
  },

  // ─── Admin ─────────────────────────────────────────────────────────────────
  async adminList(req, res) {
    try {
      const reels = await ReelService.listAllReels();
      res.json({ reels });
    } catch (error) {
      logError("adminList", error);
      res.status(500).json({ message: "Could not load reels." });
    }
  },

  async getUploadUrl(req, res) {
    try {
      const { fileName = "reel.mp4", contentType = "video/mp4" } = req.query;
      const result = await generateS3PresignedUploadUrl(fileName, contentType, "reels");
      res.json(result);
    } catch (error) {
      logError("getUploadUrl", error);
      res.status(500).json({ message: error.message || "Failed to generate upload URL." });
    }
  },

  async create(req, res) {
    try {
      const reel = await ReelService.createReel(req.body);
      res.status(201).json(reel);
    } catch (error) {
      logError("create", error);
      res.status(400).json({ message: error.message || "Could not create reel." });
    }
  },

  async update(req, res) {
    try {
      const reel = await ReelService.updateReel(req.params.id, req.body);
      res.json(reel);
    } catch (error) {
      logError("update", error);
      res.status(400).json({ message: error.message || "Could not update reel." });
    }
  },

  async remove(req, res) {
    try {
      await ReelService.deleteReel(req.params.id);
      res.status(204).send();
    } catch (error) {
      logError("remove", error);
      res.status(400).json({ message: error.message || "Could not delete reel." });
    }
  },

  async pendingComments(req, res) {
    try {
      const comments = await ReelService.listPendingComments();
      res.json({ comments });
    } catch (error) {
      logError("pendingComments", error);
      res.status(500).json({ message: "Could not load pending comments." });
    }
  },

  async approveComment(req, res) {
    try {
      const result = await ReelService.approveComment(req.params.commentId);
      res.json(result);
    } catch (error) {
      logError("approveComment", error);
      res.status(400).json({ message: error.message || "Could not approve comment." });
    }
  },

  async deleteComment(req, res) {
    try {
      await ReelService.deleteComment(req.params.commentId);
      res.status(204).send();
    } catch (error) {
      logError("deleteComment", error);
      res.status(400).json({ message: error.message || "Could not delete comment." });
    }
  },
};

module.exports = ReelController;
