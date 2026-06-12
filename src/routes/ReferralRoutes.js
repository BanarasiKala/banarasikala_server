const express = require("express");
const router = express.Router();
const ReferralController = require("../controllers/ReferralController");
const { authMiddleware } = require("../middleware/authMiddleware");

router.get("/me", authMiddleware, ReferralController.me);
router.post("/apply", authMiddleware, ReferralController.apply);

module.exports = router;

