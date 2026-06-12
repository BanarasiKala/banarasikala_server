const express = require("express");
const router = express.Router();
const WalletController = require("../controllers/WalletController");
const { authMiddleware } = require("../middleware/authMiddleware");

router.get("/", authMiddleware, WalletController.getWallet);

module.exports = router;

